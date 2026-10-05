/**
 * Deterministic "Why Copods" + case-study construction.
 *
 * Measured on real saved decks, whyCopods was 663 of ~1,262 output tokens —
 * 53% of everything the model generated. Yet the profile already contains every
 * field the slide schema needs (title, description, audience, goals, solution,
 * impact, techStack), so the model was spending half its output retyping facts
 * we already had, slowly and with a chance of mangling the numbers.
 *
 * Here we build the whole block from the profile. The model's only remaining
 * job is choosing WHICH case studies are relevant, which retrieval does better
 * anyway. Output drops ~1,262 -> ~600 tokens, roughly halving local generation
 * time, and the metrics become impossible to hallucinate.
 */

/**
 * Engagement arcs for the stage/arrow flow — the one thing the profile lacks.
 * Picked by keyword so each case study gets an arc matching its real narrative
 * (the prompt used to warn the model not to reuse the same 4 labels; this makes
 * that structural instead of hopeful).
 */
const ARCS = [
  { test: /design system|component|storybook|visual language/i,
    stages: ['Audit', 'Systemize', 'Build', 'Adopt'],
    subs: ['"What exists?"', '"One language"', '"Componentize"', '"Ship it"'] },
  { test: /ai|co-pilot|copilot|ml|gen-ai|llm/i,
    stages: ['Discover', 'Prototype', 'Train', 'Launch'],
    subs: ['"Where is the pain?"', '"Does it work?"', '"Make it smart"', '"Go live"'] },
  { test: /onboarding|kyc|signup|activation|funnel/i,
    stages: ['Map', 'Simplify', 'Test', 'Roll out'],
    subs: ['"Every step"', '"Cut friction"', '"Prove it"', '"Scale"'] },
  { test: /dashboard|analytics|report|insight|data/i,
    stages: ['Research', 'Model', 'Visualize', 'Validate'],
    subs: ['"Who needs what?"', '"Shape the data"', '"Make it legible"', '"Confirm"'] },
  { test: /migrat|replatform|legacy|moderni/i,
    stages: ['Assess', 'Plan', 'Migrate', 'Stabilize'],
    subs: ['"What breaks?"', '"Sequence it"', '"Move safely"', '"Harden"'] },
]
const DEFAULT_ARC = { stages: ['Discover', 'Define', 'Design', 'Deliver'],
                      subs: ['"What?"', '"Why?"', '"How?"', '"Ship"'] }

/**
 * `taken` holds arcs already used on this deck. Two case studies matching the
 * same keyword would otherwise render identical arrow flows side by side, which
 * reads as a template rather than two real projects — so we fall through to the
 * next matching arc, then to any unused one.
 */
function deriveArc(cs, taken = new Set()) {
  const hay = [cs.title, cs.description, cs.solutionSummary,
               ...(cs.solution || []), ...(cs.goals || [])].filter(Boolean).join(' ')
  const key = a => a.stages.join('>')
  const matches = ARCS.filter(a => a.test.test(hay))
  return matches.find(a => !taken.has(key(a)))
      || [...ARCS, DEFAULT_ARC].find(a => !taken.has(key(a)))
      || matches[0] || DEFAULT_ARC
}

const trim = (arr, n) => (arr || []).filter(Boolean).slice(0, n)

/** One profile case study -> one deck-schema case study, no model involved. */
export function buildCaseStudyBlock(cs, { anonymize = false, takenArcs } = {}) {
  const arc = deriveArc(cs, takenArcs)
  takenArcs?.add(arc.stages.join('>'))
  // Lead with the hardest numbers; keyMetrics is already ordered that way.
  const impact = (cs.impact?.length ? cs.impact : cs.keyMetrics || [])
    .slice(0, 3)
    .map(m => ({ label: m.label, value: m.value }))

  return {
    title: cs.title || `${cs.client} project`,
    description: anonymize
      ? (cs.description || '').replace(new RegExp(`\\b${cs.client}\\b`, 'gi'), 'the client')
      : cs.description || '',
    stages: arc.stages,
    stageSubs: arc.subs,
    audience: trim(cs.audience, 2),
    goals: trim(cs.goals, 4),
    solution: trim(cs.solution, 5),
    impact,
    techStack: trim(cs.techStack, 4),
    // Provenance: which profile entry this came from, so the UI can offer a swap.
    _sourceId: cs.id || cs.client,
    _client: anonymize ? null : cs.client,
    _industry: cs.industry || '',
  }
}

/**
 * Builds the complete whyCopods block.
 * `hits` are retrieval results over source_type 'profile:caseStudy'; their
 * meta.index points back into profile.caseStudies.
 */
export function buildWhyCopods(profile, hits, { k = 3, anonymize = false } = {}) {
  const all = profile?.caseStudies || []
  if (!all.length) return null

  let picked = hits
    .filter(h => h.sourceType === 'profile:caseStudy')
    .map(h => all[Number(h.meta?.index)])
    .filter(Boolean)
    .slice(0, k)

  // No retrieval available (Ollama down, corpus not indexed) — fall back to the
  // first k so deck generation still works rather than silently losing a slide.
  if (!picked.length) picked = all.slice(0, k)

  const takenArcs = new Set()
  return {
    keyPoints: trim(profile.differentiators, 4),
    relevantCaseStudies: picked.map(cs => buildCaseStudyBlock(cs, { anonymize, takenArcs })),
  }
}

/** Deterministic engagement model pick when the model isn't asked for one. */
export function buildEngagementModel(profile, name) {
  const models = profile?.engagementModels || []
  const m = models.find(x => x.name?.toLowerCase() === (name || '').toLowerCase()) || models[0]
  if (!m) return null
  return {
    name: m.name,
    description: m.description || '',
    phases: trim(m.deliverables, 4),
  }
}

/** Swap one case study for another by profile id — a tier-1 chat op. */
export function swapCaseStudy(profile, deck, index, targetId, { anonymize = false } = {}) {
  const all = profile?.caseStudies || []
  const cs = all.find(c => (c.id || c.client)?.toLowerCase() === String(targetId).toLowerCase())
             || all.find(c => (c.client || '').toLowerCase().includes(String(targetId).toLowerCase()))
  if (!cs || !deck.whyCopods?.relevantCaseStudies) return false
  deck.whyCopods.relevantCaseStudies[index] = buildCaseStudyBlock(cs, { anonymize })
  return true
}

export function availableCaseStudies(profile) {
  return (profile?.caseStudies || []).map((c, i) => ({
    index: i, id: c.id || c.client, client: c.client, industry: c.industry, title: c.title,
  }))
}
