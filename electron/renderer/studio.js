/**
 * Studio controller — live preview plus chat-driven editing.
 *
 * Deck JSON is the source of truth on the server; this module only ever sends
 * prompts and renders the spec that comes back. Selecting an element narrows
 * the edit to one JSON path, which is what keeps prompts small enough to be
 * quick on local CPU inference.
 */
import { renderSpec } from './preview.js'

const API = 'http://127.0.0.1:3001/api'
const $ = id => document.getElementById(id)

const state = {
  deckId: null, meetingId: null, deck: null, spec: null,
  selection: null, history: [], busy: false, zoom: 0.62,
  // Straight from the server: it owns the op log, so it is the only thing that
  // actually knows whether there is anything to undo or redo.
  canUndo: false, canRedo: false,
  // A File picked, pasted or dropped into the chat. It is only uploaded when
  // the message is sent, so attaching and then changing your mind costs nothing.
  attachment: null,
}

/* ── helpers ───────────────────────────────────────────────────────────────── */

async function post(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
  return data
}

function setStatus(text, cls = '') {
  const el = $('studio-status')
  if (el) { el.textContent = text; el.className = `studio-status ${cls}` }
}

function setBusy(busy) {
  state.busy = busy
  $('chat-send').disabled = busy || !canSend()
  $('chat-input').disabled = busy
  $('studio-export').disabled = busy || !state.deckId
  $('studio-undo').disabled = busy || !state.canUndo
  $('studio-redo').disabled = busy || !state.canRedo
}

/** Mirrors the server's view of the op log onto the two buttons. */
function setHistoryFlags(r) {
  if (typeof r?.canUndo === 'boolean') state.canUndo = r.canUndo
  if (typeof r?.canRedo === 'boolean') state.canRedo = r.canRedo
  $('studio-undo').disabled = state.busy || !state.canUndo
  $('studio-redo').disabled = state.busy || !state.canRedo
}

/* ── attachments ───────────────────────────────────────────────────────────── */

/** An attached image is a complete instruction on its own, so it can send alone. */
const canSend = () => !!($('chat-input').value.trim() || state.attachment)

function setAttachment(file) {
  if (state.attachment?.preview) URL.revokeObjectURL(state.attachment.preview)
  const box = $('chat-attachment')

  if (!file) {
    state.attachment = null
    box.classList.add('hidden')
    $('chat-file').value = ''
  } else {
    state.attachment = { file, preview: URL.createObjectURL(file) }
    $('chat-attach-thumb').src = state.attachment.preview
    $('chat-attach-name').textContent = file.name || 'pasted image'
    box.classList.remove('hidden')
    if (!$('chat-input').value.trim()) $('chat-input').placeholder = 'Where should it go? e.g. "add this to slide 4"'
    $('chat-input').focus()
  }
  $('chat-send').disabled = state.busy || !canSend()
}

/**
 * Puts the image in the library and returns its stored name. The prompt rides
 * along as `hint`, because a file called "Screenshot 2026-09-21.png" tells the
 * matcher nothing and the words around it tell it everything.
 */
async function uploadAttachment(prompt) {
  const body = new FormData()
  body.append('image', state.attachment.file, state.attachment.file.name || 'pasted.png')
  body.append('hint', prompt)
  const res = await fetch(`${API}/studio/image`, { method: 'POST', body })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || 'Could not read that image.')
  return data
}

const imageFrom = list => [...(list || [])].find(f => f.type?.startsWith('image/')) || null

/* ── chat log ──────────────────────────────────────────────────────────────── */

