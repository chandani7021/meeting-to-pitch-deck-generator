/**
 * Codeck doctor — verifies every local dependency and prints what to do about
 * each failure. Run on a new machine before blaming the app.
 *
 *   npm run doctor
 */
import os from 'os'
import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
const exec = promisify(execFile)

const OLLAMA = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434'
const LLM = process.env.LOCAL_MODEL || 'qwen2.5:3b-instruct'
const EMBED = process.env.EMBED_MODEL || 'nomic-embed-text'
// Matches modelPath() in server/lib/transcribe.js: the quantised weights win
// when present, so the doctor must check the file that will actually be loaded.
const WHISPER = process.env.WHISPER_MODEL
  || (fs.existsSync(path.join(process.env.DATA_DIR || path.join(process.env.HOME, '.codeck'),
                              'models', 'ggml-small.en-q5_1.bin')) ? 'small.en-q5_1' : 'small.en')
const DATA_DIR = process.env.DATA_DIR || path.join(os.homedir(), '.codeck')

const results = []
const add = (ok, name, detail, fix) => results.push({ ok, name, detail, fix })

async function which(bin) {
  try { const { stdout } = await exec('/usr/bin/which', [bin]); return stdout.trim() || null }
  catch { return null }
}

// ── runtime ──────────────────────────────────────────────────────────────────
const nodeMajor = Number(process.versions.node.split('.')[0])
add(nodeMajor >= 22, 'Node runtime', `v${process.versions.node}${process.versions.electron ? ` (Electron ${process.versions.electron})` : ''}`,
  'The server must run on Electron\'s Node 24 — start it with `npm run dev`, never `node server/index.js`.')

try {
  const { DatabaseSync } = await import('node:sqlite')
  new DatabaseSync(':memory:').exec('SELECT 1')
  add(true, 'node:sqlite', 'available')
} catch (e) {
  add(false, 'node:sqlite', e.message, 'Run via `npm run dev` so the server uses Electron\'s Node 24.')
}

// ── hardware ─────────────────────────────────────────────────────────────────
const ram = Math.round(os.totalmem() / 1024 ** 3)
const arm = os.arch() === 'arm64'
add(ram >= 8, 'Memory', `${ram} GB, ${os.arch()}, ${os.cpus().length} cores`,
  'Under 8 GB the model will swap. Close other apps.')
if (!arm) {
  add(true, 'Note', 'Intel Mac — inference is CPU-only, expect minutes per deck', null)
} else if (ram >= 24) {
  add(true, 'Note', `Apple Silicon with ${ram} GB — a larger model would be much better`,
    `Try: ollama pull qwen2.5:14b-instruct  (then set LOCAL_MODEL)`)
}

// ── inference ────────────────────────────────────────────────────────────────
let tags = null
try {
  const res = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(3000) })
  tags = await res.json()
  add(true, 'Ollama', `running at ${OLLAMA}`)
} catch {
  add(false, 'Ollama', `not reachable at ${OLLAMA}`, 'Start it:  ollama serve   (or run scripts/codeck-setup.sh)')
}

