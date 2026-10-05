/**
 * Three-tier edit router.
 *
 * Tier 1 — deterministic, no model, ~0ms. A large share of real deck editing is
 *          structural ("drop slide 4", "merge 4, 5 and 6", "swap in the Kristal
 *          case study"), and structure needs no inference. This tier is the main
 *          reason the chat feels responsive on CPU-only hardware.
 * Tier 2 — scoped LLM rewrite, for wording changes.
 * Tier 3 — full regeneration, for "redo this as a kickoff deck".
 *
 * Every tier resolves slide references the same way, through slideDirectory.js.
 * That is what lets a prompt name its own target ("deck 4, 5 and 6") instead of
 * requiring the user to click a slide first.
 */
import { buildEditContext } from './context.js'
import { EDIT_OPS_SCHEMA } from './deckSchema.js'
import { applyOps, filterValidOps, getAt } from './ops.js'
import { describeOps, describeEach, describePath } from './describe.js'
import { swapCaseStudy, availableCaseStudies } from './caseStudies.js'
import { bumpStylePref } from './db.js'
import { buildDirectory, resolveTargets, STRUCTURAL_KINDS } from './slideDirectory.js'
import { findImage, listImages, parseChartRequest, deriveChart, makeMotif, wantsChart, wantsImage, assetsDir, addTags } from './visuals.js'

const ORDINALS = { first: 0, second: 1, third: 2, fourth: 3, fifth: 4, last: -1 }

function parseIndex(word, len) {
  if (word == null) return null
  const w = String(word).toLowerCase()
  if (w in ORDINALS) return ORDINALS[w] === -1 ? len - 1 : ORDINALS[w]
  const n = parseInt(w, 10)
  return Number.isInteger(n) ? n - 1 : null   // users say "slide 3", 1-indexed
}

const LIST_FIELDS = {
  need: 'clientNeeds', needs: 'clientNeeds', challenge: 'clientNeeds', challenges: 'clientNeeds',
  solution: 'proposedSolutions', solutions: 'proposedSolutions',
  step: 'nextSteps', steps: 'nextSteps', action: 'nextSteps', actions: 'nextSteps',
  'case study': 'whyCopods/relevantCaseStudies', 'casestudy': 'whyCopods/relevantCaseStudies',
}

/**
 * The value exactly as the user typed it, title-cased only when they typed no
 * capitals at all. Someone who writes "NovaPay" means NovaPay; someone who
 * writes "novapay onboarding" almost certainly wants it capitalised.
 */
function asTyped(raw) {
  const v = String(raw).trim().replace(/[.\s]+$/, '')
  return /[A-Z]/.test(v) ? v : v.replace(/\b\w/g, c => c.toUpperCase())
}

const ORDINAL_WORDS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth']
const ordinalWord = i => ORDINAL_WORDS[i] || `${i + 1}th`

/** Distinguishes "title to Acme Rollout" from "title to be shorter". */
const isInstructionNotValue = v =>
  /^(be|being|say|reflect|match|something|anything|more|less|shorter|longer|better|clearer|punchier|the same)\b/i.test(String(v).trim())

