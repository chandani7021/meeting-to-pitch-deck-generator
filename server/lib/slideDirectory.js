/**
 * Slide directory — the bridge between what the user sees and what the deck is.
 *
 * Users talk in rendered slide numbers ("deck 4, 5 and 6") and in slide names
 * ("the case study slide"). The deck JSON has neither: it has JSON Pointers.
 * Every edit that arrives without a click used to die in that gap — the model
 * was handed `summarizeDeck()`, which lists titles and no numbers, so "slide 4"
 * was unresolvable and the only way through was to select something first.
 *
 * This module closes the gap once, deterministically, and both tiers use it:
 * Tier 1 to act outright, Tier 2 to be told which paths the user meant.
 */

/** Words users say for a slide. "deck 4" means slide 4 — decks don't nest. */
const SLIDE_WORD = '(?:slide|deck|page|section|card)s?'

const ORDINALS = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6,
  seventh: 7, eighth: 8, ninth: 9, tenth: 10,
}

/** Synonyms for a slide kind, so "the challenges slide" resolves without a number. */
const KIND_WORDS = {
  cover:     ['cover', 'title slide', 'first slide', 'opening'],
  exec:      ['executive summary', 'exec summary', 'overview', 'understanding', 'summary slide'],
  needs:     ['needs', 'challenges', 'problems', 'pain points', 'key challenges'],
  agenda:    ['agenda', 'topics'],
  solution:  ['solution', 'solutions', 'approach', 'proposal slide', 'what we will build'],
  why:       ['why copods', 'why us', 'credentials'],
  caseStudy: ['case study', 'case studies', 'past work', 'portfolio'],
  services:  ['services', 'our services', 'capabilities'],
  engagement:['engagement', 'engagement model', 'pricing', 'phases'],
  nextSteps: ['next steps', 'actions', 'action items', 'follow ups', 'follow-ups'],
  research:  ['research', 'findings', 'web findings'],
  closing:   ['closing', 'thank you', 'last slide', 'final slide', 'end slide'],
}

/** Slides the builder always draws — they have no removable source of their own. */
export const STRUCTURAL_KINDS = new Set(['cover', 'closing'])

/**
 * One row per rendered slide, in render order.
 * `arrayPath` + `index` are set only when the slide came from an array element,
 * which is exactly the case where merging and reordering are meaningful.
 */
export function buildDirectory(deck, spec) {
  return (spec?.slides || []).map((s, i) => {
    const srcPath = s.meta?.srcPath || null
    const m = srcPath?.match(/^(.*)\/(\d+)$/)
    return {
      n: i + 1,
      kind: s.meta?.kind || '',
      label: s.meta?.label || s.meta?.kind || `Slide ${i + 1}`,
      srcPath,
      arrayPath: m ? m[1] : null,
      index: m ? Number(m[2]) : null,
      structural: STRUCTURAL_KINDS.has(s.meta?.kind),
      summary: summarize(deck, srcPath),
    }
  })
}

/** A short content preview, so the model can match on wording as well as number. */
function summarize(deck, srcPath) {
  if (!srcPath) return ''
  const v = valueAt(deck, srcPath)
  if (v == null) return ''
  if (typeof v === 'string') return v.slice(0, 90)
  if (Array.isArray(v)) return v.map(x => x?.title || x?.item || '').filter(Boolean).slice(0, 4).join('; ').slice(0, 110)
  const bits = [v.title, v.subtitle, ...(v.keyPoints || []).slice(0, 2)].filter(Boolean)
  return bits.join(' — ').slice(0, 110)
}

function valueAt(root, pointer) {
  if (!pointer) return undefined
  let cur = root
  for (const raw of pointer.split('/').slice(1)) {
    if (cur == null) return undefined
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~')
    cur = Array.isArray(cur) ? cur[Number(key)] : cur[key]
  }
  return cur
}

/**
 * Every slide number a prompt refers to, as 1-based numbers.
 *
 * Handles the shapes people actually type: "slide 4", "deck 4, 5 and 6",
 * "slides 4-6", "the 2nd slide", "the last slide". Bare numbers only count
 * when a slide word appeared somewhere in the prompt, so "cut it to 3 bullets"
 * is not read as slide 3.
 */