if (tags) {
  const names = (tags.models || []).map(m => m.name)
  for (const [label, model] of [['Deck model', LLM], ['Embedding model', EMBED]]) {
    const found = names.some(n => n === model || n.startsWith(model.split(':')[0]))
    add(found, label, found ? model : `${model} not installed`, `ollama pull ${model}`)
  }

  // A real grammar-constrained call — the capability the whole design leans on.
  if (names.length) {
    try {
      const t0 = Date.now()
      const res = await fetch(`${OLLAMA}/api/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(180000),
        body: JSON.stringify({
          model: LLM, stream: false, keep_alive: '30m',
          messages: [{ role: 'user', content: 'Reply with the title "ok".' }],
          format: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } },
        }),
      })
      const d = await res.json()
      if (d.error) throw new Error(d.error)
      JSON.parse(d.message.content)
      const tps = d.eval_count && d.eval_duration ? (d.eval_count / (d.eval_duration / 1e9)).toFixed(1) : '?'
      add(true, 'Structured output', `schema-constrained JSON works · ${tps} tok/s decode · ${((Date.now() - t0) / 1000).toFixed(1)}s`)
      if (Number(tps) < 5) {
        add(true, 'Note', `${tps} tok/s is slow — a deck will take several minutes`,
          'Use a smaller model (qwen2.5:1.5b-instruct) or run on Apple Silicon.')
      }
    } catch (e) {
      add(false, 'Structured output', e.message, `Check the model is pulled:  ollama pull ${LLM}`)
    }
  }
}

// ── transcription ────────────────────────────────────────────────────────────
const whisperBin = process.env.WHISPER_BIN || (await which('whisper-cli')) || (await which('whisper-cpp'))
add(!!whisperBin, 'whisper.cpp', whisperBin || 'not installed', 'brew install whisper-cpp')
const ffmpeg = await which('ffmpeg')
add(!!ffmpeg, 'ffmpeg', ffmpeg || 'not installed', 'brew install ffmpeg')
const wModel = process.env.WHISPER_MODEL_PATH || path.join(DATA_DIR, 'models', `ggml-${WHISPER}.bin`)
const wFix = `rm -f "${wModel}" && curl -L -o "${wModel}" https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${WHISPER}.bin`

/**
 * Existence is not enough: an interrupted download leaves a plausible-looking
 * file that whisper.cpp rejects at runtime, long after the user stopped
 * suspecting the install. Check the ggml magic and the published size.
 */
const WHISPER_SIZES = {
  'tiny.en': 77_691_713, 'tiny': 77_691_713,
  'base.en': 147_964_211, 'base': 147_951_465,
  'small.en': 487_614_201, 'small': 487_601_967, 'small.en-q5_1': 190_098_681,
  'medium.en': 1_533_763_059, 'medium': 1_533_774_781,
  'large-v3-turbo': 1_624_555_275,
}
if (!fs.existsSync(wModel)) {
  add(false, 'Whisper model', `missing: ${wModel}`, wFix)
} else {
  const size = fs.statSync(wModel).size
  const expected = WHISPER_SIZES[WHISPER]
  const head = Buffer.alloc(4)
  const fd = fs.openSync(wModel, 'r'); fs.readSync(fd, head, 0, 4, 0); fs.closeSync(fd)
  const magicOk = head.toString('ascii') === 'lmgg'   // 'ggml' little-endian

  // Sample twice: a size that moves means a download is still running, which
  // is a different problem from a file that was left truncated.
  const t = Date.now()
  while (Date.now() - t < 1200) { /* brief pause */ }
  const size2 = fs.statSync(wModel).size

  if (size2 > size) {
    add(false, 'Whisper model', `still downloading (${(size2 / 1e6).toFixed(0)} MB of ${expected ? (expected / 1e6).toFixed(0) + ' MB' : '?'})`,
      'Wait for the download to finish, then re-run the doctor.')
  } else if (!magicOk) {
    add(false, 'Whisper model', `not a ggml file (${(size / 1e6).toFixed(0)} MB) — download was corrupted`, wFix)
  } else if (expected && size !== expected) {
    add(false, 'Whisper model', `truncated: ${(size / 1e6).toFixed(0)} MB, expected ${(expected / 1e6).toFixed(0)} MB`, wFix)
  } else {
    add(true, 'Whisper model', `${WHISPER} · ${(size / 1e6).toFixed(0)} MB · verified`)
  }
}

// ── data + config ────────────────────────────────────────────────────────────
add(fs.existsSync(DATA_DIR), 'Data directory', DATA_DIR, 'Created automatically on first launch.')
const profile = path.join(DATA_DIR, 'copods-profile.json')
add(fs.existsSync(profile), 'Company profile', fs.existsSync(profile) ? profile : 'not seeded yet',
  'Seeded on first launch from server/data/copods-profile.json.')

const offline = process.env.OFFLINE_MODE !== '0'
const provider = process.env.AI_PROVIDER || 'local'
add(offline && provider === 'local', 'Privacy posture',
  `OFFLINE_MODE=${offline ? 1 : 0}, AI_PROVIDER=${provider}`,
  'Set AI_PROVIDER=local and OFFLINE_MODE=1 to keep everything on this machine.')
const leaked = ['GROQ_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY'].filter(k => process.env[k]?.trim())
add(leaked.length === 0, 'No cloud keys set', leaked.length ? leaked.join(', ') + ' present' : 'none',
  'The server refuses to boot with a cloud key while offline. Comment them out in server/.env.')

// ── report ───────────────────────────────────────────────────────────────────
const pad = Math.max(...results.map(r => r.name.length))
console.log('\n  Codeck doctor\n')
for (const r of results) {
  const mark = r.name === 'Note' ? '\x1b[33m•\x1b[0m' : r.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'
  console.log(`  ${mark} ${r.name.padEnd(pad)}  ${r.detail}`)
  if (!r.ok && r.fix) console.log(`    ${' '.repeat(pad)}  → ${r.fix}`)
}
const failed = results.filter(r => !r.ok && r.name !== 'Note')
console.log(failed.length
  ? `\n  ${failed.length} problem${failed.length > 1 ? 's' : ''} to fix. Easiest path: bash scripts/codeck-setup.sh\n`
  : '\n  Everything is ready.\n')
process.exit(failed.length ? 1 : 0)