/** "4, 5 and 6" — for prose, not for paths. */
const listPhrase = xs =>
  xs.length <= 1 ? String(xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`

/* ── Intent detection ──────────────────────────────────────────────────────── */
/* These are deliberately unanchored. The old versions all began with `^`, so
   "I don't like deck 4, 5 and 6, merge them" matched nothing and fell through
   to a model that could not resolve the numbers either — which is exactly the
   case that felt broken. Real instructions arrive wrapped in preamble. */

const MERGE_VERB  = /\b(merge|combine|consolidate|join|collapse|fold|unify|put\s+(?:them\s+)?together|into\s+one|as\s+one|single\s+slide|one\s+slide)\b/i
const DELETE_VERB = /\b(remove|delete|drop|cut|get\s+rid\s+of|take\s+out|kill)\b/i
const ADD_VERB    = /\b(add|put|insert|include|attach|give|show|create|make|generate|build|need)\b/i
const MOVE_VERB   = /\b(move|reorder|shift|bring|push|swap)\b/i
const SET_VERB    = /\b(set|change|make|update|rename|retitle|replace|rewrite|edit)\b/i

/* ── Tier 1: deterministic intents ─────────────────────────────────────────── */

/**
 * Returns { ops, reply, tier } when it can handle the request outright,
 * or null to fall through to the model.
 */
export function tryDeterministic(ctx) {
  const { deck, prompt, selection, profile, directory, targets } = ctx
  const p = prompt.trim().toLowerCase()

  // ── a slide number this deck does not have ──────────────────────────────
  // Answered before anything else: every handler below would otherwise treat
  // the request as naming no slide and pick one of its own.
  if (ctx.outOfRange?.length && !targets.length) {
    const n = directory.length
    return done(ctx.outOfRange.length > 1
      ? `This deck has only ${n} slides, so there is no slide ${listPhrase(ctx.outOfRange)}.`
      : `This deck has only ${n} slides, so there is no slide ${ctx.outOfRange[0]}.`)
  }

  // ── merge several slides into one ───────────────────────────────────────
  if (MERGE_VERB.test(p) && targets.length >= 2) return mergeSlides(ctx)

  // Which PART of a slide the verb acts on, resolved once and consulted by both
  // branches below. Deciding by keyword presence instead is how "remove the key
  // stat that is below the image" used to delete the image, and how "in slide 4
  // remove key stat" used to delete slide 4.
  const field = resolveField(prompt, ctx)

  // ── add / remove a visual ───────────────────────────────────────────────
  // An attached file settles the intent on its own: "add this to deck 4" needs
  // no image word in it, and there is nothing else it could mean.
  if (ctx.attachment?.file && !DELETE_VERB.test(p)) return addVisual(ctx)

  // ── delete: a named part first, the whole slide only if none was named ──
  if (DELETE_VERB.test(p) && !MERGE_VERB.test(p)) {
    if (field && !WHOLE_SLIDE.test(prompt)) return removeField(ctx, field)
    if (targets.length) {
      const bySlide = deleteSlides(ctx)
      if (bySlide) return bySlide
    }
  }

  // ── colour / style ──────────────────────────────────────────────────────
  // Before the field handlers: "change the background colour of slide 5" reads
  // like a field edit but no field holds it.
  const styled = setStyle(ctx)
  if (styled) return styled

  // ── set a field on a named slide ────────────────────────────────────────
  if (SET_VERB.test(p) && field?.target && (targets.length || selection?.srcPath)) {
    const set = setField(ctx, field)
    if (set) return set
  }

  // ── "add" a field that is already there ─────────────────────────────────
  if (ADD_VERB.test(p) && field && !DELETE_VERB.test(p)) {
    const notice = addFieldNotice(ctx, field)
    if (notice) return notice
  }

  if ((wantsImage(p) || wantsChart(p)) && (ADD_VERB.test(p) || /\bwith a\b/.test(p))) {
    // Only when the visual is what is being added — "add a bullet about the
    // chart" mentions a chart but is not a request for one.
    if (!field || field.key === 'visual') return addVisual(ctx)
  }

  // ── reorder slides ──────────────────────────────────────────────────────
  if (MOVE_VERB.test(p) && targets.length) {
    const moved = moveSlide(ctx)
    if (moved) return moved
  }

  // ── rename / retitle ────────────────────────────────────────────────────
  // Matched against the ORIGINAL prompt, not the lowercased copy: "NovaPay"
  // and "IBM" are the whole point of a rename, and title-casing a lowercased
  // match destroys them.
  // "change the title to X" sets it; "change the title to be shorter" is an
  // instruction about the title, not a new title, and belongs to the model.
  let m = prompt.match(/(?:set|change|rename|make)?\s*(?:the )?(?:deck )?title (?:to|=|:)\s*["\u201c]?(.+?)["\u201d]?\.?$/i)
  if (m && !isInstructionNotValue(m[1])) {
    const value = asTyped(m[1])
    return { tier: 'deterministic', ops: [{ op: 'replace', path: '/deckTitle', value }],
             reply: `Done \u2014 the deck is now called \u201c${value}\u201d.` }
  }

  m = prompt.match(/(?:set|change|rename)?\s*(?:the )?client(?: name)? (?:to|=|:)\s*["\u201c]?(.+?)["\u201d]?\.?$/i)
  if (m && !isInstructionNotValue(m[1])) {
    const value = asTyped(m[1])
    return { tier: 'deterministic', ops: [{ op: 'replace', path: '/clientName', value }],
             reply: `Done \u2014 the client is now ${value}. That updates the cover and every footer.` }
  }

  m = prompt.match(/(?:set|change)?\s*(?:the )?industry (?:to|=|:)\s*["\u201c]?(.+?)["\u201d]?\.?$/i)
  if (m && !isInstructionNotValue(m[1])) {
    const value = asTyped(m[1])
    return { tier: 'deterministic', ops: [{ op: 'replace', path: '/clientIndustry', value }],
             reply: `Done \u2014 the industry now reads ${value}.` }
  }

  // ── remove a whole section by name ──────────────────────────────────────
  m = p.match(/(?:remove|delete|drop|cut)\s+(?:the\s+)?(why copods|engagement model|services|next steps|exec(?:utive)? summary|case studies)\b/)
  if (m) {
    const map = {
      'why copods': ['/whyCopods', null], 'engagement model': ['/engagementModel', null],
      'case studies': ['/whyCopods/relevantCaseStudies', []],
      'next steps': ['/nextSteps', []], 'services': ['/_services', null],
      'exec summary': ['/executiveSummary', ''], 'executive summary': ['/executiveSummary', ''],
    }
    const [path, value] = map[m[1]] || []
    if (path && getAt(deck, path) !== undefined) {
      return { tier: 'deterministic', ops: [{ op: 'replace', path, value }], reply: `Dropped the ${m[1]} slide.` }
    }
  }

  // ── remove / reorder a list item ────────────────────────────────────────
  m = p.match(/(?:remove|delete|drop|cut)\s+(?:the\s+)?(\w+|\d+)(?:st|nd|rd|th)?\s+(need|needs|challenge|challenges|solution|solutions|step|steps|action|actions|case study|casestudy)\b/)
  if (m) {
    const field = LIST_FIELDS[m[2]]
    const arr = getAt(deck, '/' + field)
    const idx = parseIndex(m[1], arr?.length || 0)
    if (Array.isArray(arr) && idx != null && idx >= 0 && idx < arr.length) {
      return { tier: 'deterministic', ops: [{ op: 'remove', path: `/${field}/${idx}` }],
               reply: `Dropped the ${ordinalWord(idx)} ${m[2].replace(/s$/, '')}.` }
    }
  }

  m = p.match(/move\s+(?:the\s+)?(\w+|\d+)(?:st|nd|rd|th)?\s+(need|needs|solution|solutions|step|steps)\s+to\s+(?:position\s+)?(\w+|\d+)/)
  if (m) {
    const field = LIST_FIELDS[m[2]]
    const arr = getAt(deck, '/' + field)
    const from = parseIndex(m[1], arr?.length || 0)
    const to   = parseIndex(m[3], arr?.length || 0)
    const inRange = i => Number.isInteger(i) && i >= 0 && i < (arr?.length ?? 0)
    if (Array.isArray(arr) && inRange(from) && inRange(to) && from !== to) {
      return { tier: 'deterministic', ops: [{ op: 'move', from: `/${field}/${from}`, path: `/${field}/${to}` }],
               reply: `Moved the ${ordinalWord(from)} ${m[2].replace(/s$/, '')} to position ${to + 1}.` }
    }
    // Asking to move to a position that does not exist should say so, not
    // silently do nothing or corrupt the order.
    if (Array.isArray(arr) && (!inRange(from) || !inRange(to))) {
      const noun = arr.length === 1 ? m[2].replace(/s$/, '') : (m[2].endsWith('s') ? m[2] : m[2] + 's')
      return { tier: 'deterministic', ops: [],
               reply: `There ${arr.length === 1 ? 'is' : 'are'} only ${arr.length} ${noun} — positions 1 to ${arr.length} are valid.` }
    }
  }

  // ── swap a case study by name ───────────────────────────────────────────
  m = p.match(/(?:swap|replace|use)\s+(?:the\s+)?(?:\w+\s+)?case study\s+(?:\d+\s+)?(?:with|for|to)\s+["“]?([\w .&-]+?)["”]?\.?$/)
  if (m && profile) {
    const target = m[1].trim()
    const idx = selection?.srcPath?.match(/relevantCaseStudies\/(\d+)/)?.[1]
    const at = idx != null ? Number(idx) : 0
    const probe = structuredClone(deck)
    if (swapCaseStudy(profile, probe, at, target, { anonymize: false })) {
      return { tier: 'deterministic',
               ops: [{ op: 'replace', path: `/whyCopods/relevantCaseStudies/${at}`, value: probe.whyCopods.relevantCaseStudies[at] }],
               reply: `Swapped in the ${probe.whyCopods.relevantCaseStudies[at]._client || target} case study.` }
    }
    const names = availableCaseStudies(profile).map(c => c.client).join(', ')
    return { tier: 'deterministic', ops: [], reply: `I don\u2019t have a case study called “${target}”. The ones in your profile are: ${names}.` }
  }

  // ── engagement model ────────────────────────────────────────────────────
  m = p.match(/(?:set|change|use)\s+(?:the\s+)?engagement(?: model)?\s+(?:to|=|:)?\s*(start|scale|transform)\b/)
  if (m && deck.engagementModel) {
    const name = m[1][0].toUpperCase() + m[1].slice(1)
    return { tier: 'deterministic', ops: [{ op: 'replace', path: '/engagementModel/name', value: name }],
             reply: `Engagement model is now ${name}.` }
  }

  return null
}


/* ── What part of a slide is the verb acting on? ───────────────────────────── */
/*
 * "delete slide 4" removes a slide. "in slide 4 remove the key stat" removes a
 * field ON slide 4 and must leave the slide standing. Without this distinction
 * every delete that named a slide number destroyed the whole slide, which is
 * both wrong and the most expensive possible way to be wrong.
 */

/** Parts of a slide a person names, in the words they use for them. */
const SLIDE_FIELDS = [
  { key: 'stat',        noun: 'key stat',    clears: 'remove',
    re: /\b(key[\s-]?stats?|stats?|statistics?|metrics?|kpis?|the\s+(?:big\s+)?number)\b/i },
  { key: 'visual',      noun: 'visual',      clears: 'remove',
    re: /\b(images?|pictures?|photos?|graphics?|illustrations?|visuals?|charts?|graphs?|plots?|diagrams?)\b/i },
  { key: 'subtitle',    noun: 'subheading',  clears: 'remove',
    re: /\b(sub[\s-]?titles?|sub[\s-]?headings?|straplines?|kickers?)\b/i },
  { key: 'keyPoints',   noun: 'bullets',     clears: 'empty',
    re: /\b(bullets?|bullet[\s-]?points?|key[\s-]?points?|talking[\s-]?points?)\b/i },
  { key: 'description', noun: 'description', clears: 'empty',
    re: /\b(descriptions?|body[\s-]?copy|paragraphs?|blurbs?)\b/i },
  { key: 'owner',       noun: 'owner',       clears: 'remove', re: /\bowners?\b/i },
  { key: 'dueDate',     noun: 'due date',    clears: 'remove', re: /\b(due[\s-]?dates?|deadlines?)\b/i },
  // Last: a slide must keep a heading, so this one only ever reports, never cuts.
  { key: 'title',       noun: 'heading',     clears: 'never',
    re: /\b(titles?|headings?|headers?|headlines?)\b/i },
]

/** Words that mean "the slide itself", so no field is being singled out. */
const WHOLE_SLIDE = /\b(whole|entire|complete|all\s+of)\s+(?:the\s+)?(?:slide|deck|page)\b/i

/**
 * The field a prompt is acting on, or null when it means the slide itself.
 *
 * Which field wins matters: "remove the key stat that is below the image"
 * mentions two, and the one being removed is the one the verb reaches first.
 * Picking by mere presence is how that request used to delete the image.
 */
export function resolveField(prompt, { directory, targets, selection }) {
  const verb = prompt.search(/\b(remove|delete|drop|cut|kill|add|put|insert|include|attach|set|change|replace|update)\b/i)

  const hits = []
  for (const f of SLIDE_FIELDS) {
    const m = f.re.exec(prompt)
    if (m) hits.push({ field: f, at: m.index })
  }
  if (!hits.length) return null

  // Prefer the first field mentioned after the verb; fall back to the first
  // mentioned at all, for phrasings that front the object ("the key stat: cut it").
  const after = hits.filter(h => h.at > verb).sort((a, b) => a.at - b.at)
  const chosen = (after[0] || hits.sort((a, b) => a.at - b.at)[0]).field

  // "the second bullet on slide 4", "the last bullet" — an index within the field.
  let index = null
  if (chosen.key === 'keyPoints') {
    const om = /\b(last|\w+|\d+)(?:st|nd|rd|th)?\s+(?:bullet|bullets|bullet[\s-]?point|key[\s-]?point|point|line)\b/i.exec(prompt)
    if (om) {
      const w = om[1].toLowerCase()
      if (w === 'last') index = 'last'
      else {
        const parsed = parseIndex(w, 0)
        if (parsed != null && parsed >= 0) index = parsed
      }
    }
  }

  // Every field the prompt mentions, not just the chosen one: the others are
  // locators ("the key stat below the image") and they narrow the slide.
  const mentioned = hits.map(h => h.field)
  const { target, candidates } = pickFieldTarget(chosen, mentioned, { directory, targets, selection })
  return { ...chosen, index, target, candidates }
}

/**
 * Which slide the field belongs to. A named slide wins; otherwise, if exactly
 * one slide in the deck actually has that field, it is unambiguous and using it
 * saves the user a round trip.
 */
function pickFieldTarget(field, mentioned, { directory, targets, selection }) {
  if (targets.length) return { target: targets[0], candidates: [] }

  const holders = directory.filter(d => d.srcPath && fieldExists(d, field))
  if (holders.length === 1) return { target: holders[0], candidates: [] }

  // "the key stat below the image" names two things. Only a slide carrying both
  // can be meant, and that is usually exactly one slide.
  if (holders.length > 1 && mentioned.length > 1) {
    const all = holders.filter(d => mentioned.every(f => fieldExists(d, f)))
    if (all.length === 1) return { target: all[0], candidates: [] }
    if (all.length) return { target: null, candidates: all }
  }

  if (selection?.slideIndex != null && directory[selection.slideIndex]) {
    return { target: directory[selection.slideIndex], candidates: [] }
  }
  return { target: null, candidates: holders }
}

/** Set by routeEdit so field lookup can see the deck without threading it through. */
let FIELD_DECK = null
function fieldExists(dirEntry, field) {
  if (!FIELD_DECK) return false
  if (field.key === 'visual') return getAt(FIELD_DECK, visualPath(dirEntry)) !== undefined
  const node = getAt(FIELD_DECK, dirEntry.srcPath)
  const v = node && typeof node === 'object' && !Array.isArray(node) ? node[field.key] : undefined
  return v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length)
}

/**
 * Sets one field on one slide: "change the key stat on slide 4 to 6 weeks".
 *
 * Only fires when the slide is named or selected — without that, "set the title
 * to X" means the deck title, which is handled further down.
 */
function setField(ctx, f) {
  const { deck, prompt } = ctx
  const t = f.target
  if (!t?.srcPath) return null

  // The value is whatever follows the last "to"/"into"/":" after the field was
  // named, so "change the stat on slide 4 to 6 weeks" does not capture "slide".
  const from = f.re.exec(prompt)?.index ?? 0
  const m = /\b(?:to|into|reads?|says?|=|:)\s+["\u201c]?(.+?)["\u201d]?\s*\.?$/i.exec(prompt.slice(from))
  if (!m) return null
  const raw = m[1].trim()
  if (!raw || isInstructionNotValue(raw)) return null

  let index = f.index
  if (index === 'last') {
    const list = getAt(deck, `${t.srcPath}/${f.key}`)
    index = Array.isArray(list) && list.length ? list.length - 1 : null
  }

  // An index past the end is a request about something that is not there.
  // Letting it through produced an insert beyond the end of the array, which
  // ops.js rightly refuses — by throwing, which took the whole request with it.
  if (index != null) {
    const list = getAt(deck, `${t.srcPath}/${f.key}`)
    const len = Array.isArray(list) ? list.length : 0
    if (index >= len) {
      const noun = f.noun.replace(/s$/, '')
      return done(len
        ? `Slide ${t.n} has ${len} ${len === 1 ? noun : f.noun} — there is no ${ordinalWord(index)} one.`
        : `Slide ${t.n} has no ${f.noun} to change.`)
    }
  }

  const path = index != null ? `${t.srcPath}/${f.key}/${index}` : `${t.srcPath}/${f.key}`
  const current = getAt(deck, path)
  // A list can't be replaced by a sentence, and a visual isn't text at all.
  if (Array.isArray(current) || f.key === 'visual') return null

  const value = f.key === 'title' || f.key === 'subtitle' ? asTyped(raw) : raw
  const what = index != null ? `the ${ordinalWord(index)} ${f.noun.replace(/s$/, '')}` : `the ${f.noun}`
  return {
    tier: 'deterministic',
    ops: [{ op: current === undefined ? 'insert' : 'replace', path, value }],
    reply: `${current === undefined ? 'Added' : 'Updated'} ${what} on slide ${t.n} \u2014 it now reads \u201c${value}\u201d.`,
  }
}

/** Removes one field from one slide, leaving the slide itself alone. */
function removeField(ctx, f) {
  const { deck } = ctx
  const t = f.target
  if (!t) {
    const c = f.candidates || []
    if (c.length > 1) {
      return done(`Slides ${listPhrase(c.map(d => d.n))} all have a ${f.noun} — which one? Say "remove the ${f.noun} on slide ${c[0].n}".`)
    }
    if (!c.length) return done(`No slide in this deck has a ${f.noun} to remove.`)
    return done(`I couldn't tell which slide's ${f.noun} you mean — give me a number, like "remove the ${f.noun} on slide 4".`)
  }
  if (f.clears === 'never') {
    return done(`Every slide needs a ${f.noun}, so I can't cut slide ${t.n}'s. Say "retitle slide ${t.n} to …" to change it, or "delete slide ${t.n}" to drop the whole slide.`)
  }

  // "last" can only be resolved once the list is in hand.
  let index = f.index
  if (index === 'last') {
    const list = getAt(deck, `${t.srcPath}/${f.key}`)
    index = Array.isArray(list) && list.length ? list.length - 1 : null
  }

  const path = f.key === 'visual' ? visualPath(t)
    : index != null ? `${t.srcPath}/${f.key}/${index}`
    : `${t.srcPath}/${f.key}`

  const current = getAt(deck, path)
  if (index != null && current === undefined) {
    const list = getAt(deck, `${t.srcPath}/${f.key}`)
    const len = Array.isArray(list) ? list.length : 0
    const noun = f.noun.replace(/s$/, '')
    return done(len
      ? `Slide ${t.n} has ${len} ${len === 1 ? noun : f.noun} — there is no ${ordinalWord(index)} one.`
      : `Slide ${t.n} has no ${f.noun} to remove.`)
  }
  if (current === undefined || current === null || current === '') {
    const what = index != null ? `a ${ordinalWord(index)} ${f.noun.replace(/s$/, '')}` : `a ${f.noun}`
    return done(`Slide ${t.n} doesn't have ${what} to remove.`)
  }

  // An array element is spliced out; a whole list is emptied so the slide keeps
  // its shape; an optional scalar is deleted outright.
  const op = index != null ? { op: 'remove', path }
    : f.clears === 'empty' && Array.isArray(current) ? { op: 'replace', path, value: [] }
    : { op: 'remove', path }

  const what = index != null ? `the ${ordinalWord(index)} ${f.noun.replace(/s$/, '')}`
    : `the ${f.noun}`
  return { tier: 'deterministic', ops: [op], reply: `Took ${what} off slide ${t.n}. The slide is still there.` }
}

