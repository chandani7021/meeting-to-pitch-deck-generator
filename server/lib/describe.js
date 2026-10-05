/**
 * Turning ops back into English.
 *
 * Two problems this solves. The chat used to print raw paths — "updated
 * proposedSolutions › 3 › keyPoints › -" — which is the deck's vocabulary, not
 * the user's. And when the reply came from the model instead, it was sometimes
 * simply untrue: a small model with an empty ops array still writes "Rewrote
 * the bullets to lead with the outcome."
 *
 * So the reply is derived from the ops that actually applied. It can be wordy,
 * but it cannot lie.
 */

const ORDINAL = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth']
const ordinal = i => ORDINAL[i] || `${i + 1}th`

/** Field names as a person would say them. */
const FIELD_NOUN = {
  deckTitle: 'the deck title',
  clientName: "the client's name",
  clientIndustry: 'the industry',
  executiveSummary: 'the overview',
  title: 'the heading',
  subtitle: 'the subheading',
  description: 'the description',
  stat: 'the key stat',
  item: 'the action',
  owner: 'the owner',
  dueDate: 'the due date',
  visual: 'the visual',
  keyPoints: 'the bullets',
  clientNeeds: 'the challenges',
  proposedSolutions: 'the solution slides',
  nextSteps: 'the next steps',
  engagementModel: 'the engagement model',
  whyCopods: 'the Why Copods slide',
  labels: 'the slide labels',
  visuals: 'the visuals',
}

/** Array names in the singular, for "the second challenge". */
const ITEM_NOUN = {
  clientNeeds: 'challenge',
  proposedSolutions: 'solution',
  nextSteps: 'next step',
  keyPoints: 'bullet',
  phases: 'phase',
  relevantCaseStudies: 'case study',
  topics: 'topic',
  actionItems: 'action',
}

/** Fields that appear across the deck rather than on one slide. */
const DECK_WIDE = new Set(['deckTitle', 'clientName', 'clientIndustry', 'labels'])

const unescape = k => k.replace(/~1/g, '/').replace(/~0/g, '~')
const parts = pointer => (typeof pointer === 'string' && pointer.startsWith('/')
  ? pointer.split('/').slice(1).map(unescape) : [])

/** The slide a path belongs to, using the longest directory path that prefixes it. */
function slideOf(pointer, directory) {
  let best = null
  for (const d of directory) {
    if (!d.srcPath) continue
    if (pointer === d.srcPath || pointer.startsWith(d.srcPath + '/')) {
      if (!best || d.srcPath.length > best.srcPath.length) best = d
    }
  }
  return best
}

/**
 * A human phrase for one path: "the second bullet on slide 5", "the heading on
 * slide 4", "the deck title".
 */
export function describePath(pointer, directory = []) {
  const p = parts(pointer)
  if (!p.length) return 'the deck'

  const slide = slideOf(pointer, directory)
  const where = slide ? ` on slide ${slide.n}` : ''

  const last = p[p.length - 1]
  const parent = p[p.length - 2]

  // .../keyPoints/2  → "the third bullet"
  if (/^\d+$/.test(last) && parent) {
    const noun = ITEM_NOUN[parent] || 'item'
    // An element of the array that IS the slide reads better as the slide.
    if (slide && slide.srcPath === pointer) return `slide ${slide.n}${slide.label ? ` (${slide.label})` : ''}`
    return `the ${ordinal(Number(last))} ${noun}${where}`
  }
  if (last === '-' && parent) return `a new ${ITEM_NOUN[parent] || 'item'}${where}`

  // A whole array or a named field.
  if (FIELD_NOUN[last]) {
    // The title and the client show up on every slide, so pinning them to the
    // one they happen to be anchored at would be misleading.
    return DECK_WIDE.has(last) ? FIELD_NOUN[last] : `${FIELD_NOUN[last]}${where}`
  }
  return slide ? `slide ${slide.n}` : `“${last}”`
}

const VERB = { replace: 'Rewrote', remove: 'Removed', insert: 'Added', move: 'Moved' }

/** One op as a sentence fragment: "rewrote the second bullet on slide 5". */
export function describeOp(op, directory = []) {
  const where = describePath(op.path, directory)
  if (op.op === 'move') return `moved ${describePath(op.from, directory)} to ${where}`
  if (op.op === 'insert') return `added ${where}`
  if (op.op === 'remove') return `removed ${where}`
  // Emptying a list or nulling a section is a removal in everything but name.
  if (op.op === 'replace' && (op.value === null || op.value === '' ||
      (Array.isArray(op.value) && !op.value.length))) return `cleared ${where}`
  return `rewrote ${where}`
}

/**
 * A single sentence covering every op, grouped so three bullet rewrites on one
 * slide read as "Rewrote three bullets on slide 5" rather than as a list.
 */
export function describeOps(ops, directory = []) {
  if (!ops?.length) return ''

  const groups = new Map()
  for (const op of ops) {
    const verb = op.op === 'replace' && (op.value === null || op.value === '' ||
      (Array.isArray(op.value) && !op.value.length)) ? 'clear' : op.op
    const slide = slideOf(op.path, directory)
    const key = `${verb}|${slide?.n ?? ''}|${parts(op.path).slice(-2, -1)[0] ?? ''}`
    if (!groups.has(key)) groups.set(key, { verb, slide, ops: [] })
    groups.get(key).ops.push(op)
  }

  const phrases = [...groups.values()].map(g => {
    if (g.ops.length === 1) return describeOp(g.ops[0], directory)
    const noun = ITEM_NOUN[parts(g.ops[0].path).slice(-2, -1)[0]] || 'item'
    const verb = { replace: 'rewrote', remove: 'removed', insert: 'added', clear: 'cleared', move: 'moved' }[g.verb]
    return `${verb} ${count(g.ops.length)} ${noun}s${g.slide ? ` on slide ${g.slide.n}` : ''}`
  })

  const sentence = phrases.length === 1 ? phrases[0]
    : `${phrases.slice(0, -1).join(', ')} and ${phrases[phrases.length - 1]}`
  return sentence.charAt(0).toUpperCase() + sentence.slice(1) + '.'
}

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
const count = n => WORDS[n] || String(n)

/** The bullet list under a reply — one line per op, in the user's vocabulary. */
export function describeEach(ops, directory = []) {
  return (ops || []).map(op => {
    const line = describeOp(op, directory)
    return line.charAt(0).toUpperCase() + line.slice(1)
  })
}

export { VERB }
