/**
 * Decomposed deck generation.
 *
 * One monolithic call asks a small local model for ~1,300 tokens in a single
 * shot: minutes of silence on CPU, and quality that degrades badly the further
 * it gets from the prompt. Instead we make four small focused calls:
 *
 *   frame (~120 tok) → clientNeeds (~140) → proposedSolutions (~180) → closing (~160)
 *
 * This wins three ways at once:
 *  - each call is single-purpose, which a 3-4B model handles far better;
 *  - sections stream into the preview as they land, so the user watches the deck
 *    build instead of staring at a spinner;
 *  - a failure costs one section, not the whole deck.
 *
 * whyCopods (measured at 53% of all output tokens) never reaches the model —
 * caseStudies.js builds it from the profile.
 */
import { buildGenerationContext } from './context.js'
import { SECTION_SCHEMAS } from './deckSchema.js'
import { buildWhyCopods, buildEngagementModel } from './caseStudies.js'

const SECTIONS = ['frame', 'clientNeeds', 'proposedSolutions', 'closing']

/** Intents that should carry the Copods pitch (profile + case studies). */
function wantsProfile(deckIntent) {
  const s = (deckIntent || '').toLowerCase()
  if (!s.trim()) return true
  if (s.includes('do not include') || s.includes("don't include") || s.includes('do not use the company')) return false
  return ['proposal', 'pitch', 'case stud', 'our services', 'track record', 'why us'].some(k => s.includes(k))
}

/**
 * @param onProgress {(e:{stage,section?,deck?,timing?,report?}) => void}
 */
export async function generateDeck(db, profile, provider, opts, onProgress = () => {}) {
  const {
    transcript, clientName, clientIndustry, deckIntent, meetingTitle,
    anonymize = false, clientId = null, model,
  } = opts

  const deck = {
    orgName: profile?.company?.name || 'Copods',
    meetingDate: new Date().toISOString().slice(0, 10),
    webFindings: [],
  }
  const timings = []
  let ctxReport = null
  let caseStudyHits = []

  // Retrieve once for the whole deck. Beyond saving three embedding calls, it
  // keeps the evidence block identical so the cached prefix holds.
  let sharedHits = null

  for (const section of SECTIONS) {
    onProgress({ stage: 'section:start', section })

    const ctx = await buildGenerationContext(db, profile, {
      transcript, clientName, clientIndustry, deckIntent, meetingTitle,
      anonymize, clientId, section, hits: sharedHits,
    })
    if (section === 'frame') {
      ctxReport = ctx.report
      caseStudyHits = ctx.caseStudyHits
      sharedHits = ctx.hits
    }

    // Later sections see the frame so names and tone stay consistent. This goes
    // in the USER turn, after the shared prefix, so it costs a few tokens of
    // prefill rather than invalidating the cache for the whole transcript.
    const priorFrame = section === 'frame' ? '' :
      `\n\nDECK SO FAR (stay consistent with this)\n${JSON.stringify({
        deckType: deck.deckType, clientName: deck.clientName,
        clientIndustry: deck.clientIndustry, deckTitle: deck.deckTitle,
      })}`

    const { data, timing } = await provider.complete({
      system: ctx.prompt,
      user: `${ctx.task}\n\nReturn the JSON for this section now.${priorFrame}`,
      schema: SECTION_SCHEMAS[section],
      model,
      label: `generate:${section}`,
    })
    Object.assign(deck, data)
    timings.push(timing)
    onProgress({ stage: 'section:done', section, deck: { ...deck }, timing })
  }

  // ── Deterministic blocks: no model tokens spent ──────────────────────────
  const isProposal = deck.deckType === 'proposal' || wantsProfile(deckIntent)
  if (isProposal) {
    deck.whyCopods = buildWhyCopods(profile, caseStudyHits, { k: 3, anonymize })
    if (!deck.engagementModel) {
      deck.engagementModel = buildEngagementModel(profile, deck.engagementModel?.name)
    }
    onProgress({ stage: 'deterministic', section: 'whyCopods', deck: { ...deck } })
  } else {
    // Non-proposal decks must not carry the Copods sales pitch.
    deck.whyCopods = null
    deck.engagementModel = null
  }

  if (meetingTitle?.trim()) deck.deckTitle = meetingTitle.trim()
  if (clientName?.trim() && !anonymize) deck.clientName = clientName.trim()

  const totalMs = timings.reduce((a, t) => a + (t.totalMs || 0), 0)
  const outTokens = timings.reduce((a, t) => a + (t.outputTokens || 0), 0)
  const promptTokens = timings.reduce((a, t) => a + (t.promptTokens || 0), 0)

  onProgress({ stage: 'done', deck, report: ctxReport })
  return {
    deck,
    stats: {
      sections: timings.length, totalMs, outTokens, promptTokens,
      perSection: timings, contextReport: ctxReport,
      savedByDeterministic: deck.whyCopods ? Math.round(JSON.stringify(deck.whyCopods).length / 3.8) : 0,
    },
  }
}
