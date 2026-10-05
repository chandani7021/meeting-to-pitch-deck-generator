/**
 * Local embeddings + retrieval.
 *
 * Vectors come from Ollama on 127.0.0.1 and are stored as Float32 BLOBs in
 * SQLite. Search is brute-force cosine in JS — deliberately. The corpus is
 * ~40 profile chunks plus ~10 per meeting, so a few hundred now and maybe a
 * few thousand after years of use. Cosine over 5k × 768 floats is single-digit
 * milliseconds, so sqlite-vec / LanceDB / Chroma would add a dependency (and,
 * for Chroma, a Python daemon) to solve a problem this app will never have.
 * Revisit past ~50k chunks.
 */
import crypto from 'crypto'
import { uid } from './db.js'

const OLLAMA = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434'
export const EMBED_MODEL = process.env.EMBED_MODEL || 'nomic-embed-text'

export const hashText = t => crypto.createHash('sha256').update(t).digest('hex').slice(0, 16)

/** Embeds a batch of strings. Ollama's /api/embed takes an array. */
export async function embed(texts, { model = EMBED_MODEL, timeoutMs = 120000 } = {}) {
  if (!texts.length) return []
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(`${OLLAMA}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: texts }),
      signal: ctl.signal,
    })
    if (!res.ok) throw new Error(`Ollama embed failed (${res.status}): ${await res.text()}`)
    const data = await res.json()
    const vecs = data.embeddings || (data.embedding ? [data.embedding] : [])
    if (vecs.length !== texts.length) throw new Error(`embed returned ${vecs.length} vectors for ${texts.length} inputs`)
    return vecs
  } finally { clearTimeout(timer) }
}

const toBlob = vec => Buffer.from(new Float32Array(vec).buffer)
const fromBlob = buf => new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0
}

/**
 * Inserts chunks and embeds any whose text changed. Content-hashed, so
 * re-indexing an unchanged profile costs zero model calls.
 */
export async function indexChunks(db, chunks, { model = EMBED_MODEL } = {}) {
  if (!chunks.length) return { inserted: 0, embedded: 0, skipped: 0 }
  const insChunk = db.prepare(`INSERT INTO chunks (id, source_type, source_id, text, meta_json, content_hash, created_at)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET text=excluded.text, meta_json=excluded.meta_json, content_hash=excluded.content_hash`)
  const insEmb = db.prepare('INSERT INTO embeddings (chunk_id, model, dim, vec) VALUES (?,?,?,?) ON CONFLICT(chunk_id) DO UPDATE SET model=excluded.model, dim=excluded.dim, vec=excluded.vec')
  const getHash = db.prepare('SELECT c.content_hash h FROM chunks c JOIN embeddings e ON e.chunk_id = c.id WHERE c.id = ? AND e.model = ?')

  const stale = []
  for (const c of chunks) {
    const hash = hashText(c.text)
    c.id = c.id || uid()
    const existing = getHash.get(c.id, model)
    insChunk.run(c.id, c.sourceType, c.sourceId || null, c.text, JSON.stringify(c.meta || {}), hash, new Date().toISOString())
    if (existing?.h !== hash) stale.push(c)
  }

  let embedded = 0
  const BATCH = 32
  for (let i = 0; i < stale.length; i += BATCH) {
    const slice = stale.slice(i, i + BATCH)
    const vecs = await embed(slice.map(c => c.text), { model })
    slice.forEach((c, j) => { insEmb.run(c.id, model, vecs[j].length, toBlob(vecs[j])); embedded++ })
  }
  return { inserted: chunks.length, embedded, skipped: chunks.length - stale.length }
}

/**
 * Top-k nearest chunks to `query`. `filter` narrows by source_type prefix,
 * e.g. 'profile:caseStudy' or just 'profile'.
 */
export async function search(db, query, { k = 6, filter = null, model = EMBED_MODEL, minScore = 0.2 } = {}) {
  const rows = db.prepare(`SELECT c.id, c.source_type, c.source_id, c.text, c.meta_json, e.vec
    FROM chunks c JOIN embeddings e ON e.chunk_id = c.id
    WHERE e.model = ? ${filter ? "AND c.source_type LIKE ?" : ''}`)
    .all(...(filter ? [model, `${filter}%`] : [model]))
  if (!rows.length) return []

  const [qv] = await embed([query], { model })
  const q = new Float32Array(qv)
  return rows
    .map(r => ({
      id: r.id, sourceType: r.source_type, sourceId: r.source_id, text: r.text,
      meta: JSON.parse(r.meta_json || '{}'),
      score: cosine(q, fromBlob(r.vec)),
    }))
    .filter(r => r.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
}

export async function isEmbedReady() {
  try {
    const res = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(2500) })
    if (!res.ok) return false
    const { models = [] } = await res.json()
    return models.some(m => m.name?.startsWith(EMBED_MODEL))
  } catch { return false }
}
