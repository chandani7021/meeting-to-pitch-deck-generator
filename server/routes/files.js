/**
 * Meetings + template API, backed by SQLite.
 *
 * The response shape stays compatible with the existing renderer, including the
 * `pptFile` field it reads. The old JSON writer destructured `fileName` while
 * the renderer sent `pptFile`, so the deck reference was silently dropped and
 * History never showed a download button — both names are accepted now and
 * both are returned.
 */
import { Router } from 'express'
import path from 'path'
import fs from 'fs'
import multer from 'multer'
import {
  getDb, createMeeting, createDeckVersion, latestDeckForMeeting, uid,
} from '../lib/db.js'

const router = Router()

/** DB rows -> the shape the renderer already consumes. */
function toApiMeeting(db, row) {
  const deck = latestDeckForMeeting(db, row.id)
  const client = row.client_id
    ? db.prepare('SELECT name, industry FROM clients WHERE id = ?').get(row.client_id)
    : null
  return {
    id: row.id,
    clientId: row.client_id,
    clientName: client?.name || deck?.deck?.clientName || 'Unknown',
    meetingTitle: row.title || deck?.deck?.deckTitle || '',
    date: row.date,
    duration: Math.round((row.word_count || 0) / 130),
    transcript: row.transcript,
    meetingData: deck?.deck || null,
    deckId: deck?.id || null,
    deckVersion: deck?.version || null,
    pptFile: deck?.file_name || null,   // what the renderer reads
    fileName: deck?.file_name || null,  // alias, for callers using the old name
    filePath: deck?.file_path || null,
    slideCount: deck?.slide_count ?? null,
    createdAt: row.created_at,
  }
}

// GET /api/meetings
router.get('/meetings', (req, res) => {
  const db = getDb(req.dataDir)
  const rows = db.prepare('SELECT * FROM meetings ORDER BY COALESCE(date, created_at) DESC, created_at DESC').all()
  res.json(rows.map(r => toApiMeeting(db, r)))
})

// POST /api/meetings
router.post('/meetings', (req, res) => {
  const db = getDb(req.dataDir)
  const { transcript, clientName, meetingData, filePath, fileName, pptFile, slideCount, meetingTitle, date } = req.body

  const md = meetingData || {}
  const id = createMeeting(db, {
    clientName: clientName || md.clientName,
    clientIndustry: md.clientIndustry,
    title: meetingTitle || md.deckTitle || '',
    date: (date || md.meetingDate || new Date().toISOString()).slice(0, 10),
    transcript, source: 'app',
  })

  const name = pptFile || fileName || null
  createDeckVersion(db, id, md, {
    fileName: name,
    filePath: filePath || (name ? path.join(req.dataDir, 'output', name) : null),
    slideCount: slideCount ?? null,
  })

  const row = db.prepare('SELECT * FROM meetings WHERE id = ?').get(id)
  res.json(toApiMeeting(db, row))
})

// PATCH /api/meetings/:id
router.patch('/meetings/:id', (req, res) => {
  const db = getDb(req.dataDir)
  const row = db.prepare('SELECT * FROM meetings WHERE id = ?').get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Meeting not found' })

  if (req.body.meetingTitle !== undefined) {
    db.prepare('UPDATE meetings SET title = ? WHERE id = ?').run(req.body.meetingTitle, req.params.id)
  }
  if (req.body.clientName !== undefined) {
    const name = String(req.body.clientName).trim()
    if (name) {
      const existing = db.prepare('SELECT id FROM clients WHERE name = ?').get(name)
      const clientId = existing?.id || (() => {
        const cid = uid()
        db.prepare('INSERT INTO clients (id, name, industry, domain, created_at) VALUES (?,?,?,?,?)')
          .run(cid, name, null, null, new Date().toISOString())
        return cid
      })()
      db.prepare('UPDATE meetings SET client_id = ? WHERE id = ?').run(clientId, req.params.id)
    }
  }
  res.json(toApiMeeting(db, db.prepare('SELECT * FROM meetings WHERE id = ?').get(req.params.id)))
})

// DELETE /api/meetings/:id
router.delete('/meetings/:id', (req, res) => {
  const db = getDb(req.dataDir)
  const row = db.prepare('SELECT id FROM meetings WHERE id = ?').get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Meeting not found' })

  // Remove generated files for every version of this meeting's deck.
  for (const d of db.prepare('SELECT file_path FROM decks WHERE meeting_id = ?').all(req.params.id)) {
    if (d.file_path && fs.existsSync(d.file_path)) { try { fs.unlinkSync(d.file_path) } catch {} }
  }
  db.prepare('DELETE FROM meetings WHERE id = ?').run(req.params.id)   // decks/ops cascade
  res.json({ success: true })
})

// GET /api/meetings/download/:fileName
router.get('/meetings/download/:fileName', (req, res) => {
  const fileName = path.basename(req.params.fileName)
  const filePath = path.join(req.dataDir, 'output', fileName)
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' })

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation')
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`)
  fs.createReadStream(filePath).pipe(res)
})

// POST /api/template
const upload = multer({ dest: '/tmp/codeck-uploads/' })
router.post('/template', upload.single('template'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
  if (!req.file.originalname.endsWith('.pptx')) {
    fs.unlinkSync(req.file.path)
    return res.status(400).json({ error: 'File must be a .pptx file' })
  }
  const dest = path.join(req.dataDir, 'template.pptx')
  fs.renameSync(req.file.path, dest)
  res.json({ success: true, path: dest })
})

export default router
