'use strict'

/* ═══════════════════════════════════════════════════════════
   API
   ═══════════════════════════════════════════════════════════ */
const API = 'http://localhost:3001/api'

async function apiFetch(path, opts = {}) {
  let res
  try { res = await fetch(`${API}${path}`, opts) }
  catch { throw new Error('Cannot reach server — is it running on port 3001?') }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || `Request failed: ${res.status}`)
  }
  return res.json()
}

const api = {
  getMeetings:       ()     => apiFetch('/meetings'),
  getConfig:         ()     => apiFetch('/config'),
  calStatus:         ()     => apiFetch('/calendar/status'),
  calAuthUrl:        ()     => apiFetch('/calendar/auth-url'),
  calUpcoming:       ()     => apiFetch('/calendar/upcoming'),
  calDisconnect:     ()     => apiFetch('/calendar/disconnect'),
  saveMeeting:       (data) => apiFetch('/meetings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
  deleteMeeting:     (id)   => apiFetch(`/meetings/${id}`, { method: 'DELETE' }),
  updateMeeting:     (id, data) => apiFetch(`/meetings/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
  analyzeTranscript: (t, c, intent, title, anonymize) => apiFetch('/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transcript: t, clientName: c, deckIntent: intent, meetingTitle: title, anonymize }) }),
  generatePPT:       (md)   => apiFetch('/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ meetingData: md }) }),
  getProvider:       ()     => apiFetch('/provider'),

  async transcribeAudio(blob) {
    const fd = new FormData()
    fd.append('audio', blob, 'chunk.webm')
    fd.append('mimeType', blob.type || 'audio/webm')
    let res
    try { res = await fetch(`${API}/transcribe`, { method: 'POST', body: fd }) }
    catch { throw new Error('Cannot reach server') }
    if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.error || 'Transcription failed') }
    return (await res.json()).text
  },

  async uploadTemplate(file) {
    const fd = new FormData()
    fd.append('template', file)
    let res
    try { res = await fetch(`${API}/template`, { method: 'POST', body: fd }) }
    catch { throw new Error('Cannot reach server — make sure it is running on port 3001') }
    if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.error || `Upload failed (${res.status})`) }
    return res.json()
  },

  downloadPPT(fileName) {
    const url = `${API}/meetings/download/${encodeURIComponent(fileName)}`
    if (window.electronAPI?.downloadFile) {
      window.electronAPI.downloadFile(url)
    } else {
      // Fallback for browser dev mode
      const a = document.createElement('a')
      a.href = url; a.download = fileName
      document.body.appendChild(a); a.click(); document.body.removeChild(a)
    }
  },
}

/* ─── Reveal generated file in Finder, fallback to HTTP download ── */
function revealOrDownload(result) {
  if (window.electronAPI?.showInFolder && result.filePath) {
    window.electronAPI.showInFolder(result.filePath)
  } else {
    api.downloadPPT(result.fileName)
  }
}

/* ═══════════════════════════════════════════════════════════
   Utilities
   ═══════════════════════════════════════════════════════════ */
const $  = id  => document.getElementById(id)
const $$ = sel => document.querySelectorAll(sel)

const wordCount  = t => (t || '').trim().split(/\s+/).filter(Boolean).length
const formatDate = iso => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
const initials   = name => (name || 'UN').trim().split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 2)
const escapeHtml = s => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/* ═══════════════════════════════════════════════════════════
   Navigation
   ═══════════════════════════════════════════════════════════ */
let currentTab = 'record'
let meetingsDirty = true  // true = re-fetch from server; false = re-render from in-memory.

function navigate(tab) {
  if (tab === currentTab && tab !== 'record') return
  currentTab = tab
  $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.tab === tab))
  $$('.view').forEach(v => v.classList.remove('active'))
  document.getElementById(`view-${tab}`)?.classList.add('active')
  if (tab === 'history') {
    if (meetingsDirty) loadHistory()
    else renderMeetings(filterMeetings($('search-input').value))
  }
  if (tab === 'settings') loadSettings()
}

$$('.nav-item').forEach(b => b.addEventListener('click', () => navigate(b.dataset.tab)))

// studio.js is an ES module and this file is a classic script — they meet here.
window.__navigate = navigate
window.__downloadPPT = (fileName) => api.downloadPPT(fileName)

/* ═══════════════════════════════════════════════════════════
   Recording state
   ═══════════════════════════════════════════════════════════ */
let finalTranscript = ''
let isRecording     = false
let currentMode     = 'mic'
let timerInterval   = null
let timerSeconds    = 0

/* ─── Timer ──────────────────────────────────────────────── */
function startTimer() {
  timerSeconds = 0
  $('timer-display').classList.remove('hidden')
  timerInterval = setInterval(() => {
    timerSeconds++
    const m = String(Math.floor(timerSeconds / 60)).padStart(2, '0')
    const s = String(timerSeconds % 60).padStart(2, '0')
    $('timer-display').textContent = `${m}:${s}`
  }, 1000)
}

function stopTimer() {
  clearInterval(timerInterval)
  timerInterval = null
  $('timer-display').classList.add('hidden')
  $('timer-display').textContent = '00:00'
}

/* ─── Transcript helpers ─────────────────────────────────── */
function setFinal(text) {
  finalTranscript = text
  $('transcript-text').textContent = finalTranscript
  syncTranscriptUI()
}

function appendFinal(text) {
  finalTranscript += text
  $('transcript-text').textContent = finalTranscript
  syncTranscriptUI()
  $('transcript-end').scrollIntoView({ behavior: 'smooth', block: 'nearest' })
}

function setInterim(text) {
  $('transcript-interim').textContent = text
  const hasContent = finalTranscript.trim().length > 0 || text.trim().length > 0
  $('transcript-empty-state').classList.toggle('hidden', hasContent)
  $('transcript-filled').classList.toggle('hidden', !hasContent)
}

function syncTranscriptUI() {
  const hasContent = finalTranscript.trim().length > 0
  $('transcript-empty-state').classList.toggle('hidden', hasContent)
  $('transcript-filled').classList.toggle('hidden', !hasContent)
  $('session-section').classList.toggle('hidden', !hasContent)
  $('copy-btn').classList.toggle('hidden', !hasContent)

  const wc = wordCount(finalTranscript)
  $('word-count').textContent = `${wc} word${wc !== 1 ? 's' : ''}`
  $('review-word-count').textContent = `${wc} word${wc !== 1 ? 's' : ''}`
}

function setRecordingUI(active) {
  $('live-badge').classList.toggle('hidden', !active)
}

function clearError() {
  $('record-error').textContent = ''
  $('record-error').classList.add('hidden')
}

function showError(msg) {
  $('record-error').textContent = msg
  $('record-error').classList.remove('hidden')
}

/* ═══════════════════════════════════════════════════════════
   Mode switcher
   ═══════════════════════════════════════════════════════════ */
$$('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (isRecording) return
    currentMode = btn.dataset.mode
    $$('.mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === currentMode))
    $('mic-interface').classList.toggle('hidden', currentMode !== 'mic')
    $('meeting-interface').classList.toggle('hidden', currentMode !== 'meeting')
    clearError()
  })
})

/* ═══════════════════════════════════════════════════════════
   Transcription — record continuously, transcribe behind it
   Each segment is a fresh MediaRecorder → self-contained WebM
   (a timesliced chunk after the first has no header and cannot
   be decoded on its own), so the recorder restarts per segment.

   What must NEVER happen is awaiting the transcription inside
   that loop. It used to, which was fine against cloud Whisper
   at ~0.5s a call, but local whisper.cpp takes ~11s for a 5s
   segment — so the microphone sat stopped for 11 of every 16
   seconds and roughly 70% of the meeting was never captured.
   Segments now go onto a queue and the recorder restarts
   immediately; the queue drains behind the meeting and is
   flushed on stop.
   ═══════════════════════════════════════════════════════════ */
// Longer segments are both faster per second of audio (one model pass instead
// of three) and more accurate — Whisper is trained on 30s windows, and a 5s
// clip clipped mid-word at each end transcribes badly.
// Must stay inside the server's shrunken encoder window (WHISPER_WINDOW_S,
// default 14s). A segment longer than that window does not just get clipped —
// it sends the decoder into a repetition loop. See server/lib/transcribe.js.
const SEGMENT_MS = Number(localStorage.getItem('codeck.segmentMs') || 14000)
const getMimeType = () => MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm'

/* ─── Transcription queue ─────────────────────────────────── */
const queue = []
let draining = false
let drainedResolve = null
let drainedPromise = null

function queueStatus() {
  if (!queue.length && !draining) { setInterim(''); return }
  const behind = queue.length + (draining ? 1 : 0)
  setInterim(behind > 1 ? `Transcribing… (${behind} segments behind)` : 'Transcribing…')
}

function enqueueBlob(blob) {
  if (!blob || blob.size < 1000) return   // skip near-empty blobs
  queue.push(blob)
  if (!drainedPromise) drainedPromise = new Promise(r => { drainedResolve = r })
  queueStatus()
  if (!draining) drainQueue()
}

async function drainQueue() {
  draining = true
  while (queue.length) {
    const blob = queue.shift()
    queueStatus()
    try {
      const text = await api.transcribeAudio(blob)
      if (text?.trim()) appendFinal(text.trim() + ' ')
    } catch (err) {
      console.error('[whisper] segment failed:', err.message)
      showError?.(`Transcription problem: ${err.message}`)
    }
  }
  draining = false
  queueStatus()
  drainedResolve?.(); drainedResolve = null; drainedPromise = null
}

/** Waits for every queued segment to finish — used when recording stops. */
async function flushQueue() {
  if (!queue.length && !draining) return
  setInterim('Finishing transcription…')
  await drainedPromise
  setInterim('')
}

// Records one segment of SEGMENT_MS, resolves with collected chunks
function recordSegment(stream, recorderRef) {
  return new Promise(resolve => {
    const mimeType = getMimeType()
    const chunks = []
    const rec = new MediaRecorder(stream, { mimeType })
    recorderRef.current = rec
    rec.ondataavailable = (e) => { if (e.data?.size > 0) chunks.push(e.data) }
    rec.onstop = () => resolve(new Blob(chunks, { type: mimeType }))
    rec.start()
    setTimeout(() => { if (rec.state === 'recording') rec.stop() }, SEGMENT_MS)
  })
}

/* ─── Microphone mode ────────────────────────────────────── */
let micStream = null
const micRef = { current: null }  // holds active MediaRecorder

async function startMic() {
  clearError()
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    micStream.getAudioTracks()[0]?.addEventListener('ended', stopMic)
    isRecording = true
    $('mic-btn').classList.add('active')
    $('mic-hint').textContent = 'Recording — transcribing on this Mac'
    setRecordingUI(true)
    startTimer()
    // Run segment loop without awaiting — it runs in background
    ;(async () => {
      while (isRecording && micStream) {
        const blob = await recordSegment(micStream, micRef)
        enqueueBlob(blob)   // NOT awaited — the next segment starts immediately
      }
    })()
  } catch (err) {
    showError(err.name === 'NotAllowedError'
      ? 'Microphone permission denied — grant it in System Settings → Privacy & Security → Microphone, then relaunch'
      : err.message)
  }
}

async function stopMic() {
  isRecording = false
  // Just trigger stop — don't overwrite onstop, or recordSegment's Promise hangs forever
  if (micRef.current?.state === 'recording') micRef.current.stop()
  micRef.current = null
  if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null }
  $('mic-btn').classList.remove('active')
  $('mic-hint').textContent = 'Press Space or click to record'
  setRecordingUI(false)
  stopTimer()
  // Transcription runs behind the recording, so on stop there is usually a
  // backlog. Waiting for it is the difference between a complete transcript
  // and one that ends mid-sentence.
  await flushQueue()
}

$('mic-btn').addEventListener('click', () => { if (isRecording) stopMic(); else startMic() })

/* ═══════════════════════════════════════════════════════════
   Meeting audio capture
   ═══════════════════════════════════════════════════════════ */
let captureStream = null, captureAudioCtx = null
const captureRef = { current: null }  // holds active MediaRecorder

async function getMixedStream() {
  // System audio — use getDisplayMedia everywhere (avoids chromeMediaSource
  // dummy-video workaround that spams "Can't wrap SharedImage as VideoFrame")
  const sysStream = await navigator.mediaDevices.getDisplayMedia({
    video: { width: { max: 1 }, height: { max: 1 }, frameRate: { max: 1 } },
    audio: { echoCancellation: false, noiseSuppression: false },
  })
  // Stop the 1×1 video track immediately — we only needed it to open the picker
  sysStream.getVideoTracks().forEach(t => t.stop())

  // Mic audio — your own voice
  let micStream = null
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 16000 }, video: false })
  } catch {
    // Mic unavailable — fall back to system audio only
    return sysStream
  }

  // Mix both into one stream using Web Audio API
  const ctx  = new AudioContext({ sampleRate: 16000 })
  const dest = ctx.createMediaStreamDestination()
  if (sysStream.getAudioTracks().length > 0) {
    ctx.createMediaStreamSource(sysStream).connect(dest)
  }
  ctx.createMediaStreamSource(micStream).connect(dest)
  captureAudioCtx = ctx

  // Stop source tracks when the mixed stream ends
  dest.stream.getAudioTracks()[0].addEventListener('ended', () => {
    sysStream.getTracks().forEach(t => t.stop())
    micStream.getTracks().forEach(t => t.stop())
  })

  // Keep references so stopCapture() can clean them up
  captureStream = Object.assign(dest.stream, { _sys: sysStream, _mic: micStream })
  return captureStream
}

async function startCapture() {
  clearError()
  try {
    captureStream = await getMixedStream()
    captureStream.getAudioTracks()[0]?.addEventListener('ended', stopCapture)
    isRecording = true
    $('capture-btn').classList.add('active')
    $('capture-hint').textContent = 'Audio only — switch tabs freely, click to stop'
    setRecordingUI(true)
    startTimer()
    ;(async () => {
      while (isRecording && captureStream) {
        const blob = await recordSegment(captureStream, captureRef)
        enqueueBlob(blob)   // NOT awaited — the next segment starts immediately
      }
    })()
  } catch (err) {
    const msg = err.name === 'NotAllowedError'
      ? window.electronAPI?.isElectron
        ? 'Screen Recording permission required — grant it in System Settings → Privacy & Security → Screen Recording, then relaunch Codeck'
        : 'Permission denied — click Share and select your Meet or Zoom tab with "Share audio" enabled'
      : err.name === 'NotSupportedError'
        ? 'Audio capture not supported here.'
        : err.message
    showError(msg)
  }
}

async function stopCapture() {
  isRecording = false
  // Just trigger stop — don't overwrite onstop, or recordSegment's Promise hangs forever
  if (captureRef.current?.state === 'recording') captureRef.current.stop()
  captureRef.current = null
  if (captureStream) {
    captureStream.getTracks().forEach(t => t.stop())
    captureStream._sys?.getTracks().forEach(t => t.stop())
    captureStream._mic?.getTracks().forEach(t => t.stop())
    captureStream = null
  }
  if (captureAudioCtx) { captureAudioCtx.close(); captureAudioCtx = null }
  $('capture-btn').classList.remove('active')
  $('capture-hint').textContent = 'Captures both sides — your mic + meeting audio'
  setRecordingUI(false)
  stopTimer()
  await flushQueue()
}

$('capture-btn').addEventListener('click', () => { if (isRecording) stopCapture(); else startCapture() })

/* Space bar shortcut */
document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space') return
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
  if (currentTab !== 'record' || currentMode !== 'mic') return
  e.preventDefault()
  if (isRecording) stopMic(); else startMic()
})

/* Copy transcript button */
$('copy-btn').addEventListener('click', () => {
  navigator.clipboard.writeText(finalTranscript).then(() => {
    const btn = $('copy-btn')
    btn.textContent = '✓ Copied'
    setTimeout(() => {
      btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy`
    }, 2000)
  })
})

