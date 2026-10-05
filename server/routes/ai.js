import { Router } from 'express'
import fs from 'fs'
import path from 'path'
import { buildProposalPrompt } from '../lib/prompt.js'

const router = Router()

const VALID_PROVIDERS = ['local', 'gemini', 'groq', 'claude', 'openai']
const CLOUD_PROVIDERS = ['gemini', 'groq', 'claude', 'openai']

const PROFILE_PATH = path.join(
  process.env.DATA_DIR || path.join(process.env.HOME, '.codeck'),
  'copods-profile.json'
)

function loadCopods() {
  try {
    if (fs.existsSync(PROFILE_PATH)) {
      return JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf8'))
    }
  } catch {}
  return null
}

async function getProvider() {
  const name = process.env.AI_PROVIDER || 'local'
  if (!VALID_PROVIDERS.includes(name)) {
    throw new Error(`Unknown AI_PROVIDER "${name}". Valid options: ${VALID_PROVIDERS.join(', ')}`)
  }
  // Offline mode is the default. A cloud provider would send the transcript off
  // the machine, so refuse rather than leak quietly.
  if (process.env.OFFLINE_MODE !== '0' && CLOUD_PROVIDERS.includes(name)) {
    throw new Error(`AI_PROVIDER="${name}" sends data to a remote API, but OFFLINE_MODE is on. Use AI_PROVIDER=local, or set OFFLINE_MODE=0 to explicitly allow cloud calls.`)
  }
  const mod = await import(`../lib/providers/${name}.js`)
  return mod
}

// Normalize legacy field names from older AI responses
function normalizeData(data) {
  const d = { ...data }

  // topics → proposedSolutions (legacy format compat)
  if (!d.proposedSolutions?.length && d.topics?.length > 0) {
    d.proposedSolutions = d.topics.map(t => ({
      title: t.title, subtitle: t.subtitle || null, keyPoints: t.keyPoints || [], stat: t.stat || null,
    }))
    delete d.topics
  }

  // actionItems → nextSteps (legacy format compat)
  if (!d.nextSteps?.length && d.actionItems?.length > 0) {
    d.nextSteps = d.actionItems.map(a => ({ item: a.item, owner: a.owner || null, dueDate: a.dueDate || null }))
    delete d.actionItems
  }

  // deckTitle is the canonical field; proposalTitle/meetingTitle are legacy aliases
  if (!d.deckTitle) {
    d.deckTitle = d.proposalTitle || d.meetingTitle || d.deckTitle
    delete d.proposalTitle
    delete d.meetingTitle
  }

  d.webFindings = d.webFindings || []
  return d
}

// Build a map of real names → generic placeholders for the anonymize filter.
// Defense-in-depth: the prompt already instructs the model not to use real names,
// this catches anything that slips through (e.g. names copied verbatim from the transcript).
function buildRedactionMap(copods, liveClientName, liveClientIndustry) {
  const map = new Map()
  const addName = (name, placeholder) => {
    const clean = name?.replace(/\s*\(.*?\)/g, '').trim()
    if (clean && clean.length > 1) map.set(clean, placeholder)
  }
  copods?.notableClients?.forEach(n => addName(n, 'a partner organization'))
  copods?.caseStudies?.forEach(cs => {
    addName(cs.client, 'the client')
    addName(cs.title, 'the project')
  })
  copods?.testimonials?.forEach(t => addName(t.company, 'a partner organization'))
  if (liveClientName) {
    map.set(liveClientName, liveClientIndustry ? `the ${liveClientIndustry} client` : 'the client')
  }
  return map
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function redactText(str, map) {
  let out = str
  for (const [name, placeholder] of map) {
    out = out.replace(new RegExp(`\\b${escapeRegExp(name)}\\b`, 'gi'), placeholder)
  }
  return out
}

function redactDeep(value, map) {
  if (typeof value === 'string') return redactText(value, map)
  if (Array.isArray(value)) return value.map(v => redactDeep(v, map))
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value)) out[key] = redactDeep(value[key], map)
    return out
  }
  return value
}

// POST /api/analyze
router.post('/analyze', async (req, res) => {
  const { transcript, clientName, deckIntent, meetingTitle, anonymize } = req.body
  if (!transcript?.trim()) {
    return res.status(400).json({ error: 'transcript is required' })
  }
  const wordCount = transcript.trim().split(/\s+/).filter(Boolean).length
  if (wordCount < 30) {
    return res.status(400).json({ error: `Transcript too short (${wordCount} words). Record at least 30 words for a meaningful deck.` })
  }

  try {
    const copods = loadCopods()
    const systemPrompt = buildProposalPrompt(copods, deckIntent, meetingTitle, anonymize)

    const provider = await getProvider()
    const raw = await provider.analyzeTranscript(transcript, clientName, systemPrompt)

    let meetingData = normalizeData(raw)
    if (anonymize) {
      const redactionMap = buildRedactionMap(copods, clientName, meetingData.clientIndustry)
      meetingData = redactDeep(meetingData, redactionMap)
      meetingData.clientName = meetingData.clientIndustry
        ? `Confidential ${meetingData.clientIndustry} Client`
        : 'Confidential Client'
    }
    res.json(meetingData)
  } catch (err) {
    console.error('AI analysis error:', err)
    res.status(500).json({ error: err.message })
  }
})

// GET /api/provider — returns active provider info
router.get('/provider', async (req, res) => {
  try {
    const provider = await getProvider()
    res.json(provider.providerInfo)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

export default router
