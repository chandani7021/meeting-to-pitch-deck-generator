/**
 * Studio API — generate, preview, chat-edit, export.
 *
 * The deck JSON is the single source of truth. Every mutation goes through the
 * op log, and the preview is always re-derived from the same layout pass that
 * writes the .pptx.
 */
import { Router } from 'express'
import fs from 'fs'
import path from 'path'
import { buildPresentation } from '../lib/builder.js'
import { loadProfile, orgConfigFrom } from '../lib/profile.js'
import { generateDeck } from '../lib/generate.js'
import { routeEdit } from '../lib/editRouter.js'
import { applyOps } from '../lib/ops.js'
import { updateDossierForClient } from '../lib/dossier.js'
import { chunkProfile, chunkDeck, chunkTranscript } from '../lib/chunker.js'
import { indexChunks, isEmbedReady } from '../lib/embeddings.js'
import multer from 'multer'
import { assetsDir, listImages, ensureAssets, saveImage, deleteImage } from '../lib/visuals.js'
import {
  getDb, createMeeting, createDeckVersion, getDeck, updateDeckJson,
  appendOps, opHistory, markLastBatchUndone, peekLastBatch, peekRedoBatch, markBatchRedone,
  getDossier, saveDossier, getStylePrefs,
} from '../lib/db.js'

const router = Router()

async function getProvider() {
  const name = process.env.AI_PROVIDER || 'local'
  return import(`../lib/providers/${name}.js`)
}

const specOf = async (deck, dataDir, profile) =>
  buildPresentation(deck, dataDir, orgConfigFrom(profile), { target: 'spec' })

/* ── Preview ───────────────────────────────────────────────────────────────── */

// POST /api/studio/preview  { deck } | { deckId }
router.post('/preview', async (req, res) => {
  try {
    const db = getDb(req.dataDir)
    const profile = loadProfile(req.dataDir)
    const deck = req.body.deck || getDeck(db, req.body.deckId)?.deck
    if (!deck) return res.status(400).json({ error: 'deck or deckId is required' })
    res.json({ spec: await specOf(deck, req.dataDir, profile) })
  } catch (err) {
    console.error('preview error:', err)
    res.status(500).json({ error: err.message })
  }
})

/* ── Generate (streamed) ───────────────────────────────────────────────────── */

/**
 * POST /api/studio/generate
 * Streams newline-delimited JSON so the preview fills in section by section.
 * On CPU-only inference a full deck takes minutes; watching it build beats a
 * spinner, and a mid-way failure still leaves the earlier sections on screen.
 */
router.post('/generate', async (req, res) => {
  const { transcript, clientName, clientIndustry, deckIntent, meetingTitle, anonymize } = req.body
  if (!transcript?.trim()) return res.status(400).json({ error: 'transcript is required' })
  const words = transcript.trim().split(/\s+/).filter(Boolean).length
  if (words < 30) return res.status(400).json({ error: `Transcript too short (${words} words). Record at least 30 words.` })

  res.setHeader('Content-Type', 'application/x-ndjson')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('X-Accel-Buffering', 'no')
  const send = obj => { res.write(JSON.stringify(obj) + '\n'); res.flush?.() }

  try {
    const db = getDb(req.dataDir)
    const profile = loadProfile(req.dataDir)
    const provider = await getProvider()

    const meetingId = createMeeting(db, {
      clientName, clientIndustry, title: meetingTitle, transcript, source: 'studio',
    })
    const clientRow = db.prepare('SELECT client_id FROM meetings WHERE id = ?').get(meetingId)
    const clientId = clientRow?.client_id || null
    send({ stage: 'meeting', meetingId, clientId })

    const { deck, stats } = await generateDeck(
      db, profile, provider,
      { transcript, clientName, clientIndustry, deckIntent, meetingTitle, anonymize, clientId },
      async ev => {
        // Push a fresh spec with each section so the preview grows live.
        if (ev.deck && (ev.stage === 'section:done' || ev.stage === 'deterministic')) {
          try { send({ ...ev, spec: await specOf(ev.deck, req.dataDir, profile) }) }
          catch { send(ev) }
        } else send(ev)
      }
    )

    const { id: deckId, version } = createDeckVersion(db, meetingId, deck, {
      intent: deckIntent, anonymize, slideCount: null,
    })
    const spec = await specOf(deck, req.dataDir, profile)
    send({ stage: 'saved', deckId, meetingId, version, deck, spec, stats })

    // Index + dossier run after the deck is delivered so they never delay it.
    try {
      if (await isEmbedReady()) {
        await indexChunks(db, [
          ...chunkDeck(deckId, deck, deck.clientName),
          ...chunkTranscript(meetingId, transcript, deck.clientName),
        ])
        send({ stage: 'indexed' })
      }
    } catch (err) { send({ stage: 'indexWarning', message: err.message }) }

    try {
      const dossier = await updateDossierForClient(db, provider, {
        clientId, meetingId, transcript, deck,
      })
      if (dossier) send({ stage: 'dossier', facts: dossier })
    } catch (err) { send({ stage: 'dossierWarning', message: err.message }) }

    send({ stage: 'complete', deckId })
    res.end()
  } catch (err) {
    console.error('generate error:', err)
    send({ stage: 'error', error: err.message })
    res.end()
  }
})