/* ── Merge ─────────────────────────────────────────────────────────────────── */

/** Lists longer than this overflow their slide, so a merge trims and says so. */
const MERGE_CAPS = { keyPoints: 6, impact: 4, phases: 4 }
/** Prose fields read naturally when concatenated; everything else takes the first value. */
const JOIN_KEYS = new Set(['description', 'subtitle', 'summary', 'detail'])

function mergeSlides({ deck, targets }) {
  const structural = targets.filter(t => STRUCTURAL_KINDS.has(t.kind))
  if (structural.length) {
    return done(`Slide${structural.length > 1 ? 's' : ''} ${listPhrase(structural.map(t => t.n))} ${structural.length > 1 ? 'are' : 'is'} the ${structural.map(t => t.kind).join(' and ')} — every deck needs those, so they can't be folded into another slide. Tell me which of the others to merge and I'll do those.`)
  }

  const unmappable = targets.filter(t => t.arrayPath == null)
  if (unmappable.length) {
    return done(`Slide${unmappable.length > 1 ? 's' : ''} ${listPhrase(unmappable.map(t => t.n))} (${unmappable.map(t => t.label).join(', ')}) ${unmappable.length > 1 ? "aren't" : "isn't"} part of a list, so there's nothing to merge ${unmappable.length > 1 ? 'them' : 'it'} into. Merging works on slides of the same kind — the solution slides, or the challenges.`)
  }

  const group = targets[0].arrayPath
  if (targets.some(t => t.arrayPath !== group)) {
    return done(`Slides ${listPhrase(targets.map(t => t.n))} come from different parts of the deck, so merging them would flatten two different things into one. Pick slides of the same kind and I'll merge those.`)
  }

  const nodes = targets.map(t => getAt(deck, t.srcPath))
  if (nodes.some(nd => nd == null || typeof nd !== 'object')) {
    return done(`I couldn't read slides ${listPhrase(targets.map(t => t.n))} back out of the deck — that's a bug, not something you did.`)
  }

  const { merged, dropped } = mergeNodes(nodes)
  const keep = targets[0]
  // The other indices are removed high-to-low so each removal leaves the
  // remaining indices still valid — ops apply in order against one copy.
  const rest = targets.slice(1).map(t => t.index).sort((a, b) => b - a)

  const ops = [
    { op: 'replace', path: keep.srcPath, value: merged },
    ...rest.map(i => ({ op: 'remove', path: `${group}/${i}` })),
  ]

  const note = dropped.length ? ` I trimmed ${dropped.join(' and ')} so it still fits on one slide.` : ''
  return {
    tier: 'deterministic', ops,
    reply: `Merged slides ${listPhrase(targets.map(t => t.n))} into one. It's slide ${keep.n} now, headed “${merged.title || merged.item || ''}”, and it keeps every bullet from all ${targets.length}.${note} If that heading is a mouthful, say "retitle slide ${keep.n} to …".`,
  }
}

