/**
 * Visuals — images and data charts, without leaving the machine.
 *
 * "Add a related image" has to resolve to something real and local. There are
 * three sources, tried in order:
 *
 *   1. the user's own image library at <DATA_DIR>/assets/images — real photos
 *      and diagrams, matched on filename and on tags from an optional
 *      images.json;
 *   2. a data chart, when the slide or the prompt actually contains numbers;
 *   3. a generated geometric motif, deterministic from the slide's title, so
 *      the slide gets a deliberate visual anchor rather than a stock photo.
 *
 * What is NOT here is a network fetch. Four layers of this app assume nothing
 * leaves the machine (see CLAUDE.md), and an image search would defeat all of
 * them for decoration.
 *
 * Charts are drawn in builder.js out of the same rects and text as everything
 * else, so the .pptx and the preview stay one layout pass — no chart renderer
 * to drift.
 */
import fs from 'fs'
import path from 'path'

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])

export const assetsDir = dataDir => path.join(dataDir, 'assets', 'images')

const README = `Drop images here to use them in decks.

Codeck matches an image to a slide by the words in its filename, so name files
for what they show:

  customer-onboarding-flow.png
  warehouse-logistics-photo.jpg

For extra keywords, add an images.json next to them:

  { "abc123.png": ["checkout", "payments", "mobile"] }

Nothing here is uploaded anywhere. These files are read straight off disk.
`

/** Created at boot so the folder is discoverable before it is needed. */
export function ensureAssets(dataDir) {
  const dir = assetsDir(dataDir)
  fs.mkdirSync(dir, { recursive: true })
  const readme = path.join(dir, 'README.txt')
  if (!fs.existsSync(readme)) fs.writeFileSync(readme, README)
  return dir
}

/* ── Adding images to the library ──────────────────────────────────────────── */

/** Magic bytes, so a renamed .exe cannot enter the library as a .png. */
const MAGIC = [
  { ext: '.png',  bytes: [0x89, 0x50, 0x4e, 0x47] },
  { ext: '.jpg',  bytes: [0xff, 0xd8, 0xff] },
  { ext: '.gif',  bytes: [0x47, 0x49, 0x46, 0x38] },
  { ext: '.webp', bytes: [0x52, 0x49, 0x46, 0x46], at8: [0x57, 0x45, 0x42, 0x50] },
]

function sniff(buf) {
  for (const m of MAGIC) {
    if (m.bytes.every((b, i) => buf[i] === b) && (!m.at8 || m.at8.every((b, i) => buf[8 + i] === b))) return m.ext
  }
  return null
}

/** Filename words that describe nothing — the camera's or the OS's, not yours. */
const GENERIC_WORDS = new Set([
  'image', 'images', 'photo', 'photos', 'picture', 'pic', 'pasted', 'clipboard', 'unnamed',
  'untitled', 'download', 'downloads', 'screenshot', 'screen', 'shot', 'img', 'dsc', 'pxl',
  'capture', 'copy', 'final', 'new', 'file', 'export', 'version',
])

/**
 * True when a filename carries no information about what is in the picture.
 * "Screenshot 2026-09-21 at 10.21.33.png" is generic even though it is not one
 * of a fixed list of names — what makes it useless is that every word in it is
 * either boilerplate or a number.
 */
const isGenericName = base =>
  tokens(base).filter(w => !GENERIC_WORDS.has(w) && !/^\d+$/.test(w)).length === 0

const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48)

/**
 * Copies an uploaded image into the library under a name that describes it.
 *
 * The name matters more than it looks: findImage() matches on filename words,
 * so "Screenshot 2026-09-21.png" would be unfindable forever. When the original
 * name says nothing, the words from the request that carried it are used
 * instead, and both go into images.json as tags.
 */
