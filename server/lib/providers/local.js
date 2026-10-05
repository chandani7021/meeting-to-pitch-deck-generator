/**
 * Local inference via Ollama on 127.0.0.1 — the only provider that satisfies
 * "no data leaves the machine".
 *
 * Why Ollama over the alternatives:
 *  - its `format` parameter takes a JSON Schema and compiles it to a llama.cpp
 *    GBNF grammar, so the sampler cannot emit off-schema tokens. With a 4B model
 *    that is the difference between reliable structured output and failing a
 *    third of the time.
 *  - one localhost daemon serves both generation and embeddings.
 *  - no native module, so nothing to rebuild against Electron's ABI.
 * (For a shipped .dmg, bundle llama-server directly — same grammar support,
 *  one less thing for the user to install.)
 */

const OLLAMA = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434'

export const MODEL       = process.env.LOCAL_MODEL       || 'qwen2.5:3b-instruct'
export const EDIT_MODEL  = process.env.LOCAL_EDIT_MODEL  || MODEL
export const QUALITY_MODEL = process.env.LOCAL_QUALITY_MODEL || MODEL

/** Per-call timings, so slow prompts are visible instead of just "it's slow". */
export const lastTimings = []
function recordTiming(t) {
  lastTimings.push(t)
  if (lastTimings.length > 50) lastTimings.shift()
}

/**
 * One grammar-constrained JSON completion.
 * `schema` is a JSON Schema; omit it only for free text.
 */
export async function complete({
  system, user, schema, model = MODEL,
  temperature = 0.3, timeoutMs = Number(process.env.LOCAL_TIMEOUT_MS || 600000),
  numCtx = Number(process.env.LOCAL_NUM_CTX || 8192),
  label = 'complete',
}) {
  const body = {
    model,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: user },
    ],
    stream: false,
    // Keep the model resident between the four section calls and the chat
    // edits that follow — a reload costs more than the generation itself on
    // CPU-only hardware.
    keep_alive: process.env.LOCAL_KEEP_ALIVE || '30m',
    options: { temperature, num_ctx: numCtx },
  }
  if (schema) body.format = schema

  const started = Date.now()
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  let res
  try {
    res = await fetch(`${OLLAMA}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctl.signal,
    })
  } catch (err) {
    clearTimeout(timer)
    if (err.name === 'AbortError') {
      throw new Error(`Local model timed out after ${Math.round(timeoutMs / 1000)}s. On CPU-only hardware try a smaller LOCAL_MODEL or a tighter context budget.`)
    }
    throw new Error(`Cannot reach Ollama at ${OLLAMA}. Is it running? (\`ollama serve\`)`)
  } finally { clearTimeout(timer) }

  if (!res.ok) {
    const text = await res.text()
    if (res.status === 404) {
      throw new Error(`Model "${model}" is not installed. Run: ollama pull ${model}`)
    }
    throw new Error(`Ollama error ${res.status}: ${text.slice(0, 300)}`)
  }

  const data = await res.json()
  const content = data.message?.content || ''

  // Ollama reports nanosecond counters; these are the numbers that tell you
  // whether prefill or decode is your bottleneck on this machine.
  const timing = {
    label, model,
    promptTokens: data.prompt_eval_count ?? null,
    outputTokens: data.eval_count ?? null,
    prefillMs: data.prompt_eval_duration ? Math.round(data.prompt_eval_duration / 1e6) : null,
    decodeMs:  data.eval_duration ? Math.round(data.eval_duration / 1e6) : null,
    totalMs: Date.now() - started,
  }
  // When llama.cpp reuses a cached prefix it reports the full prompt length but
  // a tiny prefill duration — an implausibly high rate is the signal that the
  // shared-prefix ordering is working.
  timing.prefillTps = timing.promptTokens && timing.prefillMs ? +(timing.promptTokens / (timing.prefillMs / 1000)).toFixed(1) : null
  timing.cacheHit = !!(timing.prefillTps && timing.prefillTps > 150)
  timing.decodeTps  = timing.outputTokens && timing.decodeMs  ? +(timing.outputTokens / (timing.decodeMs / 1000)).toFixed(1)  : null
  recordTiming(timing)

  if (!schema) return { text: content, timing }

  try {
    return { data: JSON.parse(content), timing }
  } catch {
    // Grammar-constrained output should always parse; if it somehow doesn't,
    // salvage the outermost object rather than losing a minutes-long call.
    const m = content.match(/\{[\s\S]*\}/)
    if (m) { try { return { data: JSON.parse(m[0]), timing } } catch {} }
    throw new Error(`Local model returned unparseable JSON (${content.length} chars). First 200: ${content.slice(0, 200)}`)
  }
}

export async function health() {
  try {
    const res = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(2500) })
    if (!res.ok) return { up: false, error: `HTTP ${res.status}` }
    const { models = [] } = await res.json()
    const names = models.map(m => m.name)
    return {
      up: true, host: OLLAMA, models: names,
      hasGenerate: names.some(n => n.startsWith(MODEL.split(':')[0])),
      hasEmbed: names.some(n => n.startsWith((process.env.EMBED_MODEL || 'nomic-embed-text').split(':')[0])),
    }
  } catch (err) {
    return { up: false, error: err.message, host: OLLAMA }
  }
}

export const providerInfo = {
  provider: 'local',
  model: MODEL,
  editModel: EDIT_MODEL,
  transcriptionModel: process.env.WHISPER_MODEL || 'whisper.cpp small.en',
  offline: true,
}

/**
 * Kept so routes/ai.js's provider interface stays uniform across providers.
 * A schema is always supplied — without one complete() returns free text, and
 * this caller needs an object.
 */
export async function analyzeTranscript(transcript, clientName, systemPrompt, schema) {
  const { GENERATION_SCHEMA } = await import('../deckSchema.js')
  const { data } = await complete({
    system: systemPrompt,
    user: `Client name hint: ${clientName || 'unknown'}\n\nMeeting transcript:\n${transcript}`,
    schema: schema || GENERATION_SCHEMA,
    label: 'analyzeTranscript',
  })
  return data
}
