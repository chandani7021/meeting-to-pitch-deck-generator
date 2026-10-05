/**
 * Context assembly with an explicit token budget.
 *
 * The old buildProposalPrompt() stuffed the entire profile into every request —
 * measured at 2,836 tokens for a proposal, of which the great majority was
 * irrelevant (all 6 case studies, all 12 testimonials, every service line).
 *
 * Budget by SPEED, not by the model's context limit. On CPU-only inference
 * prefill is the hidden cost: a 2,836-token prompt takes 30-60s to ingest on an
 * 8B before a single output token appears. So blocks are priority-ordered and
 * dropped from the bottom once the budget is hit.
 */
import { search } from './embeddings.js'
import { directoryText } from './slideDirectory.js'
import { getDossier, getStylePrefs } from './db.js'
import { flattenDossier } from './dossier.js'

export const estTokens = s => Math.ceil((s || '').length / 3.8)

export const BUDGETS = {
  generate: Number(process.env.CTX_BUDGET_GENERATE || 1500),
  // The edit budget covers the slide directory as well as the slice now. It
  // buys back far more than it costs: before the directory existed, a prompt
  // that named a slide by number had no way to resolve it and the edit was
  // simply wrong, which costs a whole round trip plus a retry.
  edit:     Number(process.env.CTX_BUDGET_EDIT     || 1100),
}

/**
 * Priority-ordered blocks -> a prompt that fits `budget`.
 * Anything marked pinned is never dropped; the rest goes bottom-up.
 * Returns the report too, because when a deck comes out wrong the first
 * question is always "what was actually in the prompt?".
 */
export function assemble(blocks, budget) {
  const kept = []
  let used = 0
  for (const b of blocks) {
    if (!b?.text?.trim()) continue
    const cost = estTokens(b.text)
    if (b.pinned || used + cost <= budget) { kept.push({ ...b, cost }); used += cost }
    else kept.push({ ...b, cost, dropped: true })
  }
  return {
    prompt: kept.filter(b => !b.dropped).map(b => b.text).join('\n\n'),
    report: {
      budget, used,
      included: kept.filter(b => !b.dropped).map(b => ({ name: b.name, tokens: b.cost })),
      dropped:  kept.filter(b => b.dropped).map(b => ({ name: b.name, tokens: b.cost })),
    },
  }
}

/* ── Generation context ────────────────────────────────────────────────────── */

const RULES = `You are a presentation writer at Copods, a UX design and software development studio.
Read the meeting transcript and return JSON describing a presentation deck.

RULES
1. Build the deck around the stated DECK INTENT, not a default proposal format.
2. deckType must match the real purpose of the meeting.
3. clientName is the person or company the meeting is ABOUT. Zoom, Google Meet, Teams, Gmail and Slack are apps, never clients.
4. Every fact must come from the transcript. Do not invent numbers, names or dates.
5. Be concrete and specific. No filler, no marketing language.`

