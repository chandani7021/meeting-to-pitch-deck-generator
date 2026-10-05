/**
 * Cross-deck client memory.
 *
 * After a deck is generated we extract durable facts about the client so the
 * next meeting with them starts warm. Stored as STRUCTURED fields rather than
 * prose, and surfaced in the UI for editing — auto-accumulated model memory
 * compounds its own errors, and one hallucinated "budget: $200k" would
 * otherwise quietly poison every future deck for that client.
 */
import { DOSSIER_SCHEMA } from './deckSchema.js'
import { getDossier, saveDossier } from './db.js'

const EXTRACT_RULES = `Extract only durable facts about the CLIENT from this meeting — things that will still be true at the next meeting.
Include a fact only if the transcript states it. Omit anything you are unsure about; an empty field is correct when nothing was said.
Do not include anything about the vendor (Copods), and do not restate the deck.`

export async function extractDossier(provider, { transcript, deck, model }) {
  const { data } = await provider.complete({
    system: EXTRACT_RULES,
    user: `CLIENT: ${deck.clientName || 'unknown'} (${deck.clientIndustry || 'industry unknown'})\n\nTRANSCRIPT\n${(transcript || '').slice(0, 6000)}`,
    schema: DOSSIER_SCHEMA,
    model, temperature: 0.1, label: 'dossier',
  })
  return data
}

/**
 * Merges new facts into the stored dossier. Union for lists, newest-wins for
 * scalars, and every entry keeps its provenance so the UI can show where a
 * fact came from and the user can delete it.
 */
export function mergeDossier(existing, incoming, meetingId) {
  const base = existing?.facts || {}
  const out = { ...base }
  const stamp = { meetingId, at: new Date().toISOString() }

  for (const key of ['goals', 'constraints', 'decisions']) {
    const prev = base[key] || []
    const add = (incoming[key] || []).filter(v => v && !prev.some(p => norm(p.value ?? p) === norm(v)))
    out[key] = [...prev, ...add.map(value => ({ value, ...stamp }))]
  }

  const prevPeople = base.stakeholders || []
  const addPeople = (incoming.stakeholders || [])
    .filter(s => s?.name && !prevPeople.some(p => norm(p.name) === norm(s.name)))
    .map(s => ({ ...s, ...stamp }))
  out.stakeholders = [...prevPeople, ...addPeople]

  for (const key of ['industry', 'budgetSignal', 'timeline']) {
    if (incoming[key]) out[key] = { value: incoming[key], ...stamp }
  }
  return out
}

const norm = s => String(s ?? '').trim().toLowerCase()

/** Flattens the stamped shape back to plain values for prompt injection. */
export function flattenDossier(facts) {
  if (!facts) return null
  const val = v => (v && typeof v === 'object' && 'value' in v ? v.value : v)
  return {
    industry: val(facts.industry) || null,
    budgetSignal: val(facts.budgetSignal) || null,
    timeline: val(facts.timeline) || null,
    goals: (facts.goals || []).map(val).filter(Boolean),
    constraints: (facts.constraints || []).map(val).filter(Boolean),
    decisions: (facts.decisions || []).map(val).filter(Boolean),
    stakeholders: (facts.stakeholders || []).map(s => ({ name: s.name, role: s.role })).filter(s => s.name),
  }
}

export async function updateDossierForClient(db, provider, { clientId, meetingId, transcript, deck, model }) {
  if (!clientId) return null
  try {
    const incoming = await extractDossier(provider, { transcript, deck, model })
    const merged = mergeDossier(getDossier(db, clientId), incoming, meetingId)
    saveDossier(db, clientId, merged)
    return merged
  } catch (err) {
    // Never fail a deck because memory extraction failed.
    console.warn('[dossier] extraction skipped:', err.message)
    return null
  }
}