function addMsg(role, text, extra = {}) {
  const log = $('chat-log')
  log.querySelector('.chat-hint')?.remove()

  const el = document.createElement('div')
  el.className = `chat-msg ${role}`
  el.textContent = text

  if (extra.thumb) {
    const img = document.createElement('img')
    img.className = 'chat-attach-thumb'
    img.src = extra.thumb
    img.style.marginTop = '6px'
    el.appendChild(img)
  }

  // Tier 1 writes its own sentence and it is exact, so the op list underneath
  // is duplication. For a model edit the list IS the evidence — it says what
  // actually changed, independently of how the change was described.
  if (extra.applied?.length && extra.tier !== 'deterministic') {
    const ul = document.createElement('ul')
    ul.className = 'chat-ops'
    extra.applied.forEach(a => { const li = document.createElement('li'); li.textContent = a; ul.appendChild(li) })
    el.appendChild(ul)
  }
  if (extra.tier) {
    const meta = document.createElement('div')
    meta.className = 'chat-meta'
    const tier = document.createElement('span')
    tier.className = `chat-tier ${extra.tier}`
    tier.textContent = extra.tier === 'deterministic' ? 'instant' : extra.tier
    meta.appendChild(tier)
    // Surfacing the model time makes the tier-1/tier-2 difference visible
    // rather than something the user has to infer from feel.
    if (extra.timing?.totalMs) {
      const t = document.createElement('span')
      t.textContent = `${(extra.timing.totalMs / 1000).toFixed(1)}s`
      meta.appendChild(t)
    }
    if (extra.slideDelta) {
      const d = document.createElement('span')
      d.textContent = `${extra.slideDelta > 0 ? '+' : ''}${extra.slideDelta} slide${Math.abs(extra.slideDelta) > 1 ? 's' : ''}`
      meta.appendChild(d)
    }
    // Showing which slides a prompt resolved to is what makes it trustworthy to
    // type "slide 4" instead of clicking: a misread is visible immediately.
    if (extra.targets?.length) {
      const t = document.createElement('span')
      t.textContent = `slide${extra.targets.length > 1 ? 's' : ''} ${extra.targets.join(', ')}`
      meta.appendChild(t)
    }
    el.appendChild(meta)
  }

  log.appendChild(el)
  log.scrollTop = log.scrollHeight
  return el
}

function showWorking(label) {
  const log = $('chat-log')
  const el = document.createElement('div')
  el.className = 'chat-working'
  el.innerHTML = `<span class="chat-dot"></span><span class="chat-dot"></span><span class="chat-dot"></span><span>${label}</span>`
  log.appendChild(el)
  log.scrollTop = log.scrollHeight
  return el
}

/* ── preview ───────────────────────────────────────────────────────────────── */

function paint() {
  if (!state.spec) return
  renderSpec($('studio-preview'), state.spec, { scale: state.zoom, onSelect })
  $('studio-meta').textContent =
    `${state.spec.slides.length} slides${state.deck?.clientName ? ` · ${state.deck.clientName}` : ''}`
  if (state.deck?.deckTitle) $('studio-title').textContent = state.deck.deckTitle
}

function onSelect(sel) {
  state.selection = sel
  const box = $('chat-selection')
  if (!sel?.srcPath) { box.classList.add('hidden'); return }
  box.classList.remove('hidden')
  $('chat-sel-path').textContent = sel.text ? `${sel.srcPath} — "${sel.text.slice(0, 44)}"` : sel.srcPath
  $('chat-input').focus()
}

function clearSelection() {
  state.selection = null
  $('chat-selection').classList.add('hidden')
  document.querySelectorAll('.sl-selected').forEach(n => n.classList.remove('sl-selected'))
}

/* ── generation (streamed NDJSON) ──────────────────────────────────────────── */

/**
 * Reads the newline-delimited stream from /studio/generate, repainting as each
 * section lands so the deck visibly builds instead of blocking on a spinner.
 */