export async function buildGenerationContext(db, profile, opts) {
  const {
    transcript, clientName, clientIndustry, deckIntent, meetingTitle,
    anonymize = false, clientId = null, budget = BUDGETS.generate,
    retrieve = true, section = null, hits: presetHits = null,
  } = opts

  // Retrieval query: what this deck is actually about. Industry and problem
  // words matter far more than the whole transcript, and a short query keeps
  // the one embedding call fast.
  const query = [clientName, clientIndustry, deckIntent, meetingTitle,
                 (transcript || '').slice(0, 600)].filter(Boolean).join(' ')

  // Retrieval runs once per deck; later sections reuse the same hits so their
  // system prompt stays byte-identical (see the KV-cache note below).
  let hits = presetHits || []
  if (!presetHits && retrieve) {
    try { hits = await search(db, query, { k: 8, filter: 'profile' }) }
    catch (err) { console.warn('[context] retrieval unavailable, continuing without:', err.message) }
  }

  const caseStudyHits = hits.filter(h => h.sourceType === 'profile:caseStudy')
  const evidence = hits
    .filter(h => h.sourceType !== 'profile:caseStudy')   // case studies are built deterministically
    .slice(0, 4)

  const dossier = clientId ? getDossier(db, clientId) : null
  const prefs = getStylePrefs(db).filter(p => p.confidence >= 0.5).slice(0, 5)

  const blocks = [
    { name: 'rules', pinned: true, text: RULES },
    { name: 'titleRule', pinned: true, text: meetingTitle?.trim()
        ? `The deck title MUST be exactly: "${meetingTitle.trim()}"`
        : 'Write a concise 5-8 word deck title matching the deckType.' },
    { name: 'intent', pinned: true, text: deckIntent?.trim() ? `DECK INTENT\n${deckIntent.trim()}` : '' },
    { name: 'anonymize', pinned: anonymize, text: anonymize
        ? `ANONYMIZATION IS ON. Never write a real company, product or person name. Describe the client generically from their industry (e.g. "a growth-stage fintech"). Do not invent a fake brand as a substitute.`
        : '' },
    { name: 'dossier', text: dossier ? dossierBlock(dossier) : '' },
    { name: 'evidence', text: evidence.length
        ? `RELEVANT COPODS CONTEXT (use only if it fits this client)\n` +
          evidence.map(e => `- ${e.text}`).join('\n')
        : '' },
    { name: 'stylePrefs', text: prefs.length
        ? `HOUSE STYLE (learned from past edits)\n` + prefs.map(p => `- ${p.value}`).join('\n')
        : '' },
    { name: 'clientHint', text: clientName ? `Client name hint: ${clientName}` : '' },
    { name: 'transcript', pinned: true, text: `MEETING TRANSCRIPT\n${transcript}` },
  ]

  const { prompt, report } = assemble(blocks, budget)
  // `prompt` is section-invariant; `task` is what varies and is sent as the
  // user turn, so all four section calls share one cached prefix.
  return { prompt, task: section ? SECTION_TASKS[section] || '' : '', report, caseStudyHits, dossier, hits }
}

const SECTION_TASKS = {
  frame:             'TASK: Return only the deck frame — deckType, labels, clientName, clientIndustry, deckTitle and a 2-3 sentence executiveSummary.',
  clientNeeds:       'TASK: Return only clientNeeds — the problems and challenges this client actually stated, each with a 3-5 word title and a 1-2 sentence description drawn from the transcript.',
  proposedSolutions: 'TASK: Return only proposedSolutions — what should be built or done, each with a title, an optional one-line subtitle, and 2-4 keyPoints of 10-15 words grounded in the transcript.',
  closing:           'TASK: Return only nextSteps (actions, with owner and dueDate when stated) and, if this is a proposal, an engagementModel chosen from Start, Scale or Transform with up to 4 concrete phases.',
}

function dossierBlock(dossier) {
  const f = flattenDossier(dossier.facts) || {}
  const lines = []
  if (f.industry) lines.push(`Industry: ${f.industry}`)
  if (f.goals?.length) lines.push(`Known goals: ${f.goals.join('; ')}`)
  if (f.constraints?.length) lines.push(`Known constraints: ${f.constraints.join('; ')}`)
  if (f.budgetSignal) lines.push(`Budget signal: ${f.budgetSignal}`)
  if (f.timeline) lines.push(`Timeline: ${f.timeline}`)
  if (f.stakeholders?.length) lines.push(`Stakeholders: ${f.stakeholders.map(s => `${s.name}${s.role ? ` (${s.role})` : ''}`).join(', ')}`)
  if (f.decisions?.length) lines.push(`Decisions already taken: ${f.decisions.join('; ')}`)
  if (!lines.length) return ''
  return `WHAT WE ALREADY KNOW ABOUT THIS CLIENT (from earlier meetings — the transcript wins if they conflict)\n${lines.join('\n')}`
}

/* ── Edit context ──────────────────────────────────────────────────────────── */