export function saveImage(dataDir, buffer, originalName = '', hint = '') {
  const ext = sniff(buffer)
  if (!ext) throw new Error('That file is not a PNG, JPEG, GIF or WebP image.')

  const dir = ensureAssets(dataDir)
  const base = path.basename(originalName || '', path.extname(originalName || ''))
  const hintWords = tokens(hint).filter(w => !STOP.has(w)).slice(0, 5).join('-')
  let name = slug(!base.trim() || isGenericName(base) ? (hintWords || `image-${Date.now()}`) : base)
  if (!name) name = `image-${Date.now()}`

  // Never overwrite an image already in the library — two different pictures
  // called "checkout" are both worth keeping.
  let file = `${name}${ext}`, i = 2
  while (fs.existsSync(path.join(dir, file))) file = `${name}-${i++}${ext}`
  fs.writeFileSync(path.join(dir, file), buffer)

  const tags = [...new Set([...tokens(base), ...tokens(hint)])].filter(w => !STOP.has(w)).slice(0, 12)
  if (tags.length) addTags(dataDir, file, tags)
  return { file, path: path.join(dir, file), tags }
}

/** Merges tags into images.json without disturbing entries for other files. */
export function addTags(dataDir, file, tags) {
  const manifest = path.join(assetsDir(dataDir), 'images.json')
  let map = {}
  try { map = JSON.parse(fs.readFileSync(manifest, 'utf8')) } catch {}
  map[file] = [...new Set([...(map[file] || []), ...tags])]
  fs.writeFileSync(manifest, JSON.stringify(map, null, 2))
}

export function deleteImage(dataDir, file) {
  const dir = path.resolve(assetsDir(dataDir))
  const full = path.resolve(dir, file)
  if (!full.startsWith(dir + path.sep)) throw new Error('Not a library image.')
  fs.rmSync(full, { force: true })
}

/** Words a filename or tag contributes, lowercased and de-punctuated. */
const tokens = s => String(s).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2)

const STOP = new Set([
  'the','and','for','with','that','this','from','into','add','any','some','put','use','image','images',
  'picture','pictures','photo','photos','visual','visuals','graphic','related','relevant','slide','deck',
  'page','please','make','show','something','here','about','their','they','have','has','are','was','our',
  // Filler that rides along in a chat message. Without these a tag list picks
  // up words like "one" and starts matching images to unrelated slides.
  'one','two','another','other','more','also','just','like','want','need','same','good','nice','best',
  'can','you','your','get','got','new','onto','over','under','next','then','there','where','what','how',
])

export function listImages(dataDir) {
  const dir = assetsDir(dataDir)
  let files = []
  try { files = fs.readdirSync(dir) } catch { return [] }

  let tagMap = {}
  try { tagMap = JSON.parse(fs.readFileSync(path.join(dir, 'images.json'), 'utf8')) } catch {}

  return files
    .filter(f => IMAGE_EXT.has(path.extname(f).toLowerCase()))
    .map(f => ({
      file: f,
      path: path.join(dir, f),
      terms: new Set([...tokens(path.basename(f, path.extname(f))), ...(tagMap[f] || []).flatMap(tokens)]),
    }))
}

/**
 * Best library image for a set of context words, or null.
 * Scores on shared words; a single incidental word is not enough to call an
 * image "related", so one match only counts when the library is tiny.
 */
export function findImage(dataDir, contextText) {
  const lib = listImages(dataDir)
  if (!lib.length) return null

  const want = new Set(tokens(contextText).filter(w => !STOP.has(w)))
  let best = null
  for (const img of lib) {
    let score = 0
    for (const t of img.terms) if (want.has(t)) score++
    if (score > (best?.score ?? 0)) best = { ...img, score }
  }
  if (!best) return null
  const threshold = lib.length > 6 ? 2 : 1
  return best.score >= threshold ? best : null
}

/* ── Charts ────────────────────────────────────────────────────────────────── */

const CHART_WORDS = /\b(chart|graph|plot|bar ?chart|column ?chart|analytics|visuali[sz]ation|visuali[sz]e|breakdown|split|distribution)\b/i

export const wantsChart = p => CHART_WORDS.test(p)
export const wantsImage = p => /\b(image|picture|photo|visual|graphic|illustration|icon|artwork)\b/i.test(p)

/**
 * Label/value pairs stated in the prompt itself, e.g.
 *   "chart of mobile 40%, web 35%, desktop 25%"
 *   "add a bar chart: 12 stores, 40 SKUs, 3 warehouses"
 * Returns null when the prompt carries no numbers — fabricating chart data for
 * a client deck is worse than declining, so callers must handle null.
 */