/* ── Chat edit ─────────────────────────────────────────────────────────────── */

// POST /api/studio/edit  { deckId, prompt, selection?, history?, attachment? }
router.post('/edit', async (req, res) => {
  const { deckId, prompt, selection = null, history = [], attachment = null } = req.body
  if (!deckId || !prompt?.trim()) return res.status(400).json({ error: 'deckId and prompt are required' })

  try {
    const db = getDb(req.dataDir)
    const profile = loadProfile(req.dataDir)
    const row = getDeck(db, deckId)
    if (!row) return res.status(404).json({ error: 'Deck not found' })

    // The rendered spec is what turns "slide 4" into a deck path: it is the only
    // thing that knows the order the user is actually looking at.
    const before = await specOf(row.deck, req.dataDir, profile)
    const result = await routeEdit(db, row.deck, await getProvider(), {
      prompt, selection, history, profile, spec: before, dataDir: req.dataDir, attachment,
    })

    // Render BEFORE committing. A model-proposed op can produce a deck the
    // builder cannot draw; rejecting the edit is far better than persisting a
    // deck whose preview 500s.
    let spec
    try {
      spec = await specOf(result.deck, req.dataDir, profile)
    } catch (err) {
      return res.json({
        deck: row.deck, spec: before, ops: [], applied: [], tier: result.tier,
        reply: `That change would have broken the deck layout (${err.message}) — nothing was applied. Try selecting a single bullet and rephrasing.`,
        error: err.message, slideDelta: 0,
      })
    }

    if (result.ops?.length) {
      updateDeckJson(db, deckId, result.deck)
      // Persist each op with the inverse computed at apply time, so undo is an
      // exact replay rather than a re-derivation. applyOps() returns inverses
      // already reversed (ready to apply in order), hence the index flip.
      const n = result.ops.length
      const annotated = result.ops.map((op, i) => ({ ...op, __inverse: result.inverse?.[n - 1 - i] ?? null }))
      appendOps(db, deckId, annotated, { prompt, tier: result.tier })
    }
    res.json({
      deck: result.deck, spec,
      reply: result.reply, tier: result.tier, ops: result.ops || [],
      applied: result.applied || [], rejected: result.rejected || [],
      regenerate: !!result.regenerate, error: result.error || null,
      timing: result.timing || null, contextReport: result.report || null,
      targets: result.targets || [],
      canUndo: peekLastBatch(db, deckId).length > 0,
      canRedo: peekRedoBatch(db, deckId).length > 0,
      slideDelta: spec.slides.length - before.slides.length,
    })
  } catch (err) {
    console.error('edit error:', err)
    res.status(500).json({ error: err.message })
  }
})

// POST /api/studio/undo  { deckId }
router.post('/undo', async (req, res) => {
  try {
    const db = getDb(req.dataDir)
    const profile = loadProfile(req.dataDir)
    const row = getDeck(db, req.body.deckId)
    if (!row) return res.status(404).json({ error: 'Deck not found' })

    // Peek at the batch WITHOUT marking it undone: if the inverse fails to
    // apply we must leave the log untouched, or the op is recorded as reverted
    // while the deck still carries it.
    const batch = peekLastBatch(db, req.body.deckId)
    if (!batch.length) {
      return res.json({
        deck: row.deck, spec: await specOf(row.deck, req.dataDir, profile),
        reply: 'Nothing left to undo.', undone: 0,
        canUndo: false, canRedo: peekRedoBatch(db, req.body.deckId).length > 0,
      })
    }

    // Inverses were computed when the ops were applied; replay them backwards.
    const inverse = [...batch].reverse().map(b => b.op.__inverse).filter(Boolean)
    if (!inverse.length) {
      return res.status(409).json({ error: 'That change has no recorded inverse, so it cannot be undone automatically.' })
    }

    let deck
    try { deck = applyOps(row.deck, inverse).deck }
    catch (err) {
      return res.status(409).json({ error: `Could not undo: ${err.message}` })
    }

    markLastBatchUndone(db, req.body.deckId)
    updateDeckJson(db, req.body.deckId, deck)
    res.json({
      deck, spec: await specOf(deck, req.dataDir, profile),
      reply: `Undid ${batch.length} change${batch.length > 1 ? 's' : ''}.`, undone: batch.length,
      canUndo: peekLastBatch(db, req.body.deckId).length > 0,
      canRedo: peekRedoBatch(db, req.body.deckId).length > 0,
    })
  } catch (err) {
    console.error('undo error:', err)
    res.status(500).json({ error: err.message })
  }
})