export async function generateInStudio(payload) {
  window.__navigate?.('studio')
  state.deck = null; state.spec = null; state.deckId = null
  state.history = []; state.canUndo = false; state.canRedo = false
  $('chat-log').innerHTML = ''
  $('studio-preview').innerHTML = '<div class="sl-empty">Starting…</div>'
  setBusy(true)
  setStatus('Generating…', 'busy')

  const started = Date.now()
  const working = showWorking('Generating the deck locally…')

  try {
    const res = await fetch(`${API}/studio/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error || `Generation failed (${res.status})`)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        let ev
        try { ev = JSON.parse(line) } catch { continue }
        handleGenEvent(ev, working)
      }
    }

    working.remove()
    const secs = ((Date.now() - started) / 1000).toFixed(0)
    setStatus(`Ready in ${secs}s`, 'ok')
    addMsg('sys', `Deck generated locally in ${secs}s — tell the chat what to change, by slide number or by name.`)
  } catch (err) {
    working.remove()
    setStatus('Failed', 'err')
    addMsg('err', err.message)
  } finally {
    setBusy(false)
  }
}

const SECTION_LABEL = {
  frame: 'Reading the transcript…',
  clientNeeds: 'Pulling out the client’s challenges…',
  proposedSolutions: 'Drafting the proposed solutions…',
  closing: 'Working out next steps…',
}

function handleGenEvent(ev, working) {
  switch (ev.stage) {
    case 'meeting':
      state.meetingId = ev.meetingId
      break
    case 'section:start':
      working.querySelector('span:last-child').textContent = SECTION_LABEL[ev.section] || ev.section
      setStatus(SECTION_LABEL[ev.section] || 'Working…', 'busy')
      break
    case 'section:done':
    case 'deterministic':
      if (ev.deck) state.deck = ev.deck
      if (ev.spec) { state.spec = ev.spec; paint() }
      if (ev.stage === 'deterministic') {
        working.querySelector('span:last-child').textContent = 'Adding case studies from your profile…'
      }
      break
    case 'saved':
      state.deckId = ev.deckId
      state.deck = ev.deck
      state.spec = ev.spec
      paint()
      $('studio-export').disabled = false
      if (ev.stats) reportStats(ev.stats)
      break
    case 'dossier':
      addMsg('sys', 'Saved what we learned about this client for next time.')
      break
    case 'indexWarning':
    case 'dossierWarning':
      console.warn('[studio]', ev.stage, ev.message)
      break
    case 'error':
      addMsg('err', ev.error)
      break
  }
}

function reportStats(stats) {
  const parts = []
  if (stats.promptTokens) parts.push(`${stats.promptTokens} prompt tok`)
  if (stats.outTokens) parts.push(`${stats.outTokens} generated`)
  if (stats.savedByDeterministic) parts.push(`${stats.savedByDeterministic} tok built from profile (not generated)`)
  const slowest = [...(stats.perSection || [])].sort((a, b) => (b.totalMs || 0) - (a.totalMs || 0))[0]
  if (slowest?.decodeTps) parts.push(`${slowest.decodeTps} tok/s decode`)
  if (parts.length) addMsg('sys', parts.join(' · '))
}

/* ── chat send ─────────────────────────────────────────────────────────────── */

async function send() {
  const input = $('chat-input')
  const attached = state.attachment
  // An image on its own means "use this" — the router works out where.
  const prompt = input.value.trim() || (attached ? 'add this image' : '')
  if (!prompt || state.busy) return
  if (!state.deckId) { addMsg('err', 'Generate or open a deck first.'); return }

  addMsg('user', input.value.trim() || 'Add this image.', { thumb: attached?.preview })
  state.history.push({ role: 'user', text: prompt })
  input.value = ''
  input.placeholder = 'Describe a change, or paste an image…'
  setBusy(true)

  // Tier 1 is instant; only warn about waiting when the model is involved.
  const working = showWorking(attached ? 'Adding your image…' : 'Working…')
  setStatus('Editing…', 'busy')

  try {
    let attachment = null
    if (attached) {
      attachment = await uploadAttachment(prompt)
      // Clear only once it is safely in the library, so a failed upload leaves
      // the image attached and the message retryable.
      setAttachment(null)
    }

    const r = await post('/studio/edit', {
      deckId: state.deckId, prompt, attachment,
      selection: state.selection, history: state.history.slice(-6),
    })
    working.remove()

    if (r.regenerate) {
      addMsg('bot', r.reply, { tier: 'regenerate' })
      setStatus('Needs a regenerate', '')
      return
    }

    state.deck = r.deck
    state.spec = r.spec
    paint()

    setHistoryFlags(r)
    addMsg(r.error ? 'err' : 'bot', r.reply, {
      tier: r.tier, timing: r.timing, applied: r.applied, slideDelta: r.slideDelta, targets: r.targets,
    })
    state.history.push({ role: 'assistant', text: r.reply })

    if (r.rejected?.length) {
      addMsg('sys', `${r.rejected.length} proposed change${r.rejected.length > 1 ? 's' : ''} pointed at paths that don't exist and were skipped.`)
    }
    setStatus(r.ops?.length ? 'Updated' : 'No change', r.ops?.length ? 'ok' : '')
  } catch (err) {
    working.remove()
    addMsg('err', err.message)
    setStatus('Failed', 'err')
  } finally {
    setBusy(false)
  }
}

/* ── open an existing deck ─────────────────────────────────────────────────── */

export async function openDeck(deckId) {
  window.__navigate?.('studio')
  setBusy(true)
  setStatus('Loading…', 'busy')
  try {
    const res = await fetch(`${API}/studio/deck/${deckId}`)
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Could not load that deck')
    state.deckId = data.deckId
    state.meetingId = data.meetingId
    state.deck = data.deck
    state.spec = data.spec
    state.history = []
    $('chat-log').innerHTML = ''
    paint()
    setHistoryFlags(data)
    setStatus(`Version ${data.version}`, '')
    const past = (data.ops || []).filter(o => !o.undone).length
    if (past) addMsg('sys', `${past} previous edit${past > 1 ? 's' : ''} in this deck's history.`)
  } catch (err) {
    setStatus('Failed', 'err')
    addMsg('err', err.message)
  } finally { setBusy(false) }
}

/* ── wiring ────────────────────────────────────────────────────────────────── */