export function parseSlideNumbers(prompt, total) {
  const p = ` ${String(prompt).toLowerCase()} `
  const nums = new Set()

  // "slides 4-6" — a dash is unambiguous.
  for (const m of p.matchAll(new RegExp(`${SLIDE_WORD}\\s*#?\\s*(\\d+)\\s*(?:-|–|—)\\s*#?\\s*(\\d+)`, 'g'))) {
    const [a, b] = [Number(m[1]), Number(m[2])].sort((x, y) => x - y)
    for (let i = a; i <= b; i++) nums.add(i)
  }

  // "slides 4 to 6" — the word form, and ONLY with the plural.
  // "change the key stat on slide 4 to 6 weeks" is not a range: the 6 is the new
  // value. Reading it as one silently widened the edit to slides 4, 5 and 6, and
  // "slide 99 to 6 weeks" expanded to ninety-four slides. People write a span in
  // the plural ("slides 4 to 6") and a value in the singular, so that is the
  // discriminator — it needs no list of units to exclude.
  for (const m of p.matchAll(/\b(?:slides|decks|pages|sections|cards)\s*#?\s*(\d+)\s*(?:to|through|thru)\s*#?\s*(\d+)/g)) {
    const [a, b] = [Number(m[1]), Number(m[2])].sort((x, y) => x - y)
    for (let i = a; i <= b; i++) nums.add(i)
  }

  // "slide 4, 5 and 6" — one slide word, then a run of numbers joined by , / and / &
  for (const m of p.matchAll(new RegExp(`${SLIDE_WORD}\\s*((?:#?\\s*\\d+\\s*(?:,|&|and|\\+|\\s)\\s*)*#?\\s*\\d+)`, 'g'))) {
    for (const d of m[1].matchAll(/\d+/g)) nums.add(Number(d[0]))
  }

  // Trailing numbers after the slide word: "merge 4, 5 and 6" once "deck" appeared.
  if (new RegExp(SLIDE_WORD).test(p)) {
    for (const m of p.matchAll(/\b(\d+)\s*(?:,|&|and|\+)\s*(\d+)(?:\s*(?:,|&|and|\+)\s*(\d+))?/g)) {
      for (const g of m.slice(1)) if (g) nums.add(Number(g))
    }
  }

  // "the second slide" / "the 2nd slide"
  for (const m of p.matchAll(new RegExp(`\\b(\\w+)\\s+${SLIDE_WORD}\\b`, 'g'))) {
    const w = m[1]
    if (w in ORDINALS) nums.add(ORDINALS[w])
    const d = w.match(/^(\d+)(?:st|nd|rd|th)$/)
    if (d) nums.add(Number(d[1]))
  }
  if (new RegExp(`\\blast\\s+${SLIDE_WORD}`).test(p) && total) nums.add(total)

  // Out-of-range numbers are returned too. Dropping them silently left targets
  // empty, so "delete slide 99" looked like a prompt that named no slide at all
  // and fell through to the model — or worse, to a field handler that picked a
  // slide of its own. The caller decides what to say about them.
  return [...nums].filter(n => Number.isInteger(n) && n >= 1).sort((a, b) => a - b)
}

/** Slides a prompt names by kind or by title wording, when it gives no number. */
function matchByWords(prompt, directory) {
  const p = ` ${String(prompt).toLowerCase()} `
  const hits = new Set()

  for (const [kind, words] of Object.entries(KIND_WORDS)) {
    if (words.some(w => p.includes(` ${w} `) || p.includes(` ${w}s `) || p.includes(`${w},`))) {
      directory.filter(d => d.kind === kind).forEach(d => hits.add(d))
    }
  }
  // A quoted phrase, or a slide whose label appears verbatim, beats a kind guess.
  for (const d of directory) {
    const label = (d.label || '').toLowerCase().trim()
    if (label.length >= 4 && p.includes(label)) hits.add(d)
  }
  return [...hits]
}

/**
 * The slides a prompt is about, in deck order.
 * `selection` is used only as a fallback — a prompt that names slides wins over
 * whatever happens to be clicked, because the words are the more recent intent.
 */
export function resolveTargets(prompt, directory, selection = null) {
  const asked = parseSlideNumbers(prompt, directory.length)
  const outOfRange = asked.filter(n => n > directory.length)
  const byNumber = asked.map(n => directory[n - 1]).filter(Boolean)
  // A prompt that named only slides this deck does not have is answered about
  // those numbers, never reinterpreted as naming no slide.
  if (byNumber.length || outOfRange.length) return { targets: byNumber, via: 'number', outOfRange }

  const byWords = matchByWords(prompt, directory)
  if (byWords.length) return { targets: byWords.sort((a, b) => a.n - b.n), via: 'name', outOfRange: [] }

  if (selection?.srcPath) {
    const exact = directory.filter(d => d.srcPath === selection.srcPath)
    if (exact.length) return { targets: exact, via: 'selection', outOfRange: [] }
    // A bullet inside a slide: fall back to the slide that contains it.
    const owner = directory.filter(d => d.srcPath && selection.srcPath.startsWith(d.srcPath + '/'))
    if (owner.length) return { targets: owner, via: 'selection', outOfRange: [] }
    if (Number.isInteger(selection.slideIndex) && directory[selection.slideIndex]) {
      return { targets: [directory[selection.slideIndex]], via: 'selection', outOfRange: [] }
    }
  }
  return { targets: [], via: 'none', outOfRange: [] }
}

/** The numbered inventory the model sees. Cheap: ~10 tokens a slide. */
export function directoryText(directory) {
  return 'SLIDES AS THE USER SEES THEM (slide number → deck path)\n' + directory.map(d => {
    const path = d.srcPath ? d.srcPath : '(built from the company profile — not editable by path)'
    return `${d.n}. ${d.label} [${d.kind}] → ${path}${d.summary ? `\n   ${d.summary}` : ''}`
  }).join('\n')
}