// POST /api/studio/redo  { deckId }
router.post('/redo', async (req, res) => {
  try {
    const db = getDb(req.dataDir)
    const profile = loadProfile(req.dataDir)
    const row = getDeck(db, req.body.deckId)
    if (!row) return res.status(404).json({ error: 'Deck not found' })

    // Same discipline as undo: look without committing, because a redo that
    // cannot apply must leave the log alone rather than claim it was reapplied.
    const batch = peekRedoBatch(db, req.body.deckId)
    if (!batch.length) {
      return res.json({
        deck: row.deck, spec: await specOf(row.deck, req.dataDir, profile),
        reply: 'Nothing to redo.', redone: 0,
        canUndo: peekLastBatch(db, req.body.deckId).length > 0, canRedo: false,
      })
    }

    // The original ops, forwards — the inverse of the inverse, without having to
    // compute one. __inverse is stripped: it described the deck as it was then.
    const forward = batch.map(b => { const { __inverse, ...op } = b.op; return op })

    let deck
    try { deck = applyOps(row.deck, forward).deck }
    catch (err) { return res.status(409).json({ error: `Could not redo: ${err.message}` }) }

    // A redone op must be re-drawable, or the preview 500s on the next paint.
    let spec
    try { spec = await specOf(deck, req.dataDir, profile) }
    catch (err) { return res.status(409).json({ error: `Redoing that would break the deck layout: ${err.message}` }) }

    markBatchRedone(db, req.body.deckId)
    updateDeckJson(db, req.body.deckId, deck)
    res.json({
      deck, spec, reply: `Redid ${batch.length} change${batch.length > 1 ? 's' : ''}.`, redone: batch.length,
      canUndo: peekLastBatch(db, req.body.deckId).length > 0,
      canRedo: peekRedoBatch(db, req.body.deckId).length > 0,
    })
  } catch (err) {
    console.error('redo error:', err)
    res.status(500).json({ error: err.message })
  }
})

/* ── Export ────────────────────────────────────────────────────────────────── */

// POST /api/studio/export  { deckId }
router.post('/export', async (req, res) => {
  try {
    const db = getDb(req.dataDir)
    const profile = loadProfile(req.dataDir)
    const row = getDeck(db, req.body.deckId)
    if (!row) return res.status(404).json({ error: 'Deck not found' })

    const out = await buildPresentation(row.deck, req.dataDir, orgConfigFrom(profile), { target: 'pptx' })
    updateDeckJson(db, req.body.deckId, row.deck, out)
    res.json(out)
  } catch (err) {
    console.error('export error:', err)
    res.status(500).json({ error: err.message })
  }
})

/* ── Image library ─────────────────────────────────────────────────────────── */

// Held in memory, not spooled to /tmp: the file is validated and written
// straight into the library, so a rejected upload leaves nothing behind.
const uploadImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 1 },
})

/**
 * POST /api/studio/image — put an image into the library and return its name.
 * The chat uploads here first, then sends the name along with the prompt, so
 * "add this image to slide 4" has something concrete to point at.
 */