/* ═══════════════════════════════════════════════════════════
   Record → Review
   ═══════════════════════════════════════════════════════════ */
$('review-btn').addEventListener('click', () => {
  if (isRecording) { if (currentMode === 'mic') stopMic(); else stopCapture() }
  $('review-textarea').value = finalTranscript.trim()
  $('review-word-count').textContent = `${wordCount(finalTranscript)} words`
  $('generate-status').className = 'hidden'
  // Pre-fill from selected calendar event if title not already set
  if (!$('meeting-title').value.trim() && selectedCalEvent?.title) {
    $('meeting-title').value = selectedCalEvent.title
  }
  if (!$('client-name').value.trim() && selectedCalEvent?.clientName) {
    $('client-name').value = selectedCalEvent.clientName
  }
  navigate('review')
})

$('back-btn').addEventListener('click', () => navigate('record'))

$('reset-btn').addEventListener('click', () => {
  if (isRecording) { if (currentMode === 'mic') stopMic(); else stopCapture() }
  setFinal('')
  clearError()
})

/* ═══════════════════════════════════════════════════════════
   Review view — Generate PPT
   ═══════════════════════════════════════════════════════════ */
$('review-textarea').addEventListener('input', () => {
  $('review-word-count').textContent = `${wordCount($('review-textarea').value)} words`
})