const EDIT_RULES = `You edit an existing presentation deck by emitting JSON Pointer operations.

HOW TO ANSWER
1. Return the smallest set of ops that satisfies the request. Never rewrite content nobody mentioned.
2. Use only paths that appear below. If the path you need is not listed, return an empty ops array and explain in "reply".
3. The user counts slides as they see them. Use the slide list to turn "slide 4" into a deck path.
4. A "replace" must keep the shape that is already at the path: text stays text, and an object keeps all of its fields.
5. Append to a list with the path ".../-".
6. Write a one-sentence "reply" describing what you changed.

EXAMPLES
Request: "make the second bullet shorter"
{"reply":"Shortened that bullet.","ops":[{"op":"replace","path":"/proposedSolutions/0/keyPoints/1","value":"Ship one checkout flow across web and app"}]}

Request: "add a bullet about the timeline"
{"reply":"Added a timeline bullet.","ops":[{"op":"insert","path":"/proposedSolutions/0/keyPoints/-","value":"Phase one ships in six weeks"}]}

Request: "drop the third challenge"
{"reply":"Removed the third challenge.","ops":[{"op":"remove","path":"/clientNeeds/2"}]}

Request: "rewrite the exec summary to lead with the outcome"
{"reply":"Rewrote the executive summary to lead with the outcome.","ops":[{"op":"replace","path":"/executiveSummary","value":"..."}]}`

/**
 * Edit prompts carry the slide directory plus only the slice being edited, not
 * the whole deck. That is what makes a chat edit feasible on a slow local
 * model: roughly a thousand prompt tokens and ~60 output tokens instead of
 * regenerating 1,300.
 *
 * The directory is the important half. Without it the model saw a list of
 * titles with no slide numbers, so any request phrased the way users actually
 * phrase them — "slide 4", "the pricing slide" — was unresolvable, and the only
 * way to get an edit through was to click the element first.
 */
export function buildEditContext(deck, {
  prompt, selection, history = [], directory = [], targets = [], via = 'none', budget = BUDGETS.edit,
}) {
  // Slides the prompt named win over whatever is clicked; a click is only a
  // fallback, and a click on a single bullet still scopes tighter than a slide.
  const focusPaths = targets.length
    ? targets.map(t => t.srcPath).filter(Boolean)
    : (selection?.srcPath ? [selection.srcPath] : [])

  const focus = focusPaths.length
    ? focusPaths.map(path => ({ path, value: sliceAt(deck, path) }))
    : null

  // Spelling out the number→path mapping is the single highest-value line in
  // this prompt. Without it a small model writes /proposedSolutions/6 for
  // "slide 6" — using the slide number as the array index — and every op is
  // rejected for pointing past the end of the list.
  const mapping = targets.length
    ? targets.map(t => `Slide ${t.n} IS the path ${t.srcPath || '(not editable by path)'}. Do not write ${t.n} as an index.`).join('\n')
      + (via === 'number'
          ? `\nThis request is about slide ${targets.map(t => t.n).join(', ')} ONLY. Earlier messages mention other slides; they are finished work, not the target. Do not emit a path outside the slides listed here.`
          : '')
    : ''

  // Every editable string is listed as a literal path plus its current value.
  // A 3B model copies a path far more reliably than it derives one by walking
  // nested JSON, and this is also smaller than the pretty-printed object.
  const scopeText = focus
    ? `EDITABLE TEXT — every path you may change, with what is in it now\n${mapping}\n\n` +
      focus.map(f => leafPaths(f.value, f.path).join('\n')).join('\n\n')
    // No slide named: the model still needs paths it can copy. It used to get a
    // shape-only outline with no leaf paths, so it invented them and every op
    // was rejected — "make the bullets shorter" changed nothing at all. Values
    // are clipped because here the path matters and the prose does not.
    : `EDITABLE TEXT — every path in this deck (no slide was named, so pick the right ones)\n` +
      clip(leafPaths(deck, ''), 60).join('\n')

  const blocks = [
    { name: 'editRules', pinned: true, text: EDIT_RULES },
    { name: 'directory', pinned: true, text: directory.length ? directoryText(directory) : '' },
    { name: 'scope', pinned: true, text: scopeText },
    // A selected bullet is more specific than the slide it sits on, so say so
    // explicitly rather than hoping the model infers it from the slice.
    { name: 'selection', text: selection?.srcPath && !targets.length
        ? `THE USER HAS SELECTED: ${selection.srcPath}${selection.text ? ` — "${selection.text.slice(0, 80)}"` : ''}\nPrefer editing exactly this path.`
        : '' },
    // History is kept for tone and style — "shorter", "no jargon", what the user
    // has been steering towards. It is NOT kept for targeting: a previous
    // "change slide 4" would otherwise pull this request onto slide 4, which is
    // the single most confusing failure the chat has. Slide references in old
    // turns are blurred out so they cannot be mistaken for the current target.
    { name: 'history', text: history.length
        ? `EARLIER IN THIS CHAT (background only — for tone and style, never for which slide to edit)\n${
            history.slice(-4).map(h => `${h.role}: ${blurSlideRefs(h.text)}`).join('\n')}`
        : '' },
    { name: 'request', pinned: true, text: `REQUEST\n${prompt}` },
  ]
  return assemble(blocks, budget)
}