export function initStudio() {
  $('chat-send').addEventListener('click', send)
  $('chat-input').addEventListener('input', () => {
    $('chat-send').disabled = state.busy || !canSend()
  })

  // Three ways in, because people reach for whichever is nearest: the button,
  // ⌘V, and dragging a file onto the panel.
  $('chat-attach').addEventListener('click', () => $('chat-file').click())
  $('chat-file').addEventListener('change', e => setAttachment(e.target.files?.[0] || null))
  $('chat-attach-clear').addEventListener('click', () => setAttachment(null))

  $('chat-input').addEventListener('paste', e => {
    const img = imageFrom(e.clipboardData?.files)
    if (img) { e.preventDefault(); setAttachment(img) }
  })

  const panel = document.querySelector('.studio-chat')
  let dragDepth = 0
  panel.addEventListener('dragenter', e => {
    if (!e.dataTransfer?.types?.includes('Files')) return
    e.preventDefault(); dragDepth++; panel.classList.add('chat-dropping')
  })
  panel.addEventListener('dragover', e => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault() })
  panel.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; panel.classList.remove('chat-dropping') } })
  panel.addEventListener('drop', e => {
    if (!e.dataTransfer?.types?.includes('Files')) return
    e.preventDefault()
    dragDepth = 0
    panel.classList.remove('chat-dropping')
    const img = imageFrom(e.dataTransfer.files)
    if (img) setAttachment(img)
    else addMsg('sys', 'That file is not an image — attach a PNG, JPEG, GIF or WebP.')
  })
  $('chat-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
  })
  $('chat-sel-clear').addEventListener('click', clearSelection)
  $('chat-clear').addEventListener('click', () => {
    state.history = []
    setAttachment(null)
    $('chat-log').innerHTML = ''
    addMsg('sys', 'Conversation cleared. The deck itself is unchanged.')
  })

  // Clicking an example inserts it, so the first edit costs no typing.
  $('chat-log').addEventListener('click', e => {
    if (e.target.matches('.chat-hint-list li')) {
      $('chat-input').value = e.target.textContent
      $('chat-send').disabled = false
      $('chat-input').focus()
    }
  })

  $('studio-zoom').addEventListener('input', e => {
    state.zoom = Number(e.target.value) / 100
    $('studio-zoom-value').textContent = `${e.target.value}%`
    paint()
  })

  const stepHistory = async which => {
    if (!state.deckId || state.busy) return
    setBusy(true)
    try {
      const r = await post(`/studio/${which}`, { deckId: state.deckId })
      state.deck = r.deck; state.spec = r.spec
      paint()
      setHistoryFlags(r)
      addMsg('sys', r.reply)
    } catch (err) { addMsg('err', err.message) } finally { setBusy(false) }
  }
  $('studio-undo').addEventListener('click', () => stepHistory('undo'))
  $('studio-redo').addEventListener('click', () => stepHistory('redo'))

  // ⌘Z / ⌘⇧Z, but not while typing into the chat box.
  document.addEventListener('keydown', e => {
    if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return
    if (document.activeElement === $('chat-input')) return
    if (!document.getElementById('view-studio')?.classList.contains('active')) return
    e.preventDefault()
    stepHistory(e.shiftKey ? 'redo' : 'undo')
  })

  $('studio-export').addEventListener('click', async () => {
    if (!state.deckId || state.busy) return
    setBusy(true)
    setStatus('Writing .pptx…', 'busy')
    try {
      const out = await post('/studio/export', { deckId: state.deckId })
      setStatus('Exported', 'ok')
      addMsg('sys', `Exported ${out.fileName} (${out.slideCount} slides).`)
      if (window.electronAPI?.showInFolder && out.filePath) window.electronAPI.showInFolder(out.filePath)
      else window.__downloadPPT?.(out.fileName)
    } catch (err) {
      setStatus('Export failed', 'err')
      addMsg('err', err.message)
    } finally { setBusy(false) }
  })

  // Show up front whether local inference is actually available, rather than
  // letting the first prompt fail with a connection error.
  fetch(`${API}/studio/status`).then(r => r.json()).then(s => {
    const foot = $('chat-foot')
    if (!s.inference?.up) {
      foot.textContent = 'Local model unreachable — start it with: ollama serve'
      foot.classList.add('warn')
    } else if (!s.inference.hasGenerate) {
      foot.textContent = `Model not installed — run: ollama pull ${s.provider?.model || 'qwen2.5:3b-instruct'}`
      foot.classList.add('warn')
    } else {
      foot.textContent = `${s.provider?.model} · local only, nothing leaves this machine`
    }
  }).catch(() => {})
}

export const studioState = state

/* ── Bridge to app.js ──────────────────────────────────────────────────────────
   app.js is a classic script and this is an ES module, so they meet on window
   rather than through imports. */
window.__studio = { init: initStudio, generate: generateInStudio, open: openDeck, state }
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initStudio)
else initStudio()