$('clear-btn').addEventListener('click', () => {
  $('review-textarea').value = ''
  $('review-word-count').textContent = '0 words'
  $('generate-status').className = 'hidden'
})

const SAMPLE_TRANSCRIPT = `Anish: Hi Sarah, thanks for making time today. Really excited about this one.

Sarah (VP Product, NovaPay): Absolutely, Anish. We've been looking at Copods for a while — we saw the Upstox and Kristal work, very impressive.

Anish: Appreciate that. So tell me, what's the core challenge you're trying to solve right now?

Sarah: We're a B2B payments platform — we process cross-border transactions for SMEs across Southeast Asia. Our product has grown fast but honestly the UX has not kept up. Onboarding a new business takes about 40 minutes on average. We've measured it — most of the drop-off happens between step 3 and step 5 of the KYC flow. And our dashboard is a mess. Finance teams open it and call support within the first session.

Anish: That's a very clear problem statement. Is this primarily a design problem or are there product architecture constraints making it harder?

Sarah: Mostly design. The backend is solid. We have 8 front-end engineers but no design team at all. We've been shipping features designed by engineers and it shows. We've tried one freelancer before but there was no consistency.

Anish: Okay, so you need an embedded design partner, not just a one-time project. What does success look like for you in, say, 6 months?

Sarah: Onboarding time under 15 minutes. Dashboard NPS above 50 — right now it's 22. And we're launching in Indonesia in Q4 so we need everything localized and accessibility-compliant. That's a hard deadline.

Anish: Indonesia launch — that adds localization, RTL doesn't apply but you need Bahasa UI, and financial compliance UI patterns are different there. Have you accounted for that in the scope?

Sarah: Partially. That's actually another reason we need someone who understands enterprise product design, not just visual design.

Anish: Got it. Our approach would be to start with a UX audit and user research sprint — probably 2 weeks — to understand exactly where the friction is in the KYC flow and the dashboard. Then we move into design system creation so your 8 engineers have components they can actually implement consistently. And in parallel we'd tackle the onboarding redesign as the first major deliverable.

Sarah: How long is that realistically?

Anish: For the full scope — audit, design system, onboarding redesign, and dashboard v2 — I'd say 16 weeks. You'd have deployable designs within 8 weeks for the onboarding flow so your engineers can start building before we finish everything.

Sarah: That works. What about the Indonesia localization?

Anish: We can scope that as a Phase 2 parallel track starting week 10. We've done localization work before — we can review your existing flows against Bahasa UI conventions and flag compliance-specific patterns.

Sarah: Budget-wise we're looking at roughly 40 to 50 lakh for the full engagement. Is that workable?

Anish: That's in the right range. We'll put together a detailed proposal with the phase breakdown, team structure, and delivery milestones. I'll have it to you by end of this week.

Sarah: Perfect. One more thing — we'd want weekly check-ins with your team, not just milestone reviews.

Anish: That's standard for us. Weekly syncs, shared Figma, and I personally review design quality at every stage gate.

Sarah: Excellent. Let's move forward.

Anish: Great. Next step — can you share access to the current product so we can start the audit? And we'll need to sign an NDA before we share the proposal.

Sarah: I'll have our team send access and the NDA template by Thursday.

Anish: Perfect. Looking forward to it, Sarah.`