export function parseChartRequest(prompt) {
  const body = String(prompt).replace(/^.*?(?:chart|graph|plot|visuali[sz]ation)\b[:\s-]*/i, '')
  const series = []

  // "label 40%" and "40% label" are both common; take whichever the text uses.
  const re = /([A-Za-z][A-Za-z0-9 &/'-]{1,28}?)\s*[:=-]?\s*(\d+(?:\.\d+)?)\s*(%|k|m|bn|hrs?|days?|weeks?|months?)?(?=\s*(?:,|;|and|&|$))/gi
  for (const m of body.matchAll(re)) {
    const label = m[1].trim().replace(/^(?:of|the|a|an|with|for)\s+/i, '').trim()
    if (!label || label.length < 2) continue
    series.push({ label: titleish(label), value: Number(m[2]), unit: m[3] || '' })
  }

  const reFlipped = /(\d+(?:\.\d+)?)\s*(%|k|m|bn)?\s+([A-Za-z][A-Za-z0-9 &/'-]{1,28}?)(?=\s*(?:,|;|and|&|$))/gi
  if (series.length < 2) {
    for (const m of body.matchAll(reFlipped)) {
      series.push({ label: titleish(m[3].trim()), value: Number(m[1]), unit: m[2] || '' })
    }
  }

  const clean = dedupe(series).slice(0, 6)
  if (clean.length < 2) return null
  return { type: 'chart', chart: /column|vertical/i.test(prompt) ? 'column' : 'bar', title: chartTitle(prompt), series: clean }
}

/**
 * A chart built from numbers the slide already states — the honest source when
 * the prompt says "visualise this" and supplies no data of its own.
 */
export function deriveChart(node, prompt = '') {
  if (!node || typeof node !== 'object') return null
  const lines = [node.stat, ...(node.keyPoints || []), node.subtitle].filter(t => typeof t === 'string')
  const series = []
  for (const line of lines) {
    const m = line.match(/(\d+(?:\.\d+)?)\s*(%|k|m|bn|x)?/i)
    if (!m) continue
    const label = line.replace(/\d+(?:\.\d+)?\s*(%|k|m|bn|x)?/i, '').replace(/[^A-Za-z0-9 &/'-]/g, ' ').trim()
    if (!label) continue
    series.push({ label: titleish(label.split(/\s+/).slice(0, 4).join(' ')), value: Number(m[1]), unit: m[2] || '' })
  }
  const clean = dedupe(series).slice(0, 6)
  if (clean.length < 2) return null
  return { type: 'chart', chart: 'bar', title: chartTitle(prompt) || node.title || 'By the numbers', series: clean }
}

const dedupe = series => {
  const seen = new Set()
  return series.filter(s => {
    const k = s.label.toLowerCase()
    if (seen.has(k) || !Number.isFinite(s.value)) return false
    seen.add(k)
    return true
  })
}

const titleish = s => s.replace(/\s+/g, ' ').trim().replace(/^\w/, c => c.toUpperCase())

function chartTitle(prompt) {
  const m = String(prompt).match(/\b(?:chart|graph|plot|breakdown|split|distribution)\s+(?:of|for|showing)\s+([^,.:;]{3,40})/i)
  return m ? titleish(m[1]) : ''
}

/* ── Generated motif ───────────────────────────────────────────────────────── */

/**
 * A deterministic geometric composition seeded from the slide's own words.
 * It is not a photograph and does not pretend to be: it is a visual anchor for
 * a slide that has no library image and no numbers to chart, and the same
 * slide always produces the same motif so the deck does not shuffle between
 * exports.
 */
export function makeMotif(seedText) {
  return { type: 'motif', seed: String(seedText || 'copods').slice(0, 60) }
}

/** Small deterministic hash — enough to pick shapes and offsets reproducibly. */
export function motifRand(seed) {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619) }
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507)
    h = Math.imul(h ^ (h >>> 13), 3266489909)
    return ((h ^= h >>> 16) >>> 0) / 4294967296
  }
}