/**
 * Combines several slide nodes into one without inventing anything: lists are
 * concatenated and de-duplicated, prose fields are joined, and single-value
 * fields keep the first slide's value.
 */
function mergeNodes(nodes) {
  const out = structuredClone(nodes[0])
  const dropped = []
  const keys = [...new Set(nodes.flatMap(nd => Object.keys(nd)))]

  for (const key of keys) {
    const vals = nodes.map(nd => nd[key]).filter(v => v != null && v !== '')
    if (!vals.length) continue

    if (Array.isArray(vals[0])) {
      const seen = new Set(), merged = []
      for (const arr of vals) {
        for (const v of (Array.isArray(arr) ? arr : [])) {
          const k = typeof v === 'string' ? v.toLowerCase().trim() : JSON.stringify(v)
          if (!seen.has(k)) { seen.add(k); merged.push(v) }
        }
      }
      const cap = MERGE_CAPS[key] ?? merged.length
      if (merged.length > cap) dropped.push(`${merged.length - cap} ${key}`)
      out[key] = merged.slice(0, cap)
    } else if (key === 'title' || key === 'item') {
      out[key] = mergeTitles(vals.map(String))
    } else if (JOIN_KEYS.has(key) && typeof vals[0] === 'string') {
      out[key] = [...new Set(vals.map(v => String(v).trim()))].join(' ')
    } else {
      out[key] = vals[0]
    }
  }
  return { merged: out, dropped }
}

/**
 * A merged heading. Joining three 5-word titles produces something the header
 * has to shrink to 8pt to fit, so past a sensible width it falls back to the
 * first title — and the reply tells the user to retitle it.
 */
function mergeTitles(titles) {
  const uniq = [...new Set(titles.map(t => t.trim()).filter(Boolean))]
  if (uniq.length <= 1) return uniq[0] || ''
  const joined = uniq.join(' & ')
  return joined.length <= 52 ? joined : uniq[0]
}

/* ── Delete ────────────────────────────────────────────────────────────────── */

function deleteSlides({ deck, targets }) {
  const ops = [], notes = [], removedNs = []
  // Highest slide number first: removing an earlier array element shifts the
  // later ones, and the paths were resolved against the deck as it is now.
  const ordered = [...targets].sort((a, b) => b.n - a.n)

  for (const t of ordered) {
    if (STRUCTURAL_KINDS.has(t.kind)) {
      notes.push(`Slide ${t.n} is the ${t.kind}, which every deck needs — I've left it in. You can reword it instead.`)
      continue
    }
    if (!t.srcPath) {
      notes.push(`Slide ${t.n} (${t.label}) comes from your company profile rather than this deck, so it isn't mine to remove.`)
      continue
    }
    const value = getAt(deck, t.srcPath)
    if (value === undefined) { notes.push(`Slide ${t.n} (${t.label}) has nothing behind it I can edit.`); continue }
    if (t.index != null) ops.push({ op: 'remove', path: t.srcPath })
    else ops.push({ op: 'replace', path: t.srcPath, value: Array.isArray(value) ? [] : null })
    removedNs.push(t.n)
  }

  if (!ops.length) return done(notes.join(' ') || "There's nothing to remove there.")
  removedNs.sort((a, b) => a - b)
  const reply = `Gone — slide${removedNs.length > 1 ? 's' : ''} ${listPhrase(removedNs)}.`
  return { tier: 'deterministic', ops, reply: notes.length ? `${reply} ${notes.join(' ')}` : reply }
}

