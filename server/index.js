import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'
import aiRouter from './routes/ai.js'
import pptxRouter from './routes/pptx.js'
import filesRouter from './routes/files.js'
import transcribeRouter from './routes/transcribe.js'
import calendarRouter from './routes/calendar.js'
import studioRouter from './routes/studio.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PORT || 3001
const DATA_DIR = process.env.DATA_DIR || path.join(process.env.HOME, '.codeck')

// Ensure data directories exist
fs.mkdirSync(DATA_DIR, { recursive: true })
fs.mkdirSync(path.join(DATA_DIR, 'output'), { recursive: true })

// The image library, created up front with a README so it is discoverable
// before someone asks the chat for a picture and wonders where they go.
const { ensureAssets } = await import('./lib/visuals.js')
ensureAssets(DATA_DIR)

// Seed the Copods company profile (scraped from copods.co) on first run
const profileDest = path.join(DATA_DIR, 'copods-profile.json')
const profileSeed = path.join(__dirname, 'data', 'copods-profile.json')
if (!fs.existsSync(profileDest) && fs.existsSync(profileSeed)) {
  fs.copyFileSync(profileSeed, profileDest)
}

// Open the store at boot so the meetings.json migration happens once, at a
// predictable moment, rather than inside whichever request arrives first.
const { getDb } = await import('./lib/db.js')
getDb(DATA_DIR)

// ── Offline assertion (privacy layer 3 of 4) ────────────────────────────────
// Fail loudly at boot rather than leaking quietly at request time.
const OFFLINE = process.env.OFFLINE_MODE !== '0'
const CLOUD_KEYS = ['GROQ_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY']
if (OFFLINE) {
  const present = CLOUD_KEYS.filter(k => process.env[k]?.trim())
  if (present.length) {
    console.error(`\n[offline] Refusing to start: ${present.join(', ')} ${present.length > 1 ? 'are' : 'is'} set while OFFLINE_MODE is on.`)
    console.error('[offline] Remove or comment out the key(s) in server/.env, or set OFFLINE_MODE=0 to explicitly allow cloud calls.\n')
    process.exit(1)
  }
  const provider = process.env.AI_PROVIDER || 'local'
  if (provider !== 'local') {
    console.error(`\n[offline] Refusing to start: AI_PROVIDER="${provider}" sends data off this machine while OFFLINE_MODE is on.`)
    console.error('[offline] Set AI_PROVIDER=local, or OFFLINE_MODE=0 to allow it.\n')
    process.exit(1)
  }
  // AI_PROVIDER=local says WHICH client we use, not WHERE it points. Ollama's
  // host is a plain env var read straight by local.js and embeddings.js, so
  // OLLAMA_HOST=https://a-box-somewhere:11434 would ship every transcript and
  // every deck off this machine while all three checks above still passed and
  // this line printed "local-only mode". Wanting a remote Ollama is legitimate;
  // doing it by accident, under a banner claiming the opposite, is not.
  const host = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434'
  const LOOPBACK = /^(127\.\d+\.\d+\.\d+|localhost|\[::1\]|::1)$/i
  let hostname = ''
  try { hostname = new URL(host).hostname } catch {
    console.error(`\n[offline] Refusing to start: OLLAMA_HOST="${host}" is not a valid URL.\n`)
    process.exit(1)
  }
  if (!LOOPBACK.test(hostname)) {
    console.error(`\n[offline] Refusing to start: OLLAMA_HOST="${host}" is not on this machine.`)
    console.error('[offline] Transcripts and decks would be sent to that host for inference and embedding.')
    console.error('[offline] Set OFFLINE_MODE=0 to allow it deliberately, or point OLLAMA_HOST back at 127.0.0.1.\n')
    process.exit(1)
  }

  console.log('[offline] local-only mode — no cloud provider, no cloud keys, inference on 127.0.0.1')
}

const app = express()

app.use(cors({ origin: true }))  // allow Electron (file://) and dev server
app.use(express.json({ limit: '10mb' }))

// Request logger
app.use((req, _res, next) => {
  console.log(`${req.method} ${req.url}`)
  next()
})

// Attach data dir to all requests
app.use((req, _res, next) => {
  req.dataDir = DATA_DIR
  next()
})

app.use('/api', aiRouter)
app.use('/api', pptxRouter)
app.use('/api', filesRouter)
app.use('/api', transcribeRouter)
app.use('/api/studio', studioRouter)
app.use('/api/calendar', calendarRouter)

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }))
app.get('/api/config', (_req, res) => res.json({
  provider: process.env.AI_PROVIDER || 'local',
  offline: process.env.OFFLINE_MODE !== '0',
}))

app.listen(PORT, () => {
  console.log(`Codeck server running at http://localhost:${PORT}`)
  console.log(`Data directory: ${DATA_DIR}`)
})
