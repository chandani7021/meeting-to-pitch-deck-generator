/**
 * Local transcription via whisper.cpp.
 *
 * Replaces the Groq Whisper call so audio never leaves the machine. Model choice
 * matters a lot on this class of hardware: large-v3-turbo runs at roughly
 * realtime at best on a 4-core Intel CPU, which is too slow for the 5-second
 * live segments the recorder produces. small.en / base.en run comfortably
 * faster than realtime.
 *
 * Setup:
 *   brew install whisper-cpp
 *   mkdir -p ~/.codeck/models && curl -L -o ~/.codeck/models/ggml-small.en.bin \
 *     https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin
 */
import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import fs from 'fs'
import os from 'os'

const exec = promisify(execFile)

const BIN = process.env.WHISPER_BIN || 'whisper-cli'
const SERVER_BIN = process.env.WHISPER_SERVER_BIN || 'whisper-server'
const SERVER_PORT = Number(process.env.WHISPER_PORT || 8917)
const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`
// Hyperthreads make this slower, not faster: measured 23s for a 15s clip at
// -t 4 against 33s at -t 8 on a 4-physical-core chassis.
const THREADS = String(process.env.WHISPER_THREADS || Math.max(2, os.cpus().length / 2))

/**
 * The live recorder's segment length, and the encoder context sized to match.
 *
 * Whisper's encoder always processes a full 30-second window whatever you feed
 * it, so a 15s clip pays for 30s of work. `-ac` shrinks that window and is the
 * single biggest speedup available here — measured 35.6s -> 17.5s on a 15s clip.
 *
 * It is also the most dangerous flag in this file. Audio longer than the window
 * is not merely truncated, it degenerates: a 17.5s clip through a 15s context
 * produced "and a band quarter and a band quarter and a band". So the window is
 * declared once, the renderer records to it, and anything longer is routed away
 * from the shrunken context entirely. Never raise SEGMENT_SECONDS without
 * raising the window with it — they are one setting in two places.
 */
export const SEGMENT_SECONDS = Number(process.env.WHISPER_WINDOW_S || 14)
const AC_MARGIN_S = 2                         // headroom for recorder jitter
const AC_FRAMES = Math.round(((SEGMENT_SECONDS + AC_MARGIN_S) / 30) * 1500)
const AC_MAX_S = SEGMENT_SECONDS + AC_MARGIN_S - 0.5

export const WHISPER_MODEL = process.env.WHISPER_MODEL || 'small.en'

function modelsDir(dataDir) {
  const dir = dataDir || process.env.DATA_DIR || path.join(process.env.HOME, '.codeck')
  return path.join(dir, 'models')
}

/**
 * Prefers the q5_1 quantisation when it is installed: measured 2.5x faster than
 * the fp16 weights with no meaningful accuracy difference on speech. An explicit
 * WHISPER_MODEL always wins.
 */
function modelPath(dataDir) {
  if (process.env.WHISPER_MODEL_PATH) return process.env.WHISPER_MODEL_PATH
  const dir = modelsDir(dataDir)
  if (!process.env.WHISPER_MODEL) {
    const quant = path.join(dir, `ggml-${WHISPER_MODEL}-q5_1.bin`)
    if (fs.existsSync(quant)) return quant
  }
  return path.join(dir, `ggml-${WHISPER_MODEL}.bin`)
}

/** Seconds of audio in a WAV, via ffprobe. Returns null when it cannot tell. */
async function durationOf(wav) {
  try {
    const probe = process.env.FFPROBE_BIN || 'ffprobe'
    const { stdout } = await exec(probe, ['-v', 'error', '-show_entries', 'format=duration',
                                          '-of', 'csv=p=0', wav], { timeout: 10000 })
    const d = parseFloat(stdout.trim())
    return Number.isFinite(d) ? d : null
  } catch { return null }
}

/** whisper.cpp needs 16 kHz mono PCM WAV; the recorder sends WebM/Opus. */
async function toWav(inputPath) {
  const out = path.join(os.tmpdir(), `codeck-${Date.now()}.wav`)
  const ffmpeg = process.env.FFMPEG_BIN || 'ffmpeg'
  await exec(ffmpeg, ['-nostdin', '-loglevel', 'error', '-y', '-i', inputPath,
                      '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', out], { timeout: 60000 })
  return out
}

/* ── Warm server ───────────────────────────────────────────────────────────── */
/*
 * whisper-cli reloads the ~470 MB model on every invocation, which measured at
 * roughly 10 seconds of fixed cost per call — so a 5-second segment took 11s
 * and transcription could never keep pace with a live meeting. whisper-server
 * loads the model once and stays resident, which takes the same clip to about
 * realtime. It listens on loopback only and is spawned by us, so nothing leaves
 * the machine.
 */
let server = null          // the child process, once started
let serverReady = null     // a promise, so concurrent callers await one startup

function startServer(model) {
  const child = spawn(SERVER_BIN, [
    // Only flags whisper-server actually accepts — it exits on an unknown one,
    // and the fallback then hides that as "just slow".
    '-m', model, '--host', '127.0.0.1', '--port', String(SERVER_PORT),
    '-t', THREADS, '-l', 'en', '-ac', String(AC_FRAMES),
  ], { stdio: ['ignore', 'pipe', 'pipe'] })

  let stderr = ''
  child.stderr?.on('data', d => { stderr = (stderr + d).slice(-500) })
  child.on('exit', code => {
    if (code) console.warn(`[transcribe] whisper-server exited (${code}): ${stderr.trim().split('\n').pop()}`)
    if (server === child) { server = null; serverReady = null }
  })
  child.on('error', () => { if (server === child) { server = null; serverReady = null } })
  server = child

  // Node exits without cleaning up children, which would leave the model
  // resident in RAM after the app closes.
  const kill = () => { try { child.kill() } catch {} }
  process.once('exit', kill)
  process.once('SIGINT', kill)
  process.once('SIGTERM', kill)

  return waitForServer(child)
}

async function waitForServer(child, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error('whisper-server exited during startup')
    try {
      const res = await fetch(SERVER_URL, { signal: AbortSignal.timeout(1500) })
      if (res.status < 500) return true
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 400))
  }
  throw new Error('whisper-server did not become ready in time')
}

/** Resolves true when the warm server is usable, false to fall back to the CLI. */
async function ensureServer(model) {
  if (process.env.WHISPER_SERVER === '0') return false
  if (server && serverReady) { try { await serverReady; return true } catch { return false } }
  serverReady = startServer(model)
  try { await serverReady; return true }
  catch (err) {
    console.warn('[transcribe] warm server unavailable, falling back to whisper-cli:', err.message)
    try { server?.kill() } catch {}
    server = null; serverReady = null
    return false
  }
}

async function transcribeViaServer(wav) {
  const body = new FormData()
  body.append('file', new Blob([fs.readFileSync(wav)], { type: 'audio/wav' }), 'audio.wav')
  body.append('response_format', 'text')
  body.append('temperature', '0.0')
  const res = await fetch(`${SERVER_URL}/inference`, {
    method: 'POST', body, signal: AbortSignal.timeout(300000),
  })
  if (!res.ok) throw new Error(`whisper-server returned ${res.status}`)
  return await res.text()
}

export async function transcribeAudio(audioPath, _mimeType, dataDir) {
  const model = modelPath(dataDir)
  if (!fs.existsSync(model)) {
    throw new Error(`Whisper model missing at ${model}. Download it with:\n  mkdir -p "${path.dirname(model)}" && curl -L -o "${model}" https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${WHISPER_MODEL}.bin`)
  }
  // An interrupted download leaves a file that looks installed but is rejected
  // by whisper.cpp with an opaque error — catch it here with a clear message.
  const head = Buffer.alloc(4)
  const fd = fs.openSync(model, 'r')
  try { fs.readSync(fd, head, 0, 4, 0) } finally { fs.closeSync(fd) }
  if (head.toString('ascii') !== 'lmgg') {
    throw new Error(`The whisper model at ${model} is incomplete or corrupted (bad header). Delete it and download it again — see \`npm run doctor\`.`)
  }

  let wav
  try { wav = await toWav(audioPath) }
  catch (err) {
    throw new Error(`Could not convert audio (is ffmpeg installed? \`brew install ffmpeg\`): ${err.message}`)
  }

  try {
    // The warm server runs a shrunken encoder context, which is only correct for
    // clips that fit inside it. Long audio — an imported recording rather than a
    // live segment — goes to the CLI at full context instead. It is slower, but
    // it is the difference between a transcript and a stuck loop of nonsense.
    const seconds = await durationOf(wav)
    const fits = seconds == null ? false : seconds <= AC_MAX_S

    if (fits && await ensureServer(model)) {
      try { return clean(await transcribeViaServer(wav)) }
      catch (err) {
        // A warm server that fails mid-meeting must not lose the segment — drop
        // to the CLI for this one and let the next call retry the server.
        console.warn('[transcribe] warm server call failed, using whisper-cli:', err.message)
      }
    } else if (!fits) {
      console.log(`[transcribe] ${seconds == null ? 'unknown' : seconds.toFixed(1) + 's'} clip exceeds the ${AC_MAX_S}s fast window — using full-context whisper-cli`)
    }

    // -nt suppresses timestamps; we only want the words. No -ac here: this path
    // exists precisely because the audio is too long for a shrunken context.
    const { stdout } = await exec(BIN, [
      '-m', model, '-f', wav, '-nt', '-l', 'en', '-t', THREADS,
    ], { timeout: 900000, maxBuffer: 16 * 1024 * 1024 })
    return clean(stdout)
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`whisper.cpp not found ("${BIN}"). Install it with \`brew install whisper-cpp\`, or set WHISPER_BIN.`)
    }
    throw new Error(`Transcription failed: ${err.message}`)
  } finally {
    fs.unlink(wav, () => {})
  }
}

