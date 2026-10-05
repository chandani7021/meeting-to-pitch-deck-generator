/**
 * Edit-routing eval.
 *
 * "Make it more accurate" is unfalsifiable without this. Each case is a prompt
 * plus what must be true of the result — usually the exact deck paths the ops
 * are allowed to touch. Run it before and after any change to the router, the
 * prompt, or the model.
 *
 *   npm run eval            every case
 *   npm run eval -- --t1    deterministic cases only (fast, no model)
 *   npm run eval -- --only=merge
 *
 * A case is `expect`-only where behaviour is deterministic, and `allow`-only
 * where the model may reasonably choose among several paths — asserting an
 * exact rewrite would just encode one sample of a sampler.
 */
import { buildPresentation } from '../server/lib/builder.js'
import { routeEdit } from '../server/lib/editRouter.js'
import { buildDirectory } from '../server/lib/slideDirectory.js'
import { applyOps } from '../server/lib/ops.js'

const DATA = process.env.DATA_DIR || `${process.env.HOME}/.codeck`
const ORG = { orgName: 'Copods' }
const args = process.argv.slice(2)
const T1_ONLY = args.includes('--t1')
const ONLY = args.find(a => a.startsWith('--only='))?.slice(7)

/* ── The deck every case runs against ──────────────────────────────────────── */
/* Deliberately ordinary: a cover, an overview, three challenges, four solution
   slides, an engagement model and next steps. Slide numbers in the cases below
   are the numbers a user would read off the preview. */
const BASE = {
  deckType: 'proposal',
  labels: { cover: 'PROPOSAL', overview: 'Our Understanding', needs: 'Your Key Challenges', closing: "Let's Build\nTogether" },
  clientName: 'Northwind Retail', clientIndustry: 'Retail',
  deckTitle: 'Unified Commerce Platform',
  executiveSummary: 'Northwind runs three disconnected storefronts. We propose consolidating them onto one commerce core over two quarters.',
  clientNeeds: [
    { title: 'Fragmented checkout', description: 'Three checkouts, three carts, no shared session.' },
    { title: 'Slow catalogue updates', description: 'Price changes take 48 hours to propagate.' },
    { title: 'No unified analytics', description: 'Web and store data never reconcile.' },
  ],
  proposedSolutions: [
    { title: 'Discovery Sprint', subtitle: 'Two weeks', keyPoints: ['Map every checkout path across the three storefronts', 'Interview eight store managers about daily blockers'], stat: '2 weeks' },
    { title: 'Unified Cart', keyPoints: ['One session shared across web, app and in-store tills', 'Cut abandoned carts by removing the third re-login'] },
    { title: 'Catalogue Service', keyPoints: ['Single source of truth for price and stock', 'Propagate changes in under a minute'] },
    { title: 'Analytics Layer', keyPoints: ['Reconcile web and store events into one funnel', 'Daily dashboard for the merchandising team'], stat: '1 funnel' },
  ],
  engagementModel: { name: 'Scale', description: 'Phased delivery', phases: ['Discovery', 'Unified cart', 'Catalogue', 'Analytics'] },
  nextSteps: [{ item: 'Confirm scope', owner: 'Priya', dueDate: null }, { item: 'Share data access', owner: 'Tom', dueDate: null }],
}
// 1 cover · 2 exec · 3 needs · 4-7 solutions · 8 engagement · 9 nextSteps · 10 closing

const S = i => `/proposedSolutions/${i}`
const IMG = { file: 'checkout-funnel-diagram.png' }