$('sample-btn').addEventListener('click', () => {
  $('review-textarea').value = SAMPLE_TRANSCRIPT
  $('review-word-count').textContent = `${wordCount(SAMPLE_TRANSCRIPT)} words`
  if (!$('client-name').value.trim()) $('client-name').value = 'NovaPay'
  $('generate-status').className = 'hidden'
})

/* ─── Intent modal logic ─────────────────────────────────── */
let _intentCallback = null

function openIntentModal(onConfirm) {
  _intentCallback = onConfirm
  $('intent-input').value = ''
  $('intent-anonymize').checked = false
  $$('#intent-modal .chip').forEach(c => c.classList.remove('active'))
  $('intent-modal').classList.remove('hidden')
  $('intent-input').focus()
}

function closeIntentModal() {
  $('intent-modal').classList.add('hidden')
  _intentCallback = null
}

// Chip click: fill textarea + mark active
$$('#intent-modal .chip').forEach(chip => {
  chip.addEventListener('click', () => {
    $$('#intent-modal .chip').forEach(c => c.classList.remove('active'))
    chip.classList.add('active')
    $('intent-input').value = chip.dataset.intent
  })
})

$('intent-cancel').addEventListener('click', closeIntentModal)
$('intent-modal').addEventListener('click', (e) => { if (e.target === $('intent-modal')) closeIntentModal() })
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeIntentModal() })

$('intent-confirm').addEventListener('click', () => {
  const intent = $('intent-input').value.trim()
  const anonymize = $('intent-anonymize').checked
  const cb = _intentCallback
  closeIntentModal()
  if (cb) cb(intent, anonymize)
})

$('generate-btn').addEventListener('click', () => {
  const transcript = $('review-textarea').value.trim()
  if (!transcript) { showGenerateStatus('error', 'Transcript is empty — record a meeting first.'); return }
  if (wordCount(transcript) < 30) { showGenerateStatus('error', `Transcript is too short (${wordCount(transcript)} words) — keep recording until you have at least 30 words.`); return }
  openIntentModal((intent, anonymize) => runGenerate(intent, anonymize))
})

async function runGenerate(deckIntent, anonymize) {
  const transcript  = $('review-textarea').value.trim()
  const clientName  = $('client-name').value.trim()
  const meetingTitle = $('meeting-title').value.trim()

  // Generation now streams into the Studio so the deck builds on screen and is
  // editable by prompt the moment it lands, instead of downloading blind.
  if (window.__studio) {
    meetingsDirty = true
    showGenerateStatus('info', 'Opening Studio…')
    window.__studio.generate({ transcript, clientName, deckIntent, meetingTitle, anonymize })
    return
  }

  $('generate-btn').disabled = true
  $('generate-btn').textContent = 'Analysing…'
  showGenerateStatus('info', 'Sending transcript to AI for analysis…')

  try {
    const meetingData = await api.analyzeTranscript(transcript, clientName, deckIntent, meetingTitle, anonymize)
    showGenerateStatus('info', 'Generating PowerPoint…')
    $('generate-btn').textContent = 'Generating…'

    const result = await api.generatePPT(meetingData)

    const saveTitle = meetingTitle || meetingData.deckTitle || meetingData.proposalTitle || clientName || meetingData.clientName || 'Untitled'
    try {
      await api.saveMeeting({
        clientName: clientName || meetingData.clientName || 'Untitled',
        meetingTitle: saveTitle,
        transcript, meetingData,
        pptFile: result.fileName,
        date: new Date().toISOString(),
      })
      meetingsDirty = true
    } catch { /* non-fatal */ }

    showGenerateStatus('success', `Done! Downloading "${result.fileName}"…`)
    api.downloadPPT(result.fileName)
    $('generate-btn').textContent = 'Generate PPT'
    $('generate-btn').disabled = false
    $('generate-btn').classList.add('btn-success')
    setTimeout(() => $('generate-btn').classList.remove('btn-success'), 3000)
  } catch (err) {
    showGenerateStatus('error', err.message)
    $('generate-btn').textContent = 'Generate PPT'
    $('generate-btn').disabled = false
  }
}

function showGenerateStatus(type, msg) {
  const el = $('generate-status')
  el.textContent = msg
  el.className = `generate-status ${type}`
}

/* ═══════════════════════════════════════════════════════════
   History view — grid cards
   ═══════════════════════════════════════════════════════════ */
let allMeetings = []

async function loadHistory() {
  const grid = $('meetings-grid')
  grid.innerHTML = '<p class="loading-text">Loading meetings…</p>'
  try {
    allMeetings = await api.getMeetings()
    meetingsDirty = false
    renderMeetings(allMeetings)
  } catch (err) {
    grid.innerHTML = `<div class="empty-state"><p>${escapeHtml(err.message)}</p></div>`
  }
}