/** Shortens the value half of each `path = "value"` line to keep the list cheap. */
function clip(lines, max) {
  return lines.map(l => {
    const at = l.indexOf(' = ')
    if (at < 0 || l.length - at - 3 <= max) return l
    return `${l.slice(0, at)} = ${l.slice(at + 3, at + 3 + max)}…"`
  })
}

/**
 * Flattens a node into `path = "value"` lines, one per editable leaf.
 * Arrays also get an append hint, because "add a bullet" is as common as
 * "change a bullet" and the `-` syntax is not guessable.
 */
export function leafPaths(value, base, depth = 0) {
  if (value == null) return []
  if (typeof value !== 'object') return [`${base} = ${JSON.stringify(value)}`]
  if (depth > 3) return []

  if (Array.isArray(value)) {
    const lines = value.flatMap((v, i) => leafPaths(v, `${base}/${i}`, depth + 1))
    return lines.length ? [...lines, `${base}/-  (use this path to append a new item)`] : lines
  }
  return Object.entries(value)
    .filter(([k]) => !k.startsWith('_') && k !== 'visual')
    .flatMap(([k, v]) => leafPaths(v, `${base}/${k}`, depth + 1))
}

/**
 * Replaces slide references in an old chat turn with "an earlier slide".
 * The words still carry the style instruction ("make it punchier"); the stale
 * target no longer competes with the one in the current request.
 */
export const blurSlideRefs = text =>
  String(text || '').replace(/\b(?:slide|deck|page)s?\s*#?\s*\d+(?:\s*(?:,|&|and|-|to)\s*\d+)*/gi, 'an earlier slide')

/** Resolves a JSON Pointer to its value. */
export function sliceAt(obj, pointer) {
  if (!pointer || pointer === '/') return obj
  let cur = obj
  for (const raw of pointer.split('/').slice(1)) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~')
    if (cur == null) return null
    cur = Array.isArray(cur) ? cur[Number(key)] : cur[key]
  }
  return cur ?? null
}

/** A shape-only view of the deck: paths and lengths, no full text. */
export function summarizeDeck(deck) {
  const out = { deckType: deck.deckType, deckTitle: deck.deckTitle, clientName: deck.clientName }
  for (const key of ['clientNeeds', 'proposedSolutions', 'nextSteps']) {
    if (Array.isArray(deck[key])) {
      out[key] = deck[key].map((v, i) => ({ _path: `/${key}/${i}`, title: v.title || v.item || '' }))
    }
  }
  if (deck.whyCopods?.relevantCaseStudies) {
    out.caseStudies = deck.whyCopods.relevantCaseStudies.map((c, i) => ({
      _path: `/whyCopods/relevantCaseStudies/${i}`, title: c.title,
    }))
  }
  if (deck.engagementModel) out.engagementModel = { _path: '/engagementModel', name: deck.engagementModel.name }
  if (typeof deck.executiveSummary === 'string') out.executiveSummary = { _path: '/executiveSummary' }
  return out
}