/* ── Cases ─────────────────────────────────────────────────────────────────── */
const CASES = [
  // group, prompt, expectations
  ['target', 'delete slide 5',                         { tier: 't1', paths: [S(1)], slideDelta: -1 }],
  ['target', 'remove slides 5 and 6',                  { tier: 't1', paths: [S(1), S(2)], slideDelta: -2 }],
  ['target', 'I dont like deck 4, 5 and 6 merge them and create one deck out of them', { tier: 't1', touches: '/proposedSolutions', slideDelta: -2 }],
  ['target', 'merge slides 4 and 5 into one',          { tier: 't1', touches: '/proposedSolutions', slideDelta: -1 }],
  ['target', 'move slide 6 before slide 4',            { tier: 't1', touches: '/proposedSolutions', slideDelta: 0 }],
  ['target', 'swap slides 4 and 6',                    { tier: 't1', touches: '/proposedSolutions', slideDelta: 0 }],
  ['target', 'delete slide 1',                         { tier: 't1', noOps: true, mentions: 'cover' }],
  ['target', 'delete slide 10',                        { tier: 't1', noOps: true, mentions: 'closing' }],

  // A named part of a slide, never the slide itself.
  ['field',  'in slide 4 remove key stat',             { tier: 't1', paths: [`${S(0)}/stat`], slideDelta: 0 }],
  ['field',  'in slide 4, remove the right section which is key stat', { tier: 't1', paths: [`${S(0)}/stat`], slideDelta: 0 }],
  ['field',  'remove the key stat on slide 7',         { tier: 't1', paths: [`${S(3)}/stat`], slideDelta: 0 }],
  ['field',  'remove the subheading on slide 4',       { tier: 't1', paths: [`${S(0)}/subtitle`], slideDelta: 0 }],
  ['field',  'remove the second bullet on slide 4',    { tier: 't1', paths: [`${S(0)}/keyPoints/1`], slideDelta: 0 }],
  ['field',  'remove the last bullet on slide 5',      { tier: 't1', paths: [`${S(1)}/keyPoints/1`], slideDelta: 0 }],
  ['field',  'remove the bullets on slide 6',          { tier: 't1', paths: [`${S(2)}/keyPoints`], slideDelta: 0 }],
  ['field',  'remove the heading on slide 4',          { tier: 't1', noOps: true, mentions: 'heading' }],
  ['field',  'remove the key stat on slide 5',         { tier: 't1', noOps: true, mentions: "doesn't have" }],
  ['field',  'remove the whole slide 4',               { tier: 't1', paths: [S(0)], slideDelta: -1 }],

  // Setting a value.
  ['set',    'change the key stat on slide 4 to 6 weeks',        { tier: 't1', paths: [`${S(0)}/stat`], value: '6 weeks' }],
  ['set',    'set the heading on slide 5 to Unified Checkout',   { tier: 't1', paths: [`${S(1)}/title`], value: 'Unified Checkout' }],
  ['set',    'change the second bullet on slide 4 to Map every checkout path end to end', { tier: 't1', paths: [`${S(0)}/keyPoints/1`] }],
  ['set',    'set the title to NovaPay Onboarding',              { tier: 't1', paths: ['/deckTitle'], value: 'NovaPay Onboarding' }],
  ['set',    'change the client to eBay',                        { tier: 't1', paths: ['/clientName'], value: 'eBay' }],
  ['set',    'set the industry to Grocery',                      { tier: 't1', paths: ['/clientIndustry'] }],

  // "Add" something that is already there must not claim success.
  ['inert',  'Can you add the heading/title on slide 4, 5 and 6', { tier: 't1', noOps: true, mentions: 'already' }],
  ['inert',  'add a heading to slide 4',                          { tier: 't1', noOps: true, mentions: 'already' }],
  ['inert',  'add a key stat to slide 4',                         { tier: 't1', noOps: true, mentions: 'already' }],

  // Visuals, including the slide-2 bug: never silently retarget.
  ['visual', 'add an image to slide 2',   { tier: 't1', paths: ['/visuals', '/visuals/~1executiveSummary'], mentions: 'slide 2' }, IMG],
  ['visual', 'add an image to slide 3',   { tier: 't1', paths: ['/visuals', '/visuals/~1clientNeeds'], mentions: 'slide 3' }, IMG],
  ['visual', 'add an image to slide 4',   { tier: 't1', paths: [`${S(0)}/visual`], mentions: 'slide 4' }, IMG],
  ['visual', 'add this image in deck 6',  { tier: 't1', paths: [`${S(2)}/visual`], mentions: 'slide 6' }, IMG],
  ['visual', 'add an image to slide 8',   { tier: 't1', noOps: true, mentions: "can't hold" }, IMG],
  ['visual', 'add an image to slide 9',   { tier: 't1', noOps: true, mentions: "can't hold" }, IMG],
  ['visual', 'add a bar chart to slide 4: mobile 48%, web 33%, in-store 19%', { tier: 't1', paths: [`${S(0)}/visual`] }],
  ['visual', 'create an analytics visualization for slide 5',    { tier: 't1', noOps: true, mentions: 'numbers' }],
  ['visual', 'remove the image on slide 4',                      { tier: 't1', noOps: true, mentions: "doesn't have" }],

  // Colour and style.
  ['style',  'change the background color of slide 5 from white to black', { tier: 't1', touches: '/styles', mentions: 'black' }],
  ['style',  'make slide 6 dark mode',                    { tier: 't1', touches: '/styles' }],
  ['style',  'set slide 4 background to #101820',         { tier: 't1', touches: '/styles' }],
  ['style',  'make the text on slide 5 white',            { tier: 't1', touches: '/styles' }],
  ['style',  'reset the background on slide 5',           { tier: 't1', noOps: true, mentions: 'normal colours' }],

  // Model tier: the slide must be right even when the wording is not deterministic.
  ['llm',    'rewrite the bullets on slide 5 so they lead with the outcome', { tier: 't2', allow: S(1) }],
  ['llm',    'shorten the heading on slide 6',                { tier: 't2', allow: S(2) }],
  ['llm',    'slide 7 needs a third bullet about alerting',   { tier: 't2', allow: S(3) }],
  ['llm',    'the exec summary is too vague, make it name the two quarters', { tier: 't2', allow: '/executiveSummary' }],
  ['llm',    'add a bullet to slide 4 about pricing',         { tier: 't2', allow: S(0) }],

  // Edges: malformed, out of range, ambiguous, or phrased awkwardly. These are
  // where a router quietly does the wrong thing rather than saying it cannot.
  ['edge',   'delete slide 99',                   { tier: 't1', noOps: true, mentions: 'only' }],
  ['edge',   'change the fifth bullet on slide 4 to Ship it', { tier: 't1', noOps: true, mentions: 'bullet' }],
  ['edge',   'delete the second slide',           { tier: 't1', paths: ['/executiveSummary'], slideDelta: -1 }],
  ['edge',   'remove the last slide',             { tier: 't1', noOps: true, mentions: 'closing' }],
  ['edge',   'DELETE SLIDE 5',                    { tier: 't1', paths: [S(1)], slideDelta: -1 }],
  ['edge',   'delete slides 4-6',                 { tier: 't1', touches: '/proposedSolutions', slideDelta: -3 }],
  ['edge',   'make the bullets 3 words shorter',  { tier: 't2' }],
  ['edge',   'add an image to slide 1',           { tier: 't1', noOps: true, mentions: "can't hold" }, IMG],
  ['edge',   'change the key stat on slide 99 to 6 weeks', { tier: 't1', noOps: true, mentions: 'only' }],

  // History must inform the wording, never the target.
  ['history', 'now do the same on slide 5', { tier: 't2', allow: S(1) }, null, [
    { role: 'user', text: 'rewrite the bullets on slide 4 so they lead with the outcome' },
    { role: 'assistant', text: 'Rewrote two bullets on slide 4.' },
  ]],
  ['history', 'do that to slide 6 as well', { tier: 't2', allow: S(2) }, null, [
    { role: 'user', text: 'make slide 4 punchier' },
    { role: 'assistant', text: 'Added a new bullet on slide 4.' },
  ]],
]