function renderMeetings(meetings) {
  const grid = $('meetings-grid')
  if (!meetings.length) {
    grid.innerHTML = `<div class="empty-state"><p>No meetings yet</p><p style="font-size:12px;margin-top:4px">Start by recording a meeting</p></div>`
    return
  }
  grid.className = 'meetings-grid'
  grid.innerHTML = ''
  meetings.slice().reverse().forEach(m => {
    const card = document.createElement('div')
    card.className = 'meeting-card'
    const name = m.meetingTitle || m.meetingData?.deckTitle || m.meetingData?.proposalTitle || m.clientName || 'Untitled'
    const excerpt = (m.transcript || '').trim().slice(0, 120) || 'No transcript available'
    card.innerHTML = `
      <div class="card-top">
        <div class="card-avatar">${escapeHtml(initials(name))}</div>
        <div class="card-info">
          <div class="card-name">${escapeHtml(name)}</div>
          <div class="card-date">${m.date ? formatDate(m.date) : 'Unknown date'}</div>
        </div>
      </div>
      <div class="card-excerpt">${escapeHtml(excerpt)}</div>
      <div class="card-foot">
        <span class="card-meta">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          ${m.transcript ? wordCount(m.transcript) + ' words' : 'No transcript'}
        </span>
        <div class="card-actions">
          ${m.meetingData ? `<button class="icon-btn" title="Generate PPT" data-generate>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
          </button>` : ''}
          ${m.deckId ? `<button class="icon-btn" title="Open in Studio — preview and edit by prompt" data-studio="${escapeHtml(m.deckId)}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          </button>` : ''}
          ${m.pptFile ? `<button class="icon-btn" title="Download PPT" data-download="${escapeHtml(m.pptFile)}">⬇</button>` : ''}
          <button class="icon-btn danger" title="Delete" data-delete="${escapeHtml(m.id || '')}">✕</button>
        </div>
      </div>
    `
    // Clicking the card body opens the detail view
    card.querySelector('.card-top')?.addEventListener('click', () => openMeeting(m))
    card.querySelector('.card-excerpt')?.addEventListener('click', () => openMeeting(m))

    card.querySelector('[data-generate]')?.addEventListener('click', e => {
      e.stopPropagation()
      const btn = e.currentTarget
      if (btn.disabled) return
      const pptIcon = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`
      openIntentModal(async (intent) => {
        btn.disabled = true
        btn.title = 'Generating…'
        btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>`
        try {
          let meetingData = m.meetingData
          if (intent && m.transcript) {
            meetingData = await api.analyzeTranscript(m.transcript, m.clientName, intent)
          }
          const result = await api.generatePPT(meetingData)
          revealOrDownload(result)
          btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`
          btn.title = 'Revealed in Finder'
          setTimeout(() => { btn.disabled = false; btn.title = 'Generate PPT'; btn.innerHTML = pptIcon }, 3000)
        } catch (err) {
          btn.disabled = false
          btn.title = 'Generate PPT (failed — retry)'
          btn.innerHTML = pptIcon
          alert(`PPT generation failed: ${err.message}`)
        }
      })
    })

    card.querySelector('[data-download]')?.addEventListener('click', e => { e.stopPropagation(); api.downloadPPT(e.currentTarget.dataset.download) })
    card.querySelector('[data-studio]')?.addEventListener('click', e => {
      e.stopPropagation()
      window.__studio?.open(e.currentTarget.dataset.studio)
    })
    card.querySelector('[data-delete]')?.addEventListener('click', async e => { e.stopPropagation()
      if (!confirm('Delete this meeting?')) return
      const id = e.currentTarget.dataset.delete
      try {
        await api.deleteMeeting(id)
        allMeetings = allMeetings.filter(x => x.id !== id)
        renderMeetings(filterMeetings($('search-input').value))
      } catch (err) { alert(`Delete failed: ${err.message}`) }
    })
    grid.appendChild(card)
  })
}

function filterMeetings(q) {
  const lq = (q || '').toLowerCase()
  if (!lq) return allMeetings
  return allMeetings.filter(m => (m.clientName || '').toLowerCase().includes(lq) || (m.date || '').includes(lq))
}

$('search-input').addEventListener('input', e => renderMeetings(filterMeetings(e.target.value)))

/* ═══════════════════════════════════════════════════════════
   Meeting detail view
   ═══════════════════════════════════════════════════════════ */
let currentMeeting = null

function openMeeting(m) {
  currentMeeting = m

  // Toolbar
  const title = m.meetingTitle || m.meetingData?.deckTitle || m.meetingData?.proposalTitle || m.meetingData?.meetingTitle || m.clientName || 'Meeting'
  $('detail-title').textContent = title

  const wc   = wordCount(m.transcript || '')
  const mins  = Math.round(wc / 130) // ~130 wpm average speaking rate
  const dateStr = m.date ? formatDate(m.date) : ''
  $('detail-meta').textContent = [dateStr, mins > 0 ? `${mins} min` : ''].filter(Boolean).join(' · ')

  // PPT download button
  if (m.pptFile) {
    $('detail-download-btn').classList.remove('hidden')
    $('detail-download-btn').onclick = () => api.downloadPPT(m.pptFile)
  } else {
    $('detail-download-btn').classList.add('hidden')
  }

  // Generate PPT button — shown whenever meetingData is available
  const genBtn = $('detail-generate-btn')
  if (m.meetingData) {
    genBtn.classList.remove('hidden')
    genBtn.textContent = 'Generate PPT'
    genBtn.disabled = false
    genBtn.onclick = () => {
      openIntentModal(async (intent) => {
        genBtn.disabled = true
        try {
          let meetingData = m.meetingData
          if (intent && m.transcript) {
            genBtn.textContent = 'Analysing…'
            meetingData = await api.analyzeTranscript(m.transcript, m.clientName, intent)
          }
          genBtn.textContent = 'Generating…'
          const result = await api.generatePPT(meetingData)
          revealOrDownload(result)
          genBtn.textContent = '✓ Revealed in Finder'
          setTimeout(() => { genBtn.textContent = 'Generate PPT'; genBtn.disabled = false }, 3000)
        } catch (err) {
          genBtn.textContent = 'Generate PPT'
          genBtn.disabled = false
          alert(`PPT generation failed: ${err.message}`)
        }
      })
    }
  } else {
    genBtn.classList.add('hidden')
  }

  // Copy button
  $('detail-copy-btn').onclick = () => {
    navigator.clipboard.writeText(m.transcript || '').then(() => {
      $('detail-copy-btn').innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Copied`
      setTimeout(() => {
        $('detail-copy-btn').innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy`
      }, 2000)
    })
  }

  // Build transcript entries
  renderDetailTranscript(m.transcript || '', '')

  // Build summary
  renderDetailSummary(m.meetingData)

  // Build sidebar panels
  renderDetailHighlights(m)
  renderDetailTopics(m.meetingData)

  // Reset to transcript tab
  switchDetailTab('transcript')
  $('detail-search').value = ''

  // Show view — use navigate so currentTab is set correctly
  currentTab = 'detail'
  $$('.nav-item').forEach(b => b.classList.remove('active'))
  $$('.view').forEach(v => v.classList.remove('active'))
  $('view-detail').classList.add('active')
}

function chunkTranscript(text) {
  if (!text.trim()) return []
  // Split into sentence groups (~3 sentences each)
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text]
  const chunks = []
  for (let i = 0; i < sentences.length; i += 3) {
    chunks.push(sentences.slice(i, i + 3).join('').trim())
  }
  return chunks.filter(Boolean)
}

function secsToTimestamp(secs) {
  const m = String(Math.floor(secs / 60)).padStart(2, '0')
  const s = String(Math.floor(secs % 60)).padStart(2, '0')
  return `${m}:${s}`
}