/* ── Reorder ───────────────────────────────────────────────────────────────── */

function moveSlide({ deck, prompt, directory, targets }) {
  if (targets.length !== 2) return null
  const [a, b] = targets
  const p = prompt.toLowerCase()
  // "move slide 5 before slide 2" — whichever number the verb governs moves.
  const firstMentioned = p.indexOf(String(a.n)) < p.indexOf(String(b.n)) ? a : b
  const anchor = firstMentioned === a ? b : a
  const after = /\bafter\b|\bbelow\b|\bunder\b/.test(p)

  if (firstMentioned.arrayPath == null || firstMentioned.arrayPath !== anchor.arrayPath) {
    return done(`Slides ${a.n} and ${b.n} live in different parts of the deck, and slide order follows that structure — so one can't move past the other. Within a section I can reorder freely.`)
  }

  // "swap 4 and 5" exchanges both, which is two moves — the second accounts for
  // the shift the first one caused.
  if (/\bswap|exchange|switch\b/.test(p)) {
    const [lo, hi] = [a.index, b.index].sort((x, y) => x - y)
    return {
      tier: 'deterministic',
      ops: [
        { op: 'move', from: `${a.arrayPath}/${hi}`, path: `${a.arrayPath}/${lo}` },
        { op: 'move', from: `${a.arrayPath}/${lo + 1}`, path: `${a.arrayPath}/${hi}` },
      ],
      reply: `Swapped slides ${a.n} and ${b.n} around.`,
    }
  }
  const from = firstMentioned.index
  let to = anchor.index + (after ? 1 : 0)
  if (from < to) to -= 1                      // removing `from` first shifts the target left
  if (from === to) return done(`Slide ${firstMentioned.n} is already there.`)

  return {
    tier: 'deterministic',
    ops: [{ op: 'move', from: `${firstMentioned.arrayPath}/${from}`, path: `${firstMentioned.arrayPath}/${to}` }],
    reply: `Moved slide ${firstMentioned.n} ${after ? 'after' : 'in front of'} slide ${anchor.n}.`,
  }
}


/* ── Slide styling ─────────────────────────────────────────────────────────── */

/**
 * Colour words people actually type. Anything not here can still be given as a
 * hex value, which is what the "from white to black" phrasing usually becomes.
 */
const COLOR_WORDS = {
  black: '000000', white: 'FFFFFF', offwhite: 'FAFAFA', cream: 'FBF3EA', ivory: 'FFFFF0',
  grey: '8C8C96', gray: '8C8C96', silver: 'C8C8CE', charcoal: '2B2B33', slate: '3C4452',
  navy: '10203F', blue: '1F4FD8', skyblue: '4FA8E8', teal: '11726B', green: '1E7A46',
  olive: '5A6B2F', yellow: 'F2C230', gold: 'D4A017', amber: 'E8A317', orange: 'D05C10',
  red: 'B3261E', crimson: '8C1D18', maroon: '5E1717', pink: 'E86A9A', magenta: 'B5197F',
  purple: '2F215C', violet: '4B2E83', lavender: 'CFC6E8', brown: '5B3A21', beige: 'E8DCC8',
  dark: '14142A', light: 'F5F5F7', brand: 'D05C10',
}

const STYLE_PROPS = [
  { key: 'background', noun: 'background', re: /\b(backgrounds?|bg|backdrops?|slide\s+colou?r|fill)\b/i },
  { key: 'text',       noun: 'text colour', re: /\b(text|font|type|foreground|writing|lettering)\s*(?:colou?r)?\b/i },
]

/** A colour named in the prompt, as six hex digits, or null. */
function parseColor(prompt) {
  const hex = /#\s*([0-9a-f]{6}|[0-9a-f]{3})\b/i.exec(prompt)
  if (hex) {
    const v = hex[1]
    return (v.length === 3 ? v.split('').map(c => c + c).join('') : v).toUpperCase()
  }
  // "from white to black" — the colour AFTER "to" is the new one; without that
  // phrasing the last colour word mentioned is the intended value.
  const after = /\bto\s+(?:a\s+|the\s+)?([a-z]+(?:\s+[a-z]+)?)\b/i.exec(prompt)
  const words = [...String(prompt).toLowerCase().matchAll(/[a-z]+/g)].map(m => m[0])
  const named = w => COLOR_WORDS[w.replace(/\s+/g, '')] || COLOR_WORDS[w]

  if (after) {
    for (const w of after[1].toLowerCase().split(/\s+/).reverse()) {
      if (named(w)) return named(w)
    }
  }
  for (let i = words.length - 1; i >= 0; i--) if (named(words[i])) return named(words[i])
  return null
}

const STYLE_HINT = /\b(colou?r|background|bg|backdrop|theme|style|dark\s*mode|light\s*mode)\b/i

/** Where a slide's style override lives. Mirrors visualPath(). */
function stylePath(target) {
  return `/styles/${String(target.srcPath).replace(/~/g, '~0').replace(/\//g, '~1')}`
}

/**
 * "make slide 5 background black", "change the text on slide 3 to white".
 * Returns null when the request is not about colour, so it can fall through.
 */
function setStyle(ctx) {
  const { deck, prompt, directory, targets, selection } = ctx

  const color = parseColor(prompt)
  const named = STYLE_PROPS.find(pr => pr.re.test(prompt))
  const modeWords = /\b(dark|light)\s*mode\b/i.test(prompt)
  // "make slide 5 black" — a colour on its own, with nothing else it could
  // describe. Deliberately narrow: "change the title on slide 4 to Black Friday
  // Campaign" also contains a colour word and is not a styling request at all.
  const bareColor = new RegExp(
    `\\b(?:slide|deck|page)s?\\s*\\d+(?:'s)?\\s+(?:to\\s+|be\\s+|in\\s+)?(?:${Object.keys(COLOR_WORDS).join('|')})\\s*\\.?$`,
    'i').test(prompt)

  // A styling request is a style word, or a style noun carrying a colour, or a
  // bare colour applied to a slide. Anything else belongs to another handler.
  const prop = named && (color || DELETE_VERB.test(prompt)) ? named
    : (modeWords || bareColor || (STYLE_HINT.test(prompt) && (color || DELETE_VERB.test(prompt)))) ? STYLE_PROPS[0]
    : STYLE_HINT.test(prompt) && named ? named
    : null
  if (!prop) return null

  let target = targets[0]
  if (!target && selection?.slideIndex != null) target = directory[selection.slideIndex]
  if (!target) {
    return done(`Which slide should I recolour? Give me a number, like "make slide 5's background black".`)
  }
  if (!target.srcPath) {
    return done(`Slide ${target.n} (${target.label}) is generated from your company profile, so it has no style of its own to set.`)
  }

  // Removing a style is as legitimate as setting one.
  const clearing = DELETE_VERB.test(prompt) || /\b(reset|default|original|revert)\b/i.test(prompt)
  const path = stylePath(target)
  const current = getAt(deck, path)

  if (clearing) {
    if (current === undefined) return done(`Slide ${target.n} is already using the deck's normal colours.`)
    return { tier: 'deterministic', ops: [{ op: 'remove', path }],
             reply: `Slide ${target.n} is back to the deck's normal colours.` }
  }

  let value = color
  if (/\bdark\s*mode\b/i.test(prompt)) value = COLOR_WORDS.dark
  if (/\blight\s*mode\b/i.test(prompt)) value = COLOR_WORDS.white
  if (!value) {
    return done(`I couldn't tell which colour you mean. Name one — "make slide ${target.n}'s background black" — or give a hex value like #101820.`)
  }

  const next = { ...(current && typeof current === 'object' ? current : {}), [prop.key]: `#${value}` }
  const ops = []
  if (getAt(deck, '/styles') === undefined) ops.push({ op: 'insert', path: '/styles', value: {} })
  ops.push({ op: current === undefined ? 'insert' : 'replace', path, value: next })

  // Text that would vanish is remapped automatically, so say so — otherwise it
  // reads as the deck ignoring half the instruction.
  const auto = prop.key === 'background'
    ? ' Text and panels on it were adjusted to stay readable.'
    : ''
  return { tier: 'deterministic', ops,
           reply: `Slide ${target.n}'s ${prop.noun} is now ${colorName(value)}.${auto}` }
}