router.post('/image', uploadImage.single('image'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image was attached.' })
    const saved = saveImage(req.dataDir, req.file.buffer, req.file.originalname, req.body.hint || '')
    res.json({ file: saved.file, url: `/api/studio/asset/${encodeURIComponent(saved.file)}`, tags: saved.tags })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// DELETE /api/studio/image/:file — remove one image from the library
router.delete('/image/:file', (req, res) => {
  try { deleteImage(req.dataDir, req.params.file); res.json({ ok: true }) }
  catch (err) { res.status(400).json({ error: err.message }) }
})

/**
 * Serves one image from the user's library so the preview can show it.
 * The renderer is network-jailed to this origin, so this is the only way an
 * on-disk image reaches the preview — and the .pptx reads the same file
 * directly, so the two always show the same picture.
 */
router.get('/asset/:file', (req, res) => {
  const dir = assetsDir(req.dataDir)
  // resolve() collapses any ../ before the prefix check, so a crafted filename
  // cannot walk out of the library directory.
  const full = path.resolve(dir, req.params.file)
  if (!full.startsWith(path.resolve(dir) + path.sep)) return res.status(400).end()
  if (!fs.existsSync(full)) return res.status(404).end()
  res.sendFile(full)
})

// GET /api/studio/assets — what the deck can actually draw on
router.get('/assets', (req, res) => {
  ensureAssets(req.dataDir)
  res.json({
    dir: assetsDir(req.dataDir),
    images: listImages(req.dataDir).map(i => ({ file: i.file, terms: [...i.terms] })),
  })
})

/* ── Deck + history ────────────────────────────────────────────────────────── */

router.get('/deck/:id', async (req, res) => {
  try {
    const db = getDb(req.dataDir)
    const row = getDeck(db, req.params.id)
    if (!row) return res.status(404).json({ error: 'Deck not found' })
    const profile = loadProfile(req.dataDir)
    res.json({
      deckId: row.id, meetingId: row.meeting_id, version: row.version,
      deck: row.deck, fileName: row.file_name,
      spec: await specOf(row.deck, req.dataDir, profile),
      ops: opHistory(db, row.id).map(o => ({ seq: o.seq, op: o.op, prompt: o.prompt, tier: o.tier, undone: !!o.undone })),
      canUndo: peekLastBatch(db, row.id).length > 0,
      canRedo: peekRedoBatch(db, row.id).length > 0,
    })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

/* ── Dossier (user-editable) ───────────────────────────────────────────────── */

router.get('/dossier/:clientId', (req, res) => {
  const db = getDb(req.dataDir)
  res.json(getDossier(db, req.params.clientId) || { facts: {}, updatedAt: null })
})

router.put('/dossier/:clientId', (req, res) => {
  const db = getDb(req.dataDir)
  saveDossier(db, req.params.clientId, req.body.facts || {})
  res.json({ ok: true })
})

/* ── Index + status ────────────────────────────────────────────────────────── */

// POST /api/studio/reindex — (re)embed the profile and every stored deck
router.post('/reindex', async (req, res) => {
  try {
    const db = getDb(req.dataDir)
    const profile = loadProfile(req.dataDir)
    if (!await isEmbedReady()) {
      return res.status(503).json({ error: 'Embedding model not available. Run: ollama pull nomic-embed-text' })
    }
    const chunks = [...chunkProfile(profile)]
    for (const d of db.prepare('SELECT id, meeting_id, deck_json FROM decks').all()) {
      const deck = JSON.parse(d.deck_json)
      chunks.push(...chunkDeck(d.id, deck, deck.clientName))
    }
    for (const m of db.prepare('SELECT id, transcript FROM meetings WHERE transcript IS NOT NULL').all()) {
      chunks.push(...chunkTranscript(m.id, m.transcript, null))
    }
    res.json(await indexChunks(db, chunks))
  } catch (err) {
    console.error('reindex error:', err)
    res.status(500).json({ error: err.message })
  }
})

router.get('/status', async (req, res) => {
  const db = getDb(req.dataDir)
  const provider = await getProvider()
  let transcription = null
  try { transcription = await (await import('../lib/transcribe.js')).health() } catch {}
  const counts = {
    clients: db.prepare('SELECT COUNT(*) c FROM clients').get().c,
    meetings: db.prepare('SELECT COUNT(*) c FROM meetings').get().c,
    decks: db.prepare('SELECT COUNT(*) c FROM decks').get().c,
    chunks: db.prepare('SELECT COUNT(*) c FROM chunks').get().c,
    embeddings: db.prepare('SELECT COUNT(*) c FROM embeddings').get().c,
  }
  res.json({
    provider: provider.providerInfo,
    offline: process.env.OFFLINE_MODE !== '0',
    inference: provider.health ? await provider.health() : { up: true, note: 'cloud provider' },
    embedReady: await isEmbedReady(),
    transcription,
    counts,
    stylePrefs: getStylePrefs(db),
    timings: (provider.lastTimings || []).slice(-10),
  })
})

export default router
