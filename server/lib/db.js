/**
 * Local store — SQLite via node:sqlite.
 *
 * Electron 42 bundles Node 24, whose built-in node:sqlite gives us SQLite with
 * NO native module and therefore no electron-rebuild step (the server runs on
 * Electron's ABI, so better-sqlite3 would need rebuilding against it).
 *
 * Everything lives in one file at ~/.codeck/codeck.db. Nothing leaves the box.
 */
import { DatabaseSync } from 'node:sqlite'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'

const SCHEMA_VERSION = 1
let _db = null

export function getDb(dataDir) {
  if (_db) return _db
  const dir = dataDir || process.env.DATA_DIR || path.join(process.env.HOME, '.codeck')
  fs.mkdirSync(dir, { recursive: true })
  _db = new DatabaseSync(path.join(dir, 'codeck.db'))
  _db.exec('PRAGMA journal_mode = WAL')
  _db.exec('PRAGMA foreign_keys = ON')
  migrate(_db, dir)
  return _db
}

export const uid = () => crypto.randomUUID()
const now = () => new Date().toISOString()

function migrate(db, dir) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

    CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
      industry TEXT, domain TEXT, created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meetings (
      id TEXT PRIMARY KEY,
      client_id TEXT REFERENCES clients(id) ON DELETE SET NULL,
      title TEXT, date TEXT, transcript TEXT,
      word_count INTEGER DEFAULT 0, source TEXT,
      created_at TEXT NOT NULL
    );

    -- Every generation and every chat edit produces a new deck version, so the
    -- history is a full audit trail rather than a single mutable blob.
    CREATE TABLE IF NOT EXISTS decks (
      id TEXT PRIMARY KEY,
      meeting_id TEXT REFERENCES meetings(id) ON DELETE CASCADE,
      version INTEGER NOT NULL DEFAULT 1,
      deck_json TEXT NOT NULL,
      file_path TEXT, file_name TEXT, slide_count INTEGER,
      intent TEXT, anonymize INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );

    -- Op log: undo/redo for free, and "how did this slide get this way".
    CREATE TABLE IF NOT EXISTS deck_ops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      deck_id TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL, op_json TEXT NOT NULL,
      -- batch groups the ops from one prompt. It exists because grouping by the
      -- prompt TEXT meant the same instruction typed twice looked like a single
      -- batch, so undo reverted both.
      prompt TEXT, tier TEXT, batch TEXT, undone INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,   -- profile:caseStudy | profile:service | deck:slide | transcript | editPrompt
      source_id TEXT,
      text TEXT NOT NULL, meta_json TEXT,
      content_hash TEXT, created_at TEXT NOT NULL
    );

    -- Vectors as raw Float32 BLOBs. At this corpus size (hundreds of chunks,
    -- maybe thousands after years) brute-force cosine in JS is sub-millisecond,
    -- so a vector index (sqlite-vec/LanceDB) would be pure overhead.
    CREATE TABLE IF NOT EXISTS embeddings (
      chunk_id TEXT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
      model TEXT NOT NULL, dim INTEGER NOT NULL, vec BLOB NOT NULL
    );

    -- Durable, USER-EDITABLE facts per client. Auto-accumulated model memory
    -- compounds its own errors, so this is surfaced in the UI for correction.
    CREATE TABLE IF NOT EXISTS dossiers (
      client_id TEXT PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
      facts_json TEXT NOT NULL, updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS style_prefs (
      key TEXT PRIMARY KEY, value TEXT NOT NULL,
      confidence REAL DEFAULT 0.5, updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_meetings_client ON meetings(client_id);
    CREATE INDEX IF NOT EXISTS idx_decks_meeting   ON decks(meeting_id);
    CREATE INDEX IF NOT EXISTS idx_ops_deck        ON deck_ops(deck_id, seq);
    CREATE INDEX IF NOT EXISTS idx_chunks_source   ON chunks(source_type, source_id);
  `)

  const ver = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')
  if (!ver) {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION))
  }

  // Existing op logs predate the batch column. Backfilling by prompt is exactly
  // as ambiguous as the old grouping was, but it only affects history already
  // written, and every new batch gets a real id.
  const opCols = db.prepare('PRAGMA table_info(deck_ops)').all().map(c => c.name)
  if (!opCols.includes('batch')) {
    db.exec('ALTER TABLE deck_ops ADD COLUMN batch TEXT')
    db.exec("UPDATE deck_ops SET batch = 'legacy:' || COALESCE(prompt, '') WHERE batch IS NULL")
    console.log('[db] added deck_ops.batch')
  }

  if (!db.prepare('SELECT value FROM meta WHERE key = ?').get('migrated_meetings_json')) {
    const n = importMeetingsJson(db, dir)
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
      .run('migrated_meetings_json', `${now()} (${n} meetings)`)
    if (n) console.log(`[db] migrated ${n} meetings from meetings.json`)
  }
}

/** One-time import of the legacy meetings.json. The file is left untouched. */
function importMeetingsJson(db, dir) {
  const f = path.join(dir, 'meetings.json')
  if (!fs.existsSync(f)) return 0
  let rows
  try { rows = JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return 0 }
  if (!Array.isArray(rows)) return 0

  let count = 0
  for (const m of rows) {
    const md = m.meetingData || {}
    const clientId = upsertClient(db, m.clientName || md.clientName, md.clientIndustry)
    const meetingId = m.id || uid()
    db.prepare(`INSERT OR IGNORE INTO meetings
      (id, client_id, title, date, transcript, word_count, source, created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      meetingId, clientId,
      m.meetingTitle || md.deckTitle || '', m.date || (md.meetingDate ?? ''),
      m.transcript || '', (m.transcript || '').trim().split(/\s+/).filter(Boolean).length,
      'legacy-json', m.createdAt || now()
    )
    // The legacy writer dropped the pptx reference (it read `fileName` while the
    // renderer sent `pptFile`), so accept whichever field is actually present.
    const fileName = m.pptFile || m.fileName || null
    db.prepare(`INSERT INTO decks
      (id, meeting_id, version, deck_json, file_path, file_name, slide_count, intent, anonymize, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      uid(), meetingId, 1, JSON.stringify(md),
      m.filePath || (fileName ? path.join(dir, 'output', fileName) : null),
      fileName, m.slideCount ?? null, null, 0, m.createdAt || now()
    )
    count++
  }
  return count
}

export function upsertClient(db, name, industry) {
  const clean = (name || '').trim()
  if (!clean) return null
  const found = db.prepare('SELECT id, industry FROM clients WHERE name = ?').get(clean)
  if (found) {
    if (industry && !found.industry) {
      db.prepare('UPDATE clients SET industry = ? WHERE id = ?').run(industry, found.id)
    }
    return found.id
  }
  const id = uid()
  db.prepare('INSERT INTO clients (id, name, industry, domain, created_at) VALUES (?,?,?,?,?)')
    .run(id, clean, industry || null, null, now())
  return id
}

/* ── Meetings + decks ──────────────────────────────────────────────────────── */

export function createMeeting(db, { clientName, clientIndustry, title, date, transcript, source }) {
  const clientId = upsertClient(db, clientName, clientIndustry)
  const id = uid()
  db.prepare(`INSERT INTO meetings
    (id, client_id, title, date, transcript, word_count, source, created_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(
    id, clientId, title || '', date || now().slice(0, 10), transcript || '',
    (transcript || '').trim().split(/\s+/).filter(Boolean).length, source || 'app', now()
  )
  return id
}

export function createDeckVersion(db, meetingId, deckJson, extra = {}) {
  const row = db.prepare('SELECT MAX(version) v FROM decks WHERE meeting_id = ?').get(meetingId)
  const version = (row?.v || 0) + 1
  const id = uid()
  db.prepare(`INSERT INTO decks
    (id, meeting_id, version, deck_json, file_path, file_name, slide_count, intent, anonymize, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    id, meetingId, version, JSON.stringify(deckJson),
    extra.filePath || null, extra.fileName || null, extra.slideCount ?? null,
    extra.intent || null, extra.anonymize ? 1 : 0, now()
  )
  return { id, version }
}

export function getDeck(db, deckId) {
  const d = db.prepare('SELECT * FROM decks WHERE id = ?').get(deckId)
  if (!d) return null
  return { ...d, deck: JSON.parse(d.deck_json) }
}

export function latestDeckForMeeting(db, meetingId) {
  const d = db.prepare('SELECT * FROM decks WHERE meeting_id = ? ORDER BY version DESC LIMIT 1').get(meetingId)
  return d ? { ...d, deck: JSON.parse(d.deck_json) } : null
}

export function updateDeckJson(db, deckId, deckJson, extra = {}) {
  db.prepare('UPDATE decks SET deck_json = ?, file_path = COALESCE(?, file_path), file_name = COALESCE(?, file_name), slide_count = COALESCE(?, slide_count) WHERE id = ?')
    .run(JSON.stringify(deckJson), extra.filePath ?? null, extra.fileName ?? null, extra.slideCount ?? null, deckId)
}

/* ── Op log ────────────────────────────────────────────────────────────────── */

export function appendOps(db, deckId, ops, { prompt, tier } = {}) {
  // A new edit invalidates anything waiting to be redone — the branch it would
  // have reapplied onto no longer exists. Standard undo-stack behaviour, and
  // without it redo could replay an op against a deck that has since moved on.
  db.prepare('DELETE FROM deck_ops WHERE deck_id = ? AND undone = 1').run(deckId)

  const row = db.prepare('SELECT MAX(seq) s FROM deck_ops WHERE deck_id = ?').get(deckId)
  let seq = (row?.s || 0)
  const batch = uid()
  const stmt = db.prepare(`INSERT INTO deck_ops (deck_id, seq, op_json, prompt, tier, batch, created_at) VALUES (?,?,?,?,?,?,?)`)
  for (const op of ops) stmt.run(deckId, ++seq, JSON.stringify(op), prompt || null, tier || null, batch, now())
  return seq
}

export function opHistory(db, deckId) {
  return db.prepare('SELECT * FROM deck_ops WHERE deck_id = ? ORDER BY seq ASC').all(deckId)
    .map(r => ({ ...r, op: JSON.parse(r.op_json) }))
}

/**
 * The newest not-yet-undone op batch, WITHOUT changing anything.
 * Callers apply the inverse first and only commit on success — marking an op
 * undone before the revert lands would record a change as reverted while the
 * deck still carries it.
 *
 * A batch is the group of ops that came from one prompt.
 */
export function peekLastBatch(db, deckId) {
  const last = db.prepare('SELECT batch FROM deck_ops WHERE deck_id = ? AND undone = 0 ORDER BY seq DESC LIMIT 1').get(deckId)
  if (!last) return []
  return db.prepare('SELECT * FROM deck_ops WHERE deck_id = ? AND undone = 0 AND batch IS ? ORDER BY seq ASC')
    .all(deckId, last.batch)
    .map(r => ({ ...r, op: JSON.parse(r.op_json) }))
}

/** Commits the undo recorded by peekLastBatch(). */
export function markLastBatchUndone(db, deckId) {
  const batch = peekLastBatch(db, deckId)
  if (!batch.length) return []
  db.prepare('UPDATE deck_ops SET undone = 1 WHERE deck_id = ? AND batch IS ?').run(deckId, batch[0].batch)
  return batch
}

/**
 * The batch a redo should reapply, WITHOUT changing anything.
 *
 * Undo always takes the newest live batch, so the undone rows are a suffix of
 * the log. The one to put back is therefore the EARLIEST undone batch — redo
 * walks back up the same stack undo walked down.
 */
export function peekRedoBatch(db, deckId) {
  const first = db.prepare('SELECT batch FROM deck_ops WHERE deck_id = ? AND undone = 1 ORDER BY seq ASC LIMIT 1').get(deckId)
  if (!first) return []
  return db.prepare('SELECT * FROM deck_ops WHERE deck_id = ? AND undone = 1 AND batch IS ? ORDER BY seq ASC')
    .all(deckId, first.batch)
    .map(r => ({ ...r, op: JSON.parse(r.op_json) }))
}

/** Commits the redo recorded by peekRedoBatch(). */
export function markBatchRedone(db, deckId) {
  const batch = peekRedoBatch(db, deckId)
  if (!batch.length) return []
  db.prepare('UPDATE deck_ops SET undone = 0 WHERE deck_id = ? AND batch IS ?').run(deckId, batch[0].batch)
  return batch
}

/* ── Dossiers + style prefs ────────────────────────────────────────────────── */

export function getDossier(db, clientId) {
  if (!clientId) return null
  const r = db.prepare('SELECT facts_json, updated_at FROM dossiers WHERE client_id = ?').get(clientId)
  return r ? { facts: JSON.parse(r.facts_json), updatedAt: r.updated_at } : null
}

export function saveDossier(db, clientId, facts) {
  db.prepare('INSERT INTO dossiers (client_id, facts_json, updated_at) VALUES (?,?,?) ON CONFLICT(client_id) DO UPDATE SET facts_json = excluded.facts_json, updated_at = excluded.updated_at')
    .run(clientId, JSON.stringify(facts), now())
}

export function getStylePrefs(db) {
  return db.prepare('SELECT key, value, confidence FROM style_prefs ORDER BY confidence DESC').all()
}

export function bumpStylePref(db, key, value) {
  const ex = db.prepare('SELECT confidence FROM style_prefs WHERE key = ?').get(key)
  const conf = Math.min(0.99, (ex?.confidence ?? 0.3) + 0.15)
  db.prepare('INSERT INTO style_prefs (key, value, confidence, updated_at) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, confidence = excluded.confidence, updated_at = excluded.updated_at')
    .run(key, value, conf, now())
}