function renderDetailTranscript(fullText, query) {
  const container = $('detail-transcript-entries')
  const chunks = chunkTranscript(fullText)

  if (!chunks.length) {
    container.innerHTML = '<p class="no-summary">No transcript available for this meeting.</p>'
    return
  }

  const q = (query || '').toLowerCase().trim()
  let wordsConsumed = 0
  const WPS = 130 / 60  // words per second

  container.innerHTML = ''
  chunks.forEach(chunk => {
    const startWords = wordsConsumed
    const startSec = wordsConsumed / WPS
    wordsConsumed += chunk.trim().split(/\s+/).filter(Boolean).length

    const entry = document.createElement('div')
    entry.className = 'transcript-entry'
    entry.dataset.wordsStart = String(startWords)

    // Always escape first, then apply highlight markers on the escaped string
    const safe = escapeHtml(chunk)
    const display = q
      ? safe.replace(new RegExp(`(${escapeRegex(escapeHtml(q))})`, 'gi'), '<mark>$1</mark>')
      : safe

    const matchesSearch = !q || chunk.toLowerCase().includes(q)
    if (!matchesSearch) entry.classList.add('entry-hidden')

    entry.innerHTML = `
      <div class="entry-header">
        <span class="ts-badge">${secsToTimestamp(startSec)}</span>
      </div>
      <div class="entry-text">${display}</div>
    `
    container.appendChild(entry)
  })

  const visible = container.querySelectorAll('.transcript-entry:not(.entry-hidden)').length
  if (visible === 0 && q) {
    container.innerHTML = `<p class="no-summary">No results for "${escapeHtml(q)}"</p>`
  }
}

function renderDetailSummary(meetingData) {
  const container = $('detail-summary-content')
  if (!meetingData) {
    container.innerHTML = '<p class="no-summary">No AI summary available for this meeting — it may have been saved without analysis.</p>'
    return
  }

  let html = ''

  if (meetingData.executiveSummary) {
    html += `
      <div class="summary-section">
        <p class="summary-section-title">Executive Summary</p>
        <p class="summary-executive">${escapeHtml(meetingData.executiveSummary)}</p>
      </div>`
  }

  // Proposal format: clientNeeds
  if (meetingData.clientNeeds?.length) {
    const needsHtml = meetingData.clientNeeds.map(n => `
      <div class="topic-block">
        <p class="topic-title">${escapeHtml(n.title)}</p>
        ${n.description ? `<p class="topic-desc">${escapeHtml(n.description)}</p>` : ''}
      </div>`).join('')
    html += `
      <div class="summary-section">
        <p class="summary-section-title">Client Challenges</p>
        ${needsHtml}
      </div>`
  }

  // Proposal format: proposedSolutions
  if (meetingData.proposedSolutions?.length) {
    const solsHtml = meetingData.proposedSolutions.map(s => `
      <div class="topic-block">
        <p class="topic-title">${escapeHtml(s.title)}</p>
        ${s.subtitle ? `<p class="topic-desc">${escapeHtml(s.subtitle)}</p>` : ''}
        <ul class="topic-points">
          ${(s.keyPoints || []).map(kp => `<li>${escapeHtml(kp)}</li>`).join('')}
        </ul>
      </div>`).join('')
    html += `
      <div class="summary-section">
        <p class="summary-section-title">Proposed Solutions</p>
        ${solsHtml}
      </div>`
  }

  // Legacy format: topics
  if (!meetingData.proposedSolutions?.length && meetingData.topics?.length) {
    const topicsHtml = meetingData.topics.map(t => `
      <div class="topic-block">
        <p class="topic-title">${escapeHtml(t.title)}</p>
        <ul class="topic-points">
          ${(t.keyPoints || []).map(kp => `<li>${escapeHtml(kp)}</li>`).join('')}
        </ul>
      </div>`).join('')
    html += `
      <div class="summary-section">
        <p class="summary-section-title">Topics Covered</p>
        ${topicsHtml}
      </div>`
  }

  // Next steps (proposal) or action items (legacy)
  const steps = meetingData.nextSteps?.length ? meetingData.nextSteps : (meetingData.actionItems || [])
  if (steps.length) {
    const stepsHtml = steps.map(a => `
      <div class="action-item">
        <div class="action-item-dot"></div>
        <span class="action-text">${escapeHtml(a.item)}</span>
        ${a.owner ? `<span class="action-owner">${escapeHtml(a.owner)}</span>` : ''}
      </div>`).join('')
    html += `
      <div class="summary-section">
        <p class="summary-section-title">Next Steps</p>
        ${stepsHtml}
      </div>`
  }

  container.innerHTML = html || '<p class="no-summary">No summary data found.</p>'
}

// Tab switching
$$('.detail-tab').forEach(tab => {
  tab.addEventListener('click', () => switchDetailTab(tab.dataset.detailTab))
})

function switchDetailTab(name) {
  $$('.detail-tab').forEach(t => t.classList.toggle('active', t.dataset.detailTab === name))
  $('detail-transcript-pane').classList.toggle('hidden', name !== 'transcript')
  $('detail-summary-pane').classList.toggle('hidden',    name !== 'summary')
}

// Transcript search inside detail view
$('detail-search').addEventListener('input', e => {
  if (!currentMeeting) return
  renderDetailTranscript(currentMeeting.transcript || '', e.target.value)
})

// Back button
$('detail-back-btn').addEventListener('click', () => {
  currentMeeting = null
  navigate('history')
})

// ── Detail title inline edit ───────────────────────────────
$('detail-title-edit-btn').addEventListener('click', () => {
  const titleEl = $('detail-title')
  const input   = $('detail-title-input')
  input.value   = currentMeeting?.meetingTitle || titleEl.textContent
  titleEl.classList.add('hidden')
  $('detail-title-edit-btn').classList.add('hidden')
  input.classList.remove('hidden')
  input.focus()
  input.select()
})

async function commitTitleEdit() {
  const titleEl = $('detail-title')
  const input   = $('detail-title-input')
  const newTitle = input.value.trim()
  if (newTitle && newTitle !== titleEl.textContent && currentMeeting) {
    titleEl.textContent = newTitle
    currentMeeting.meetingTitle = newTitle
    const idx = allMeetings.findIndex(m => m.id === currentMeeting.id)
    if (idx !== -1) allMeetings[idx].meetingTitle = newTitle
    api.updateMeeting(currentMeeting.id, { meetingTitle: newTitle }).catch(() => {})
  }
  input.classList.add('hidden')
  titleEl.classList.remove('hidden')
  $('detail-title-edit-btn').classList.remove('hidden')
}

$('detail-title-input').addEventListener('blur', commitTitleEdit)
$('detail-title-input').addEventListener('keydown', e => {
  if (e.key === 'Enter')  { e.preventDefault(); $('detail-title-input').blur() }
  if (e.key === 'Escape') {
    $('detail-title-input').classList.add('hidden')
    $('detail-title').classList.remove('hidden')
    $('detail-title-edit-btn').classList.remove('hidden')
  }
})

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

/* ─── Detail sidebar: highlights + topics ─────────────────── */
const HIGHLIGHTS_MAX = 5