/**
 * Strips whisper's non-speech annotations. It emits [BLANK_AUDIO], (silence)
 * and similar for pauses and background noise; left in, they end up quoted as
 * meeting content in the deck.
 */
const NOISE = /^\s*(?:blank_audio|silence|music|applause|laughter|inaudible|noise|clicking|typing|background\s+\w+)\s*$/i

function clean(raw) {
  return String(raw || '')
    .replace(/\[([^\]]*)\]/g, (m, inner) => (NOISE.test(inner) ? '' : m))
    .replace(/\(([^)]*)\)/g, (m, inner) => (NOISE.test(inner) ? '' : m))
    .replace(/\s+/g, ' ')
    .trim()
}

export async function health() {
  const model = modelPath()
  const out = {
    model: path.basename(model).replace(/^ggml-|\.bin$/g, ''),
    modelPath: model, modelPresent: fs.existsSync(model),
    quantized: /q\d_/.test(model), windowSeconds: SEGMENT_SECONDS, audioCtx: AC_FRAMES,
  }
  try { await exec(BIN, ['--help'], { timeout: 5000 }); out.binaryPresent = true }
  catch { out.binaryPresent = false }
  // Present is not the same as running — the server starts on first use.
  try { await exec(SERVER_BIN, ['--help'], { timeout: 5000 }); out.serverBinaryPresent = true }
  catch { out.serverBinaryPresent = false }
  out.warm = !!server
  try { await exec(process.env.FFMPEG_BIN || 'ffmpeg', ['-version'], { timeout: 5000 }); out.ffmpegPresent = true }
  catch { out.ffmpegPresent = false }
  out.ready = out.binaryPresent && out.modelPresent && out.ffmpegPresent
  return out
}