const colorName = hex => {
  const found = Object.entries(COLOR_WORDS).find(([, v]) => v === hex)
  return found ? found[0] : `#${hex}`
}

/* ── Visuals ───────────────────────────────────────────────────────────────── */

/** Slide kinds that have a column free for an image or a chart. */
const VISUAL_KINDS = new Set(['solution', 'exec', 'needs'])

/** Where a visual for this slide is stored. See builder.js visualFor(). */
function visualPath(target) {
  // Slides whose source is a bare string or a whole array keep their visual in
  // the deck-level map; an array ITEM can carry its own.
  if (target.kind === 'exec') return '/visuals/~1executiveSummary'
  if (target.kind === 'needs') return '/visuals/~1clientNeeds'
  return `${target.srcPath}/visual`
}

/**
 * The slide a visual should go on.
 *
 * Returns `{ target }` when one is settled, or `{ refuse }` when the user named
 * a slide that cannot hold one. It must never quietly pick a different slide
 * than the one asked for: "add an image to slide 3" answering "Put your image on
 * slide 4" is indistinguishable from a bug, and the user has no way to tell the
 * app understood them. Only a request that named no slide may fall back.
 */
function pickVisualTarget(directory, targets) {
  if (targets.length) {
    const ok = targets.find(t => VISUAL_KINDS.has(t.kind))
    if (ok) return { target: ok }
    const canHold = directory.filter(d => VISUAL_KINDS.has(d.kind))
    return { refuse: { named: targets, canHold } }
  }
  const fallback = directory.find(d => d.kind === 'solution')
                || directory.find(d => d.kind === 'exec')
  return fallback ? { target: fallback } : { refuse: { named: [], canHold: [] } }
}

/** Explains which slides can carry a visual, in the user's numbering. */
function visualRefusal({ named, canHold }) {
  if (!canHold.length) {
    return done(`No slide in this deck can hold a visual yet — they go on the overview and the solution slides, and this deck has neither.`)
  }
  const where = listPhrase(canHold.map(d => `${d.n} (${d.label})`))
  if (!named.length) return done(`Which slide? Visuals can go on slide ${where}.`)
  const which = named.length > 1
    ? `Slides ${listPhrase(named.map(t => t.n))} can't hold a visual`
    : `Slide ${named[0].n} (${named[0].label}) can't hold a visual`
  return done(`${which} — that layout has no room for one. It can go on slide ${where} instead; say which and I'll put it there.`)
}

function addVisual(ctx) {
  const { deck, prompt, directory, targets, dataDir, attachment } = ctx
  const picked = pickVisualTarget(directory, targets)
  if (picked.refuse) return visualRefusal(picked.refuse)
  const target = picked.target

  const asked = targets.length ? '' : ` — that's “${target.label}”. Say "add it to slide N" to move it`
  const node = target.srcPath ? getAt(deck, target.srcPath) : null
  const context = [prompt, target.label, node?.title, node?.subtitle, ...(node?.keyPoints || [])]
    .filter(Boolean).join(' ')

  // An attached image is an explicit instruction, so it beats every other
  // source — including a chart the wording might otherwise have asked for.
  if (attachment?.file) {
    // The words around the image become search terms, so the same picture is
    // findable by name next time without re-attaching it.
    try { addTags(dataDir, attachment.file, promptTags(prompt, node, target)) } catch {}
    return writeVisual(ctx, target, { type: 'image', file: attachment.file, alt: '' },
      `Put your image on slide ${target.n}${asked}.`)
  }

  let visual, what, note = ''
  if (wantsChart(prompt) && !wantsImage(prompt)) {
    // Chart data must come from the prompt or from the slide. Inventing plausible
    // numbers for a client deck is the one failure worse than doing nothing.
    visual = parseChartRequest(prompt) || deriveChart(node, prompt)
    if (!visual) {
      return done(`I'd need some numbers for that. Slide ${target.n} doesn't state any and neither does your message, and I'm not going to make figures up for a client deck. Give me the values and it's instant — for example: "add a bar chart to slide ${target.n}: mobile 48%, web 33%, in-store 19%".`)
    }
    what = `a ${visual.chart} chart (${visual.series.map(s => s.label).join(', ')})`
  } else {
    const img = findImage(dataDir, context)
    if (img) {
      visual = { type: 'image', file: img.file, alt: '' }
      what = `${img.file} from your library`
    } else {
      const chart = wantsChart(prompt) ? (parseChartRequest(prompt) || deriveChart(node, prompt)) : null
      if (chart) {
        visual = chart
        what = `a ${chart.chart} chart built from the numbers already on that slide`
      } else {
        // Falling back to a generated graphic rather than refusing: the slide
        // gets its visual anchor now, and the message says exactly what to do
        // to get a real photograph there instead.
        visual = makeMotif(node?.title || target.label)
        what = 'a generated on-brand graphic'
        const n = listImages(dataDir).length
        note = n
          ? ` ${n === 1 ? "The one image in your library doesn't match" : `None of the ${n} images in your library matched`} “${node?.title || target.label}” — attach the picture you want and I'll use that instead.`
          : ` You don't have any images yet. Attach one here and I'll put it straight on the slide, or drop files into ${assetsDir(dataDir)} named for what they show.`
      }
    }
  }

  return writeVisual(ctx, target, visual, `Added ${what} to slide ${target.n}${asked}.${note}`)
}

/** The ops that put a visual on a slide, wherever that slide keeps it. */
function writeVisual({ deck }, target, visual, reply) {
  const path = visualPath(target)
  const ops = []
  // The deck-level map may not exist yet, and insert needs its parent present.
  if (path.startsWith('/visuals/') && getAt(deck, '/visuals') === undefined) {
    ops.push({ op: 'insert', path: '/visuals', value: {} })
  }
  ops.push({ op: getAt(deck, path) === undefined ? 'insert' : 'replace', path, value: visual })
  return { tier: 'deterministic', ops, reply }
}

/** Words worth remembering an attached image by. */
function promptTags(prompt, node, target) {
  return String(`${prompt} ${node?.title || ''} ${target.label || ''}`)
    .toLowerCase().split(/[^a-z0-9]+/)
    .filter(w => w.length > 2 && !/^(add|put|this|that|image|picture|photo|slide|deck|page|the|and|for|with|into|here|use)$/.test(w))
    .slice(0, 8)
}