function renderDetailHighlights(meeting) {
  const list       = $('detail-highlights-list')
  const toggleBtn  = $('highlights-toggle')
  const topics = meeting.meetingData?.proposedSolutions || meeting.meetingData?.topics || []

  if (!topics.length || !meeting.transcript) {
    list.innerHTML = '<p class="no-summary" style="font-size:12px;padding:6px 0">No highlights available</p>'
    toggleBtn.classList.add('hidden')
    return
  }

  const totalWords = wordCount(meeting.transcript)
  const WPS        = 130 / 60

  // Distribute topic titles evenly across the transcript duration
  const highlights = topics.map((t, i) => {
    const frac  = topics.length === 1 ? 0.05 : (i / (topics.length - 1)) * 0.88 + 0.05
    const words = Math.round(frac * totalWords)
    return { ts: secsToTimestamp(words / WPS), label: t.title, words }
  })

  function buildItems(items) {
    return items.map(h =>
      `<div class="highlight-item" data-words="${h.words}">
         <span class="highlight-ts">${escapeHtml(h.ts)}</span>
         <span class="highlight-label">${escapeHtml(h.label)}</span>
       </div>`
    ).join('')
  }

  let expanded = false

  function render() {
    list.innerHTML = buildItems(expanded ? highlights : highlights.slice(0, HIGHLIGHTS_MAX))
    list.querySelectorAll('.highlight-item').forEach(item => {
      item.addEventListener('click', () => scrollToTranscriptWord(parseInt(item.dataset.words)))
    })
  }

  render()

  if (highlights.length > HIGHLIGHTS_MAX) {
    toggleBtn.textContent = `View all highlights (${highlights.length})`
    toggleBtn.classList.remove('hidden')
    toggleBtn.onclick = () => {
      expanded = !expanded
      render()
      toggleBtn.textContent = expanded ? 'Show less' : `View all highlights (${highlights.length})`
    }
  } else {
    toggleBtn.classList.add('hidden')
  }
}

function scrollToTranscriptWord(targetWords) {
  const entries = document.querySelectorAll('.transcript-entry')
  let best = entries[0]
  let bestDist = Infinity
  entries.forEach(entry => {
    const ws   = parseInt(entry.dataset.wordsStart || '0')
    const dist = Math.abs(ws - targetWords)
    if (dist < bestDist) { bestDist = dist; best = entry }
  })
  if (!best) return
  best.scrollIntoView({ behavior: 'smooth', block: 'start' })
  best.style.transition = 'background .25s'
  best.style.background = 'var(--brand-accent-bg)'
  setTimeout(() => { best.style.background = '' }, 1300)
}

function renderDetailTopics(meetingData) {
  const container = $('detail-topics-chips')
  const topics    = meetingData?.topics || []
  if (!topics.length) {
    container.innerHTML = '<p class="no-summary" style="font-size:12px;padding:4px 0">No topics</p>'
    return
  }
  container.innerHTML = topics.map((t, i) =>
    `<span class="topic-chip${i === 0 ? ' primary' : ''}">${escapeHtml(t.title)}</span>`
  ).join('')
}

/* ═══════════════════════════════════════════════════════════
   Settings view
   ═══════════════════════════════════════════════════════════ */
/**
 * Settings doubles as the setup check. On a freshly installed machine the most
 * likely problem is a missing model or a stopped Ollama, so show that here with
 * the exact command to fix it rather than letting the first deck fail.
 */
async function loadSettings() {
  $('provider-loading').classList.remove('hidden')
  $('provider-info').classList.add('hidden')
  try {
    const s = await apiFetch('/studio/status')
    const p = s.provider || {}
    $('provider-name').textContent = p.provider || '—'
    $('provider-model').textContent = p.model || ''

    const rows = []
    const inf = s.inference || {}
    rows.push(inf.up
      ? { ok: true, name: 'Model runtime', detail: `running at ${inf.host || '127.0.0.1:11434'}` }
      : { ok: false, name: 'Model runtime', detail: 'not running', fix: 'ollama serve' })

    if (inf.up) {
      rows.push(inf.hasGenerate
        ? { ok: true, name: 'Deck model', detail: p.model }
        : { ok: false, name: 'Deck model', detail: 'not installed', fix: `ollama pull ${p.model}` })
      rows.push(s.embedReady
        ? { ok: true, name: 'Retrieval model', detail: 'nomic-embed-text' }
        : { ok: false, name: 'Retrieval model', detail: 'not installed', fix: 'ollama pull nomic-embed-text' })
    }

    const t = s.transcription || {}
    if (t.ready) {
      rows.push({ ok: true, name: 'Transcription', detail: `whisper.cpp ${t.model}` })
    } else {
      const missing = []
      if (!t.binaryPresent) missing.push('whisper-cpp')
      if (!t.ffmpegPresent) missing.push('ffmpeg')
      if (missing.length) {
        rows.push({ ok: false, name: 'Transcription', detail: `missing ${missing.join(' and ')}`,
                    fix: `brew install ${missing.join(' ')}` })
      } else if (!t.modelPresent) {
        rows.push({ ok: false, name: 'Transcription', detail: 'speech model not downloaded',
                    fix: `curl -L -o "${t.modelPath}" https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${t.model}.bin` })
      }
    }

    const c = s.counts || {}
    rows.push({ ok: true, name: 'Local library', detail:
      `${c.meetings || 0} meetings · ${c.decks || 0} decks · ${c.chunks || 0} indexed chunks` })

    const list = $('setup-list')
    list.innerHTML = rows.map(r => `
      <li>
        <span class="s-mark ${r.ok ? 's-ok' : 's-bad'}">${r.ok ? '✓' : '✗'}</span>
        <span><span class="s-name">${escapeHtml(r.name)}</span>
        <span class="s-detail">${escapeHtml(r.detail || '')}</span>
        ${r.fix ? `<code class="s-fix">${escapeHtml(r.fix)}</code>` : ''}</span>
      </li>`).join('')

    const bad = rows.filter(r => !r.ok).length
    $('provider-dot').className = `status-dot ${bad ? 'amber' : 'green'}`
    $('setup-hint').textContent = bad
      ? `${bad} thing${bad > 1 ? 's' : ''} still to set up. Run the commands above in Terminal, then reopen Settings.`
      : 'Everything is ready.'

    const badge = $('privacy-badge')
    badge.textContent = s.offline ? 'OFFLINE' : 'CLOUD ENABLED'
    badge.className = `privacy-badge ${s.offline ? 'on' : 'off'}`

    $('provider-loading').classList.add('hidden')
    $('provider-info').classList.remove('hidden')
  } catch (err) {
    $('provider-loading').textContent = `Could not reach the local server — ${err.message}`
  }
}

const templateDrop  = $('template-drop')
const templateFile  = $('template-file')
const templateLabel = $('template-label')
const uploadStatus  = $('upload-status')