/* ── Runner ────────────────────────────────────────────────────────────────── */
/** Stable stringify: key order is not part of a deck's meaning. */
const canon = v => JSON.stringify(v, (_, x) =>
  (x && typeof x === 'object' && !Array.isArray(x))
    ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]]))
    : x)

const spec = d => buildPresentation(d, DATA, ORG, { target: 'spec' })
const fakeDb = { prepare: () => ({ get: () => null, run: () => {}, all: () => [] }) }

function check(exp, r, before, after, reply) {
  const ops = r.ops || []
  const fails = []

  if (exp.tier === 't1' && r.tier !== 'deterministic') fails.push(`expected instant, got ${r.tier}`)
  if (exp.tier === 't2' && r.tier === 'deterministic') fails.push('expected the model tier, handled deterministically')

  if (exp.noOps && ops.length) fails.push(`expected no change, got ${ops.length} op(s): ${ops.map(o => o.path).join(', ')}`)
  if (!exp.noOps && !exp.allow && !ops.length) fails.push('expected a change, got none')

  if (exp.paths) {
    const got = ops.map(o => o.path).sort()
    const want = [...exp.paths].sort()
    if (JSON.stringify(got) !== JSON.stringify(want)) fails.push(`paths ${JSON.stringify(got)} != ${JSON.stringify(want)}`)
  }
  if (exp.touches && !ops.every(o => o.path.startsWith(exp.touches))) {
    fails.push(`ops outside ${exp.touches}: ${ops.map(o => o.path).join(', ')}`)
  }
  // The model may pick any path inside the named slide, but never outside it.
  if (exp.allow && ops.length) {
    const stray = ops.filter(o => !o.path.startsWith(exp.allow))
    if (stray.length) fails.push(`WRONG SLIDE: ${stray.map(o => o.path).join(', ')} outside ${exp.allow}`)
  }
  if (exp.value != null && !ops.some(o => o.value === exp.value)) {
    fails.push(`no op set the value ${JSON.stringify(exp.value)}`)
  }
  if (exp.slideDelta != null && after - before !== exp.slideDelta) {
    fails.push(`slide count moved ${after - before}, expected ${exp.slideDelta}`)
  }
  if (exp.mentions && !reply.toLowerCase().includes(exp.mentions.toLowerCase())) {
    fails.push(`reply never mentions "${exp.mentions}"`)
  }
  return fails
}