/** A deterministic answer that changes nothing — an explanation, not a failure. */
const done = reply => ({ tier: 'deterministic', ops: [], reply })

/* ── Tier 2/3 dispatch ─────────────────────────────────────────────────────── */

const REGEN = /\b(regenerate|start over|redo (?:this|the deck)|rebuild the deck|make it a (?:kickoff|proposal|status|interview|strategy) deck)\b/i

/**
 * Routes one chat message and returns the new deck plus what changed.
 * Never throws for model problems — returns `error` so the chat can show it.
 */
export async function routeEdit(db, deck, provider, {
  prompt, selection = null, history = [], profile = null, model, spec = null, dataDir = null,
  attachment = null,
}) {
  FIELD_DECK = deck
  const directory = buildDirectory(deck, spec)
  const { targets, via, outOfRange = [] } = resolveTargets(prompt, directory, selection)
  const ctx = { deck, prompt, selection, profile, directory, targets, via, dataDir, attachment, outOfRange }

  // Tier 1 runs before the regenerate check: a deterministic answer is always
  // better than throwing the deck away, and phrases like "create one slide out
  // of them" read like a regenerate if you only pattern-match verbs.
  const det = tryDeterministic(ctx)
  if (det) {
    if (!det.ops.length) return { ...det, deck, applied: [], targets: targets.map(t => t.n) }
    // Tier 1 builds its own ops, so a failure here is a bug in this file — but
    // it must surface as a chat message, not as a 500 that loses the request.
    try {
      const { deck: next, inverse } = applyOps(deck, det.ops)
      return { ...det, deck: next, inverse, applied: describeEach(det.ops, directory), targets: targets.map(t => t.n) }
    } catch (err) {
      console.error('[edit] deterministic op failed:', err.message, JSON.stringify(det.ops))
      return { tier: 'deterministic', deck, ops: [], targets: targets.map(t => t.n),
               reply: `I couldn't apply that change — ${err.message}. Nothing was altered.` }
    }
  }

  if (REGEN.test(prompt)) {
    return { tier: 'regenerate', deck, ops: [], reply: 'This needs a full regenerate — regenerating the deck.', regenerate: true }
  }

  // Tier 2 — the model gets the same slide directory Tier 1 used, plus the full
  // JSON of whichever slides the prompt named. Before this, an unselected edit
  // saw only a title list with no slide numbers, so "slide 4" was unresolvable.
  const ctxBuilt = buildEditContext(deck, { prompt, selection, history, directory, targets, via })
  const targetNs = targets.map(t => t.n)

  const ask = (user, temperature) => provider.complete({
    system: ctxBuilt.prompt, user, schema: EDIT_OPS_SCHEMA, model, temperature, label: 'edit',
  })

  let data, timing
  try {
    ({ data, timing } = await ask('Return the ops JSON now.', 0.2))

    // A small model quite often returns an empty ops array alongside a reply
    // that confidently describes the change it did not make. One retry against
    // the same system prompt is nearly free — the prefix is already in the KV
    // cache — and recovers most of them.
    if (!data?.ops?.length) {
      ({ data, timing } = await ask(
        'Your last answer contained no operations. Return the ops array now: at least one op with a path copied exactly from the deck above, or an empty array with a "reply" explaining why no path fits.',
        0,
      ))
    }
  } catch (err) {
    return { tier: 'llm', deck, ops: [], error: err.message, reply: `Edit failed: ${err.message}`, targets: targetNs }
  }

  const proposed = Array.isArray(data?.ops) ? data.ops : []
  if (!proposed.length) {
    // Never pass the model's own reply through here: with no ops it routinely
    // claims a change that did not happen, which is worse than saying nothing
    // worked, because the user moves on believing the deck was edited.
    return { tier: 'llm', deck, ops: [], timing, report: ctxBuilt.report, targets: targetNs,
             reply: `Nothing changed — ${noChangeHint(targets)}` }
  }

  // Confine to the slides THIS prompt named, before anything else looks at the
  // ops — an op on the wrong slide is valid JSON pointing at real content, so
  // no later check would catch it.
  const { ops: confined, strayed } = confineToTargets(proposed, targets, via)
  if (!confined.length && strayed.length) {
    return { tier: 'llm', deck, ops: [], timing, report: ctxBuilt.report, targets: targetNs,
             reply: `Nothing changed — I worked out a change but it landed on the wrong slide. Say it again naming the slide, e.g. "on slide ${targets[0].n}, …".` }
  }

  // Drop hallucinated paths rather than failing the whole batch — but try to
  // repair them first, because the commonest rejection is a fixable one.
  let { valid, rejected } = filterValidOps(deck, repairOps(deck, confined, targets))
  if (!valid.length) {
    return { tier: 'llm', deck, ops: [], timing, report: ctxBuilt.report, rejected, targets: targetNs,
             reply: `Nothing changed — I aimed at parts of the deck that aren't there. ${noChangeHint(targets)}` }
  }

  // An op that writes back the value already there is not a change, and must
  // not be reported as one.
  const { ops: effective, inert } = dropNoOps(deck, valid)
  if (!effective.length) {
    return { tier: 'llm', deck, ops: [], timing, report: ctxBuilt.report, targets: targetNs,
             reply: alreadySaysThat(deck, inert, directory) }
  }

  const { deck: next, inverse } = applyOps(deck, effective)
  learnStyle(db, prompt)
  return {
    tier: 'llm', deck: next, ops: effective, inverse, timing, report: ctxBuilt.report, rejected,
    // The reply describes the ops that applied, not what the model says it did.
    // Those diverge often enough — and invisibly enough — to be worth the loss
    // of the model's nicer phrasing.
    reply: describeOps(effective, directory),
    applied: describeEach(effective, directory), targets: targetNs,
  }
}

/**
 * Rewrites the one model mistake that is unambiguous enough to fix rather than
 * reject: using the slide number as the array index. "Slide 6" is the third
 * solution, so the model writes /proposedSolutions/6 into a four-item list. The
 * prompt says not to, and mostly that works — this catches the rest.
 *
 * It only fires when the index is genuinely out of range AND exactly one
 * resolved target lives in that array, so there is nothing to guess.
 */
function repairOps(deck, ops, targets) {
  return ops.map(op => {
    const fixed = { ...op }

    // "replace" at an append path is a contradiction the model reaches for
    // constantly once it knows about "-". What it means is unambiguous.
    if (fixed.op === 'replace' && typeof fixed.path === 'string') {
      const m = fixed.path.match(/^(.*)\/(-|\d+)$/)
      if (m) {
        const arr = getAt(deck, m[1])
        if (Array.isArray(arr) && (m[2] === '-' || Number(m[2]) >= arr.length)) fixed.op = 'insert'
      }
    }

    for (const key of ['path', 'from']) {
      const p = op[key]
      if (typeof p !== 'string') continue
      const m = p.match(/^(\/[^/]+(?:\/[^/]+)*?)\/(\d+)((?:\/.*)?)$/)
      if (!m) continue
      const [, arrayPath, idxStr, rest] = m
      const arr = getAt(deck, arrayPath)
      if (!Array.isArray(arr)) continue
      const idx = Number(idxStr)
      if (idx < arr.length) continue                       // a valid index; leave it alone
      const inThisArray = targets.filter(t => t.arrayPath === arrayPath)
      if (inThisArray.length !== 1) continue               // ambiguous — reject instead of guessing
      // The model wrote the slide number; only accept that reading.
      if (idx !== inThisArray[0].n && idx !== inThisArray[0].n - 1) continue
      fixed[key] = `${arrayPath}/${inThisArray[0].index}${rest}`
    }
    return fixed
  })
}