templateDrop.addEventListener('click', () => templateFile.click())
templateDrop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') templateFile.click() })
templateDrop.addEventListener('dragover', e => { e.preventDefault(); templateDrop.style.borderColor = 'var(--brand-accent)' })
templateDrop.addEventListener('dragleave', () => { templateDrop.style.borderColor = '' })
templateDrop.addEventListener('drop', e => {
  e.preventDefault(); templateDrop.style.borderColor = ''
  const file = e.dataTransfer.files[0]; if (file) handleTemplateUpload(file)
})
templateFile.addEventListener('change', e => {
  const file = e.target.files[0]; if (file) handleTemplateUpload(file); templateFile.value = ''
})

async function handleTemplateUpload(file) {
  if (!file.name.endsWith('.pptx')) { showUploadStatus('error', 'Please upload a .pptx file'); return }
  templateDrop.classList.add('uploading')
  templateLabel.textContent = `Uploading ${file.name}…`
  uploadStatus.className = 'hidden'
  try {
    await api.uploadTemplate(file)
    templateLabel.textContent = file.name
    showUploadStatus('success', `✓ Template uploaded — ${file.name}`)
  } catch (err) {
    templateLabel.textContent = 'Click or drag to upload .pptx'
    showUploadStatus('error', err.message)
  } finally {
    templateDrop.classList.remove('uploading')
  }
}

function showUploadStatus(type, msg) {
  uploadStatus.textContent = msg
  uploadStatus.className = `upload-status ${type}`
}

/* ═══════════════════════════════════════════════════════════
   Google Calendar
   ═══════════════════════════════════════════════════════════ */
const calConnectBtn    = document.getElementById('cal-connect-btn')
const calDisconnectBtn = document.getElementById('cal-disconnect-btn')
const calDisconnected  = document.getElementById('cal-disconnected')
const calConnected     = document.getElementById('cal-connected')
const calMeetingsList  = document.getElementById('cal-meetings-list')
const calEmpty         = document.getElementById('cal-empty')

let selectedCalEvent = null

// In offline mode the meeting list comes from the local macOS Calendar over
// AppleScript, so there is no account to connect and nothing goes to Google.
let calLocalMode = false

async function initCalendar() {
  try {
    const { connected, offline } = await api.calStatus()
    calLocalMode = !!offline && !!window.electronAPI?.localCalendar
    if (calLocalMode) {
      setCalConnected(true)
      loadCalMeetings()
      return
    }
    setCalConnected(connected)
    if (connected) loadCalMeetings()
  } catch { /* server may not have calendar configured */ }
}

function setCalConnected(connected) {
  calDisconnected.classList.toggle('hidden', connected)
  calConnected.classList.toggle('hidden', !connected)
  // Nothing to disconnect from when reading the local Calendar.
  calDisconnectBtn.classList.toggle('hidden', !connected || calLocalMode)
}

async function loadCalMeetings() {
  try {
    let events
    if (calLocalMode) {
      const r = await window.electronAPI.localCalendar()
      if (!r.ok) {
        // macOS prompts once on first use. A refusal lands here; the toggle is
        // under Automation (Apple events), not Calendars.
        calEmpty.textContent = r.denied
          ? 'Allow Codeck to control Calendar in System Settings → Privacy & Security → Automation, then reopen Codeck.'
          : `Could not read the Calendar app: ${r.error}`
        calEmpty.classList.remove('hidden')
        calMeetingsList.innerHTML = ''
        return
      }
      events = r.events
    } else {
      ({ events } = await api.calUpcoming())
    }
    calMeetingsList.innerHTML = ''
    if (!events?.length) {
      calEmpty.classList.remove('hidden')
      return
    }
    calEmpty.classList.add('hidden')
    events.forEach(ev => {
      const card = document.createElement('div')
      card.className = 'cal-meeting-card'
      card.dataset.eventId = ev.id

      const now = new Date()
      const start = new Date(ev.start)
      const end = new Date(ev.end)
      const isLive = now >= start && now <= end
      const isPast = now > end
      const minsUntil = Math.round((start - now) / 60000)

      const startLabel = start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      const endLabel   = end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

      const timeLabel = isLive
        ? `<span class="cal-meeting-live"></span>Live now · ${endLabel}`
        : isPast ? `${startLabel} – ${endLabel}`
        : minsUntil < 60 ? `In ${minsUntil} min · ${startLabel}`
        : startLabel

      const clientLabel = ev.clientName ? ` · ${ev.clientName}` : ''

      if (isPast) card.classList.add('past')

      card.innerHTML = `
        <div class="cal-meeting-title">${ev.title}</div>
        <div class="cal-meeting-meta">${timeLabel}${clientLabel}</div>
      `
      if (!isPast) card.addEventListener('click', () => selectCalEvent(ev, card))
      calMeetingsList.appendChild(card)
    })
  } catch (err) {
    console.error('Calendar fetch failed:', err.message)
  }
}

function selectCalEvent(ev, card) {
  document.querySelectorAll('.cal-meeting-card').forEach(c => c.classList.remove('active'))
  if (selectedCalEvent?.id === ev.id) {
    selectedCalEvent = null
    $('meeting-title').value = ''
    return
  }
  card.classList.add('active')
  selectedCalEvent = ev
  if (ev.title)      $('meeting-title').value = ev.title
  if (ev.clientName) $('client-name').value   = ev.clientName
}

calConnectBtn?.addEventListener('click', async () => {
  const errEl = document.getElementById('cal-error')
  errEl?.classList.add('hidden')
  try {
    const { url } = await api.calAuthUrl()
    if (window.electronAPI?.openExternal) {
      window.electronAPI.openExternal(url)
    } else {
      window.open(url, '_blank')
    }
    // Poll for connection every 3s for up to 2 minutes
    let attempts = 0
    const poll = setInterval(async () => {
      attempts++
      if (attempts > 40) { clearInterval(poll); return }
      try {
        const { connected } = await api.calStatus()
        if (connected) {
          clearInterval(poll)
          setCalConnected(true)
          loadCalMeetings()
        }
      } catch {}
    }, 3000)
  } catch (err) {
    console.error('Calendar auth failed:', err.message)
    if (errEl) {
      errEl.textContent = err.message.includes('not configured')
        ? 'Google Calendar isn\'t set up — add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to server/.env, then restart.'
        : `Couldn't connect: ${err.message}`
      errEl.classList.remove('hidden')
    }
  }
})

calDisconnectBtn?.addEventListener('click', async () => {
  await api.calDisconnect().catch(() => {})
  setCalConnected(false)
  selectedCalEvent = null
  calMeetingsList.innerHTML = ''
})

/* ═══════════════════════════════════════════════════════════
   Boot
   ═══════════════════════════════════════════════════════════ */
navigate('record')
initCalendar()