const provider = T1_ONLY
  ? { complete: async () => { throw new Error('model disabled by --t1') } }
  : await import('../server/lib/providers/local.js')

let pass = 0, fail = 0, skipped = 0
const failures = []

for (const [group, prompt, exp, attachment = null, history = []] of CASES) {
  if (ONLY && group !== ONLY) { skipped++; continue }
  if (T1_ONLY && exp.tier !== 't1') { skipped++; continue }

  const deck = structuredClone(BASE)
  const pristine = structuredClone(BASE)
  const sp = await spec(deck)
  let r
  try {
    r = await routeEdit(fakeDb, deck, provider, { prompt, spec: sp, dataDir: DATA, profile: null, attachment, history })
  } catch (err) {
    failures.push({ group, prompt, fails: [`threw: ${err.message}`] }); fail++; continue
  }
  const after = r.ops?.length ? (await spec(r.deck)).slides.length : sp.slides.length
  const fails = check(exp, r, sp.slides.length, after, r.reply || '')

  // Every change must be exactly reversible. Checked on every case rather than
  // its own group, because undo broke for object-property removals for a while
  // and nothing that only looked at the forward edit would have noticed.
  if (r.ops?.length && r.inverse) {
    const n = r.ops.length
    const inverse = [...r.ops].map((_, i) => r.inverse[n - 1 - i]).reverse()
    try {
      const back = applyOps(r.deck, inverse).deck
      // Compared canonically: restoring a deleted object property puts the key
      // back at the end, which changes JSON key order but nothing the renderer
      // or the export can see. Content must match; byte order need not.
      if (canon(back) !== canon(pristine)) fails.push('undo did not restore the deck exactly')
    } catch (err) {
      fails.push(`undo threw: ${err.message}`)
    }
  }

  if (fails.length) { fail++; failures.push({ group, prompt, fails, reply: r.reply, ops: r.ops }) }
  else pass++
  process.stdout.write(fails.length ? 'x' : '.')
}

console.log(`\n\n${pass}/${pass + fail} passed` + (skipped ? `  (${skipped} skipped)` : ''))
if (failures.length) {
  console.log('\nFAILURES')
  for (const f of failures) {
    console.log(`\n  [${f.group}] ${f.prompt}`)
    for (const m of f.fails) console.log(`     - ${m}`)
    if (f.reply) console.log(`     reply: ${f.reply.slice(0, 150)}`)
  }
}
process.exit(fail ? 1 : 0)