/**
 * When THIS prompt named slides by number, ops may only touch those slides.
 *
 * Prompt wording steers a small model, it does not bind it: with "change slide
 * 4" three turns back, a request about slide 5 still comes back pointing at
 * slide 4. So the constraint is enforced here rather than merely requested.
 * An op landing in the right list but the wrong element is remapped when there
 * is exactly one target; anything else is dropped and reported.
 */
function confineToTargets(ops, targets, via) {
  if (via !== 'number' || !targets.length) return { ops, strayed: [] }

  const allowed = targets.map(t => t.srcPath).filter(Boolean)
  const inScope = p => typeof p === 'string' &&
    allowed.some(a => p === a || p.startsWith(a + '/'))
  const sameArray = targets.length === 1 && targets[0].arrayPath != null ? targets[0] : null

  const kept = [], strayed = []
  for (const op of ops) {
    if (inScope(op.path) && (op.op !== 'move' || inScope(op.from))) { kept.push(op); continue }

    // The commonest stray is the right list, wrong index — the slide the user
    // talked about last time. With a single target that is unambiguous.
    const m = sameArray && typeof op.path === 'string'
      ? op.path.match(/^(.*)\/(\d+)((?:\/.*)?)$/) : null
    if (m && m[1] === sameArray.arrayPath && op.op !== 'move') {
      const fixed = { ...op, path: `${sameArray.arrayPath}/${sameArray.index}${m[3]}` }
      if (inScope(fixed.path)) { kept.push(fixed); continue }
    }
    strayed.push(op)
  }
  return { ops: kept, strayed }
}

/** Fields that hold one value, so "add" can only mean "it is missing". */
const SCALAR_FIELDS = new Set(['title', 'subtitle', 'stat', 'description', 'owner', 'dueDate'])

/**
 * "Add the heading on slide 4, 5 and 6" when all three already have one.
 *
 * Without this the request reaches the model, which dutifully writes each title
 * back unchanged. dropNoOps() catches that and answers honestly, but only after
 * a round trip. Answering here is instant and names every slide asked about.
 *
 * A list is never "already there": adding a bullet to a slide that has bullets
 * is an ordinary request, so keyPoints is deliberately not a scalar field.
 */
function addFieldNotice({ deck, prompt, targets }, f) {
  if (!SCALAR_FIELDS.has(f.key)) return null
  // "add a key stat of 6 weeks to slide 4" supplies a value — that is a set, not
  // a question about what is already there. But "add a heading TO SLIDE 4" says
  // where, not what, so slide references are stripped before looking for one.
  const stripped = prompt.replace(
    /\b(?:on|to|in|for|of)\s+(?:the\s+)?(?:slide|deck|page)s?\s*#?\s*\d+(?:\s*(?:,|&|and)\s*\d+)*/gi, ' ')
  const after = stripped.slice(f.re.exec(stripped)?.index ?? 0)
  if (/\b(?:to|into|of|reads?|says?|=|:)\s+\S/i.test(after)) return null

  const scope = targets.length ? targets : (f.target ? [f.target] : [])
  if (!scope.length) return null

  const valueOn = t => (t.srcPath ? getAt(deck, `${t.srcPath}/${f.key}`) : undefined)
  const filled = scope.filter(t => typeof valueOn(t) === 'string' && valueOn(t).trim())
  // If any named slide genuinely lacks the field, this is a real request.
  if (filled.length !== scope.length) return null

  const list = filled.map(t => {
    const v = valueOn(t)
    return `slide ${t.n} (\u201c${v.length > 40 ? v.slice(0, 40) + '\u2026' : v}\u201d)`
  })
  const example = f.key === 'title'
    ? `retitle slide ${filled[0].n} to \u2026`
    : `change the ${f.noun} on slide ${filled[0].n} to \u2026`
  return done(`${scope.length > 1 ? 'Those slides already have' : 'That slide already has'} a ${f.noun} \u2014 ${listPhrase(list)}. Nothing to add \u2014 say what it should say instead, for example \u201c${example}\u201d.`)
}

/**
 * Removes ops that would change nothing.
 *
 * Asked to "add the heading on slide 4, 5 and 6" — slides that already have
 * headings — the model replaces each title with the value it was given. Three
 * ops apply, the deck is byte-identical, and the reply says "Rewrote the heading
 * on slide 4, 5 and 6". That is the false-success failure invariant 7 exists to
 * prevent: it survives the ops check because the ops are real, just inert.
 *
 * They are also worth dropping for their own sake — a no-op batch in the log
 * makes undo appear to do nothing.
 */
function dropNoOps(deck, ops) {
  const kept = [], inert = []
  let probe = deck
  for (const op of ops) {
    // Only a replace (or an insert over an existing key) can be inert; a remove
    // or an array insert always changes something.
    if (op.op === 'replace' || op.op === 'insert') {
      const current = getAt(probe, op.path)
      const overwrites = op.op === 'replace' || !Array.isArray(getAt(probe, op.path.replace(/\/[^/]*$/, '')))
      if (overwrites && current !== undefined && JSON.stringify(current) === JSON.stringify(op.value)) {
        inert.push(op)
        continue
      }
    }
    kept.push(op)
    try { probe = applyOps(probe, [op]).deck } catch { /* filterValidOps already vetted it */ }
  }
  return { ops: kept, inert }
}

/** Explains an all-inert batch in terms of what is already there. */
function alreadySaysThat(deck, inert, directory) {
  const shown = inert.slice(0, 3).map(op => {
    const where = describePath(op.path, directory)
    const v = getAt(deck, op.path)
    return typeof v === 'string' && v ? `${where} already says \u201c${v.length > 48 ? v.slice(0, 48) + '\u2026' : v}\u201d` : `${where} is already set`
  })
  const list = shown.length === 1 ? shown[0]
    : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`
  // The example has to match the field actually involved — suggesting "retitle"
  // for an executive summary is advice that does not work.
  return `Nothing changed \u2014 ${list}. Tell me what it should say instead, for example \u201cchange ${
    describePath(inert[0].path, directory)} to \u2026\u201d.`
}

/** A next step the user can actually take, rather than "try selecting something". */
const noChangeHint = targets => targets.length
  ? `I found slide ${listPhrase(targets.map(t => t.n))} but couldn't tell what to change on it. Naming the part usually does it — "rewrite the second bullet on slide ${targets[0].n}", or "shorten the heading on slide ${targets[0].n}".`
  : `I couldn't tell which slide you mean. Give me a number ("slide 4"), the heading, or click it in the preview.`

/**
 * Notices repeated instructions and promotes them to house style, so the same
 * correction stops being needed on every deck.
 */
const STYLE_SIGNALS = [
  [/\b(shorter|shorten|punchier|too long|more concise|tighten)\b/i, 'concise', 'Keep bullets short and punchy — under about 12 words.'],
  [/\b(more detail|expand|longer|more specific)\b/i, 'detailed', 'Prefer specific, detailed bullets over short ones.'],
  [/\b(no jargon|plain(?:er)? english|simpler language)\b/i, 'plain', 'Avoid jargon; use plain language.'],
  [/\b(more formal|less casual)\b/i, 'formal', 'Keep the tone formal.'],
  [/\b(add (?:a )?(?:metric|number|stat)|quantif)\b/i, 'quantified', 'Include concrete numbers wherever the transcript supports them.'],
]

function learnStyle(db, prompt) {
  for (const [re, key, value] of STYLE_SIGNALS) {
    if (re.test(prompt)) { try { bumpStylePref(db, key, value) } catch {} }
  }
}
