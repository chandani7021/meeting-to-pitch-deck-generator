import PptxGenJS from 'pptxgenjs'
import path from 'path'
import fs from 'fs'
import { createSpecTarget, createPptxTarget, markSlide, markLastItems, itemCount, markSince } from './slideSpec.js'
import { motifRand } from './visuals.js'

// ── Brand tokens ─────────────────────────────────────────────────────────────
const T = {
  white:  'FFFFFF',
  bg:     'FFFFFF',
  dark:   '14142A',   // near-black – headings
  body:   '3C3C46',   // body text
  muted:  '8C8C96',   // captions / labels
  line:   'D5D5DA',   // separator lines
  purple: '2F215C',   // Copods brand purple
  lilac:  'FBF3EA',   // warm cream tint – card fill (was light purple)
  or1:    'D05C10',   // orange dark  (Discover)
  or2:    'E07828',   // orange mid   (Define)
  or3:    'ED9644',   // orange light (Develop)
  or4:    'F6B870',   // orange pale  (Deploy)
  font:   'Calibri',
}

const W = 10      // slide width  (inches)
const H = 5.625   // slide height (inches)
const M = 0.42    // left/right margin

// ── Text-fit helpers ──────────────────────────────────────────────────────────
// pptxgenjs never measures text, so fixed-height slots silently overlap once
// content wraps to more lines than assumed. These helpers estimate wrapped line
// count from character width and let each block size itself to what it holds.

/** Rough wrapped-line count for `text` set in `fontSize`pt across `widthIn` inches. */
function estLines(text, widthIn, fontSize) {
  const len = String(text ?? '').length
  if (!len) return 1
  const avgCharWidthIn = (fontSize * 0.52) / 72   // Calibri average glyph width heuristic
  const charsPerLine = Math.max(4, Math.floor(widthIn / avgCharWidthIn))
  return Math.max(1, Math.ceil(len / charsPerLine))
}

function lineHeightIn(fontSize, lineSpacingMult = 1.3) {
  return (fontSize * 1.2 * lineSpacingMult) / 72
}

/** Height a single text block needs to render `text` without clipping/overlap. */
function textH(text, widthIn, fontSize, lineSpacingMult = 1.3, pad = 0) {
  return estLines(text, widthIn, fontSize) * lineHeightIn(fontSize, lineSpacingMult) + pad
}

/**
 * Pick the largest font size (from `base` down to `min`, in 0.5pt steps) at which
 * every item in `items` stacked with `gap` between them fits inside `boxH`.
 * Falls back to `min` if it still doesn't fit — better a dense slide than an
 * overlapping one.
 */
function fitFontForList(items, widthIn, boxH, { base, min = 8, lineSpacingMult = 1.3, padPerItem = 0.08, gap = 0.05 } = {}) {
  let fontSize = base
  while (fontSize > min) {
    const total = items.reduce((sum, t) => sum + textH(t, widthIn, fontSize, lineSpacingMult, padPerItem), 0)
      + gap * Math.max(items.length - 1, 0)
    if (total <= boxH) return fontSize
    fontSize -= 0.5
  }
  return min
}

/** Per-item heights at a given font size (for stacking items with variable row heights). */
function listItemHeights(items, widthIn, fontSize, lineSpacingMult = 1.3, padPerItem = 0.08) {
  return items.map(t => textH(t, widthIn, fontSize, lineSpacingMult, padPerItem))
}

/**
 * Fit a single text block into a box: shrink font first, and if it's still too
 * long even at the min font, truncate with an ellipsis. Guarantees the block
 * never spills into whatever sits below it.
 */
function fitSingleText(text, widthIn, boxH, { base, min = 8, lineSpacingMult = 1.3 } = {}) {
  const str = String(text ?? '')
  const fontSize = fitFontForList([str], widthIn, boxH, { base, min, lineSpacingMult, padPerItem:0, gap:0 })
  if (textH(str, widthIn, fontSize, lineSpacingMult) <= boxH || str.length < 20) {
    return { fontSize, text:str }
  }
  let lo = 0
  let hi = str.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    const candidate = `${str.slice(0, mid).trimEnd()}…`
    if (textH(candidate, widthIn, fontSize, lineSpacingMult) <= boxH) lo = mid
    else hi = mid - 1
  }
  return { fontSize, text: lo >= str.length ? str : `${str.slice(0, lo).trimEnd()}…` }
}

// ── Shared primitives ─────────────────────────────────────────────────────────

/** Standard white header: copods wordmark · orange section label · separator */
function hdr(slide, title, sub) {
  title = (title ?? '').toString() || 'Untitled'
  slide.addShape('rect', { x:0, y:0, w:W, h:H, fill:{color:T.white}, line:{color:T.white} })

  slide.addText('copods', {
    x:M, y:0.10, w:1.5, h:0.30,
    fontSize:14, bold:true, color:T.purple, fontFace:T.font,
  })
  slide.addText(title.toUpperCase(), {
    x:M, y:0.44, w:W - M*2, h:0.24,
    fontSize:9, bold:true, color:T.or1, fontFace:T.font, charSpacing:2.5,
  })
  if (sub) {
    slide.addText(sub, {
      x:M, y:0.68, w:W - M*2, h:0.22,
      fontSize:9.5, color:T.muted, fontFace:T.font, italic:true,
    })
  }
  const sepY = sub ? 0.92 : 0.76
  slide.addShape('rect', { x:M, y:sepY, w:W - M*2, h:0.012, fill:{color:T.line}, line:{color:T.line} })
}

/** Footer: org · date on left, n/total on right */
function ftr(slide, n, total, org, date) {
  slide.addText(`${org}  ·  ${date}`, {
    x:M, y:H - 0.24, w:W - 1.2, h:0.22,
    fontSize:7.5, color:T.muted, fontFace:T.font, valign:'middle',
  })
  slide.addText(`${n} / ${total}`, {
    x:W - 1.0, y:H - 0.24, w:0.65, h:0.22,
    fontSize:7.5, color:T.muted, fontFace:T.font, align:'right', valign:'middle',
  })
}

/** Light lilac card background (replaces old lavender contentBox) */
function card(slide, x, y, w, h, opts = {}) {
  slide.addShape('rect', {
    x, y, w, h,
    fill: { color: opts.fill ?? T.lilac },
    line: { color: opts.border ?? 'EEE1CC', pt:0.75 },
    rectRadius: opts.r ?? 0.10,
  })
}

/** Small orange circle bullet */
function dot(slide, x, y) {
  slide.addShape('ellipse', { x, y, w:0.07, h:0.07, fill:{color:T.or1}, line:{color:T.or1} })
}

/** Downward flow-arrow between two stacked sections in a column */
function flowDown(slide, x, y, w) {
  slide.addText('⌄', { x, y, w, h:0.16, fontSize:12, bold:true, color:T.or2, fontFace:T.font, align:'center' })
}

/**
 * Renders one or more headed bullet-list sections stacked in a single column
 * (e.g. "Audience Insight" then "Goals"), sizing one shared font across all
 * their items so nothing overlaps regardless of how much text each holds.
 * Each section can supply a custom per-item renderer (for e.g. label:value
 * impact rows) while still sharing the same height/overlap-safe layout.
 */
function columnSections(slide, x, w, y0, availH, sections, { headerH = 0.29, arrowH = 0.18, base = 9.5, min = 7.5, lineSpacingMult = 1.3, dotOffsetX = 0.04, textOffsetX = 0.20, itemGap = 0.05 } = {}) {
  const active = sections.filter(sec => sec.items?.length)
  if (!active.length) return

  const headersTotal = active.length * headerH
  const arrowsTotal = arrowH * (active.length - 1)
  const itemsAvailH = Math.max(0.3, availH - headersTotal - arrowsTotal)
  const textW = w - textOffsetX - 0.06
  const allEstTexts = active.flatMap(sec => sec.items.map(sec.estText || (i => i)))
  const fontSize = fitFontForList(allEstTexts, textW, itemsAvailH, { base, min, lineSpacingMult, padPerItem:0, gap:itemGap })

  // Hard floor: even at min font, pathologically long/plentiful content could
  // still exceed the box. Rather than let it spill past the slide edge, stop
  // rendering once we hit the bottom boundary — a slide that's slightly
  // shorter than the source content beats one that overlaps the footer.
  const yMax = y0 + availH
  let y = y0
  sectionLoop:
  for (let si = 0; si < active.length; si++) {
    const sec = active[si]
    if (y + headerH > yMax) break
    slide.addText(sec.title, {
      x, y, w, h:headerH - 0.01,
      fontSize:10.5, bold:true, color:T.dark, fontFace:T.font,
    })
    y += headerH
    const estTexts = sec.items.map(sec.estText || (i => i))
    const heights = listItemHeights(estTexts, textW, fontSize, lineSpacingMult, 0)
    for (let i = 0; i < sec.items.length; i++) {
      const item = sec.items[i]
      const h = heights[i]
      if (y + h > yMax && !(si === 0 && i === 0)) break sectionLoop
      if (sec.render) {
        sec.render(slide, item, x, y, w, h, fontSize, textW, textOffsetX, dotOffsetX)
      } else {
        dot(slide, x + dotOffsetX, y + h / 2 - 0.035)
        slide.addText(item, {
          x:x + textOffsetX, y, w:textW, h,
          fontSize, color:T.body, fontFace:T.font, valign:'middle', wrap:true, lineSpacingMultiple:lineSpacingMult,
        })
      }
      y += h + itemGap
    }
    if (si < active.length - 1) {
      if (y + arrowH > yMax) break
      flowDown(slide, x, y, w)
      y += arrowH
    }
  }
}

/**
 * A dotted bullet list that sizes its own font and per-item height to what the
 * text actually needs, then centers the whole stack in the given box — instead
 * of dividing the box into equal slots that overflow once text wraps.
 */
function bulletList(slide, items, { x, y, w, boxH, base, min = 9, lineSpacingMult = 1.35, gap = 0.10, color = T.dark, dotOffsetX = 0.20, textOffsetX = 0.36, src = null }) {
  const textW = w - textOffsetX - 0.08
  const fontSize = fitFontForList(items, textW, boxH - gap * Math.max(items.length - 1, 0), { base, min, lineSpacingMult, padPerItem:0, gap })
  const heights = listItemHeights(items, textW, fontSize, lineSpacingMult, 0)

  // Even at the min font, pathologically long/plentiful content could still
  // overshoot boxH — drop trailing items rather than spill past the box.
  let shown = items.length
  let acc = 0
  for (let i = 0; i < items.length; i++) {
    const add = heights[i] + (i > 0 ? gap : 0)
    if (acc + add > boxH && i > 0) { shown = i; break }
    acc += add
  }
  const shownItems = items.slice(0, shown)
  const shownHeights = heights.slice(0, shown)

  const totalH = shownHeights.reduce((a, b) => a + b, 0) + gap * Math.max(shownItems.length - 1, 0)
  let cy = y + Math.max(0, (boxH - totalH) / 2)
  shownItems.forEach((item, i) => {
    const h = shownHeights[i]
    dot(slide, x + dotOffsetX, cy + h / 2 - 0.035)
    slide.addText(item, {
      x:x + textOffsetX, y:cy, w:textW, h,
      fontSize, color, fontFace:T.font, valign:'middle', wrap:true, lineSpacingMultiple:lineSpacingMult,
    })
    if (src) markLastItems(slide, 1, `${src}/${i}`)
    cy += h + gap
  })
}

/** Cover / closing tagline block */
function brandFooter(slide, orgName, tagline) {
  const y = H - 0.60
  slide.addShape('rect', { x:M, y:y - 0.04, w:3.5, h:0.012, fill:{color:T.or2}, line:{color:T.or2} })
  slide.addText(orgName.toLowerCase(), {
    x:M, y, w:1.4, h:0.34,
    fontSize:16, bold:true, color:T.purple, fontFace:T.font,
  })
  if (tagline) {
    slide.addText(tagline, {
      x:M + 1.55, y:y + 0.07, w:4.8, h:0.22,
      fontSize:9, color:T.muted, fontFace:T.font, italic:true,
    })
  }
}

// ── Case-study slide (full structured layout) ─────────────────────────────────


/* ── Per-slide styling ──────────────────────────────────────────────────────
   Every colour in this file is a fixed brand token, which is correct for a
   house deck but leaves no way to answer "make slide 5 black". Rather than
   thread a palette through nine hundred lines of drawing code, a styled slide
   is wrapped: the background is painted first, and every draw call afterwards
   has its colours checked against that background. Anything that would become
   invisible is swapped for a legible equivalent.

   The wrapper sits in builder.js, so the .pptx and the preview get the same
   treatment from the same pass — invariant 1 holds. */

const hex6 = c => {
  const raw = (typeof c === 'object' && c ? c.color : c) || ''
  const v = String(raw).replace('#', '').trim()
  return /^[0-9a-fA-F]{6}$/.test(v) ? v.toUpperCase() : null
}

/** WCAG relative luminance. */
function luminance(hexStr) {
  const n = parseInt(hexStr, 16)
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => {
    const x = v / 255
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2]
}

const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

/** Blends two colours, for deriving a card fill that reads against the bg. */
function mix(a, b, t) {
  const pa = parseInt(a, 16), pb = parseInt(b, 16)
  const out = [16, 8, 0].map(sh => {
    const va = (pa >> sh) & 255, vb = (pb >> sh) & 255
    return Math.round(va + (vb - va) * t)
  })
  return out.map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase()
}

/**
 * The palette a styled slide draws with.
 * `text` is whatever stays readable on the background unless the user named one.
 */
function paletteFor(style) {
  const bg = hex6(style.background) || T.white
  const text = hex6(style.text) || (luminance(bg) < 0.4 ? 'FFFFFF' : T.dark)
  return {
    bg, text,
    // Cards are a tint of the background rather than a fixed cream, so they
    // still read as raised panels on a dark slide.
    card: mix(bg, text, 0.10),
    cardLine: mix(bg, text, 0.22),
    muted: mix(bg, text, 0.62),
  }
}

/** Minimum contrast before a colour is considered lost against the background. */
const MIN_TEXT_CONTRAST = 3.0
const MIN_FILL_CONTRAST = 1.18

/**
 * Wraps a slide so its draw calls are recoloured for `style`.
 * Brand colours that already stand out (the orange accents) are left alone —
 * only what would vanish gets replaced.
 */
function styledSlide(slide, style) {
  const P = paletteFor(style)

  const fixText = c => {
    const h = hex6(c)
    if (!h) return c
    if (contrast(h, P.bg) >= MIN_TEXT_CONTRAST) return c   // still legible, keep the brand colour
    // The near-black body and heading tokens become the palette's text colour;
    // anything else that got lost lands on the same colour rather than guessing.
    return P.text
  }

  const fixFill = (c, box) => {
    const h = hex6(c)
    if (!h) return c
    // hdr() repaints the entire slide white before drawing. Mapping that to a
    // card tint would mean the background colour was never visible at all.
    if (box && box.x === 0 && box.y === 0 && box.w === W && box.h === H) return P.bg
    if (h === T.lilac || h === T.white) return P.card      // card and panel fills
    if (h === T.line) return P.cardLine                    // hairlines and rules
    if (contrast(h, P.bg) >= MIN_FILL_CONTRAST) return c   // brand blocks stay
    return P.cardLine
  }

  const wrapColor = (o, key, fn) => {
    if (o?.[key] === undefined) return
    o[key] = typeof o[key] === 'object' && o[key] !== null
      ? { ...o[key], color: fn(o[key].color) ?? o[key].color }
      : fn(o[key])
  }

  const fixOpts = (opts = {}) => {
    const o = { ...opts }
    const box = o
    wrapColor(o, 'color', fixText)
    wrapColor(o, 'fill', c => fixFill(c, box))
    wrapColor(o, 'line', c => fixFill(c, box))
    return o
  }

  // A run array carries its own per-run colours and needs the same treatment.
  const fixRuns = t => Array.isArray(t)
    ? t.map(r => (r && r.options ? { ...r, options: fixOpts(r.options) } : r))
    : t

  return {
    __slide: slide.__slide,
    addText: (text, opts = {}) => slide.addText(fixRuns(text), fixOpts(opts)),
    addShape: (type, opts = {}) => slide.addShape(type, fixOpts(opts)),
    addTable: (rows, opts = {}) => slide.addTable(
      (rows || []).map(row => (row || []).map(cell =>
        (cell && typeof cell === 'object' && cell.options)
          ? { ...cell, options: fixOpts(cell.options) } : cell)),
      fixOpts(opts)),
    addImage: (opts = {}) => slide.addImage(opts),
  }
}

/* ── Visuals: images, data charts and generated motifs ──────────────────────
   All three are drawn with the same primitives as every other block, so the
   .pptx and the HTML preview still come from one layout pass. A chart here is
   rectangles, not a chart widget — that is deliberate: a pptxgenjs native chart
   would have no equivalent in the preview and the two would drift. */

const VIS_TRACK = '463A72'   // bar track on the purple panel

/** The purple panel every visual sits on, so they read as one family. */
function visualPanel(slide, x, y, w, h) {
  slide.addShape('rect', { x, y, w, h, fill:{color:T.purple}, line:{color:T.purple}, rectRadius:0.10 })
}

function visLabel(slide, text, x, y, w) {
  slide.addText(String(text).toUpperCase(), {
    x, y, w, h:0.22, fontSize:7.5, bold:true, color:T.or4, fontFace:T.font, charSpacing:1.5,
  })
}

const fmtVal = r => `${r.value}${r.unit ? (r.unit === '%' ? '%' : ` ${r.unit}`) : ''}`

/** Horizontal bars — the readable default when labels are words, not dates. */
function barChart(slide, chart, x, y, w, h) {
  visualPanel(slide, x, y, w, h)
  let cy = y + 0.20
  if (chart.title) { visLabel(slide, chart.title, x + 0.18, cy, w - 0.36); cy += 0.32 }

  const rows = (chart.series || []).slice(0, 6)
  if (!rows.length) return
  const max = Math.max(...rows.map(r => Number(r.value) || 0)) || 1
  const availH = y + h - cy - 0.14
  const rowH = Math.min(0.62, availH / rows.length)
  const barH = Math.max(0.09, Math.min(0.17, rowH * 0.32))
  const tx = x + 0.18, tw = w - 0.36
  const valW = 0.86

  rows.forEach((r, i) => {
    const ry = cy + i * rowH
    slide.addText(r.label, {
      x:tx, y:ry, w:tw - valW, h:rowH * 0.46,
      fontSize:8.5, color:T.white, fontFace:T.font, valign:'middle', wrap:false,
    })
    slide.addText(fmtVal(r), {
      x:tx + tw - valW, y:ry, w:valW, h:rowH * 0.46,
      fontSize:9, bold:true, color:T.or4, fontFace:T.font, align:'right', valign:'middle',
    })
    const by = ry + rowH * 0.50
    slide.addShape('rect', { x:tx, y:by, w:tw, h:barH, fill:{color:VIS_TRACK}, line:{color:VIS_TRACK}, rectRadius:barH/2 })
    // A zero-width bar is invisible and looks like a render bug, so the minimum
    // width is the cap radius — the value label carries the real number anyway.
    const bw = Math.max(barH, tw * ((Number(r.value) || 0) / max))
    slide.addShape('rect', { x:tx, y:by, w:bw, h:barH, fill:{color:T.or2}, line:{color:T.or2}, rectRadius:barH/2 })
  })
}

/** Vertical columns — for short labels, or when the user asks for them. */
function columnChart(slide, chart, x, y, w, h) {
  visualPanel(slide, x, y, w, h)
  let top = y + 0.20
  if (chart.title) { visLabel(slide, chart.title, x + 0.18, top, w - 0.36); top += 0.32 }

  const rows = (chart.series || []).slice(0, 6)
  if (!rows.length) return
  const max = Math.max(...rows.map(r => Number(r.value) || 0)) || 1
  const labelH = 0.30, valueH = 0.22
  const plotY = top + valueH
  const plotH = Math.max(0.3, y + h - plotY - labelH - 0.12)
  const gap = 0.10
  const colW = (w - 0.36 - gap * (rows.length - 1)) / rows.length

  rows.forEach((r, i) => {
    const cx = x + 0.18 + i * (colW + gap)
    const ch = Math.max(0.06, plotH * ((Number(r.value) || 0) / max))
    slide.addText(fmtVal(r), {
      x:cx, y:plotY + plotH - ch - valueH, w:colW, h:valueH,
      fontSize:8.5, bold:true, color:T.or4, fontFace:T.font, align:'center', valign:'bottom',
    })
    slide.addShape('rect', { x:cx, y:plotY + plotH - ch, w:colW, h:ch, fill:{color:T.or2}, line:{color:T.or2}, rectRadius:0.05 })
    slide.addText(r.label, {
      x:cx, y:plotY + plotH + 0.04, w:colW, h:labelH,
      fontSize:7.5, color:T.white, fontFace:T.font, align:'center', valign:'top', lineSpacingMultiple:1.1,
    })
  })
}

/**
 * A real image from the user's library. `path` is what pptxgenjs reads off
 * disk; `url` is what the preview fetches from the local server. Only one of
 * them is meaningful per target, but emitting both keeps this a single call.
 */
function imageBlock(slide, visual, x, y, w, h, { dataDir, isSpec }) {
  const abs = path.join(dataDir, 'assets', 'images', visual.file)
  if (!fs.existsSync(abs)) {
    // The library file was deleted after the deck referenced it. Say so on the
    // slide rather than exporting a .pptx that silently loses the image.
    visualPanel(slide, x, y, w, h)
    slide.addText(`Image not found:\n${visual.file}`, {
      x:x + 0.18, y:y + 0.18, w:w - 0.36, h:h - 0.36,
      fontSize:9, color:T.or4, fontFace:T.font, align:'center', valign:'middle',
    })
    return
  }

  const pad = 0.10
  const capH = visual.alt ? 0.28 : 0
  card(slide, x, y, w, h)
  const iw = w - pad * 2, ih = h - pad * 2 - capH
  slide.addImage({
    ...(isSpec ? { url: `/api/studio/asset/${encodeURIComponent(visual.file)}` } : { path: abs }),
    x:x + pad, y:y + pad, w:iw, h:ih,
    sizing: { type:'contain', w:iw, h:ih },
  })
  if (visual.alt) {
    slide.addText(visual.alt, {
      x:x + pad, y:y + h - capH - 0.02, w:iw, h:capH,
      fontSize:8, color:T.muted, fontFace:T.font, align:'center', valign:'middle', wrap:true,
    })
  }
}

/**
 * A generated geometric motif, seeded from the slide's own title so the same
 * slide always draws the same composition — a deck must not reshuffle between
 * the preview and the export, or between two exports.
 */
function motifBlock(slide, visual, x, y, w, h) {
  visualPanel(slide, x, y, w, h)
  const rnd = motifRand(visual.seed || 'copods')
  const palette = [T.or1, T.or2, T.or3, T.or4]
  const count = 4 + Math.floor(rnd() * 3)

  for (let i = 0; i < count; i++) {
    const size = (0.26 + rnd() * 0.46) * Math.min(w, h)
    const cx = x + rnd() * Math.max(0.01, w - size)
    const cy = y + rnd() * Math.max(0.01, h - size)
    const color = palette[Math.floor(rnd() * palette.length)]
    const opts = { fill:{ color, transparency: 55 }, line:{ color, transparency: 55 } }
    if (rnd() < 0.5) slide.addShape('ellipse', { x:cx, y:cy, w:size, h:size, ...opts })
    else slide.addShape('rect', { x:cx, y:cy, w:size, h:size * 0.7, rectRadius:0.10, ...opts })
  }
  // One solid accent keeps the composition from reading as noise.
  slide.addShape('rect', { x:x + 0.18, y:y + h - 0.34, w:Math.min(1.1, w - 0.36), h:0.07,
    fill:{color:T.or2}, line:{color:T.or2}, rectRadius:0.035 })
}

/** Draws whichever visual a node carries. Unknown types draw nothing. */
function drawVisual(slide, visual, x, y, w, h, ctx = {}) {
  if (!visual || typeof visual !== 'object') return false
  if (visual.type === 'image' && visual.file) { imageBlock(slide, visual, x, y, w, h, ctx); return true }
  if (visual.type === 'chart' && Array.isArray(visual.series) && visual.series.length) {
    (visual.chart === 'column' ? columnChart : barChart)(slide, visual, x, y, w, h)
    return true
  }
  if (visual.type === 'motif') { motifBlock(slide, visual, x, y, w, h); return true }
  return false
}

/** The existing KEY STAT panel, lifted out so a visual can share the column. */
function statPanel(slide, stat, x, y, w, h) {
  slide.addShape('rect', { x, y, w, h, fill:{color:T.purple}, line:{color:T.purple}, rectRadius:0.10 })
  slide.addText('KEY STAT', {
    x, y:y + Math.min(0.28, h * 0.12), w, h:0.26,
    fontSize:7.5, bold:true, color:T.or4, fontFace:T.font, align:'center', charSpacing:2,
  })
  const ruleY = y + Math.min(0.56, h * 0.26)
  slide.addShape('rect', { x:x + 0.30, y:ruleY, w:w - 0.60, h:0.012, fill:{color:T.or2}, line:{color:T.or2} })
  slide.addText(stat, {
    x, y:ruleY + 0.09, w, h:Math.max(0.3, y + h - ruleY - 0.18),
    fontSize:14.5, bold:true, color:T.white, fontFace:T.font,
    align:'center', valign:'middle', wrap:true, lineSpacingMultiple:1.4,
  })
}

function addCaseStudySlide(mkSlide, cs, n, total, orgName, fmtDate, srcPath) {
  // Built by the caller's factory, so a styled case-study slide is recoloured
  // like every other one. This function is outside buildPresentation's scope.
  const s = mkSlide('caseStudy', srcPath, cs.title || 'Case Study')

  // Base background. On a styled slide the wrapper maps white to the slide's
  // own card tint, so this stays a no-op rather than painting over the style.
  s.addShape('rect', { x:0, y:0, w:W, h:H, fill:{color:T.white}, line:{color:T.white} })

  // Copods wordmark + "SUCCESS STORY" label
  s.addText('copods', {
    x:M, y:0.09, w:1.2, h:0.28,
    fontSize:14, bold:true, color:T.purple, fontFace:T.font,
  })
  s.addText('SUCCESS STORY', {
    x:M, y:0.38, w:1.8, h:0.18,
    fontSize:6.5, bold:true, color:T.muted, fontFace:T.font, charSpacing:1.5,
  })

  // Process-stage diagram (top-right)
  const stageLabels = cs.stages    || ['Discover', 'Define', 'Develop', 'Deploy']
  const stageSubs   = cs.stageSubs || ['"What?"',  '"Why?"',  '"How?"',  '"How Much?"']
  const stageCols   = [T.or1, T.or2, T.or3, T.or4]
  const bw = 0.84, bh = 0.50, bgap = 0.15
  const bx0 = W - stageLabels.length * (bw + bgap) + bgap - M
  stageLabels.forEach((stg, i) => {
    const bx = bx0 + i * (bw + bgap)
    s.addShape('rect', { x:bx, y:0.07, w:bw, h:bh, fill:{color:stageCols[i%4]}, line:{color:stageCols[i%4]}, rectRadius:0.04 })
    // Shrink the label to whatever fits on one line — a longer word (e.g. "Development"
    // instead of "Develop") must never wrap, since the box is anchored bottom/top and a
    // wrapped second line renders clipped above/below the shape.
    let stgFont = 9
    while (stgFont > 6 && estLines(stg, bw, stgFont) > 1) stgFont -= 0.5
    s.addText(stg, {
      x:bx, y:0.09, w:bw, h:0.24, margin:0,
      fontSize:stgFont, bold:true, color:T.white, fontFace:T.font, align:'center', valign:'bottom', wrap:false,
    })
    s.addText(stageSubs[i] || '', {
      x:bx, y:0.32, w:bw, h:0.20, margin:0,
      fontSize:7.5, color:T.white, fontFace:T.font, align:'center', valign:'top', wrap:false,
    })
    if (i < stageLabels.length - 1) {
      s.addText('›', {
        x:bx + bw + 0.01, y:0.16, w:bgap - 0.02, h:0.20, margin:0,
        fontSize:13, bold:true, color:stageCols[i % 4], fontFace:T.font, align:'center', valign:'middle', wrap:false,
      })
    }
  })

  // Header separator line
  s.addShape('rect', { x:M, y:0.64, w:W - M*2, h:0.012, fill:{color:T.line}, line:{color:T.line} })

  // Title
  const title = cs.title || cs.industry || 'Case Study'
  s.addText(title, {
    x:M, y:0.70, w:W * 0.82, h:0.48,
    fontSize:18, bold:true, color:T.dark, fontFace:T.font, wrap:true,
  })

  // Description
  const desc = cs.description || cs.summary || ''
  if (desc) {
    s.addText(desc, {
      x:M, y:1.21, w:W - M*2, h:0.35,
      fontSize:9, color:T.body, fontFace:T.font, wrap:true, lineSpacingMultiple:1.35,
    })
  }

  // ── Two-column layout ─────────────────────────────────────────────────────
  const colY = 1.60
  const colH = H - colY - 0.52
  const lcW  = 4.35
  const divX = M + lcW + 0.09
  const rcX  = divX + 0.11
  const rcW  = W - rcX - M

  s.addShape('rect', { x:divX, y:colY, w:0.012, h:colH, fill:{color:T.line}, line:{color:T.line} })

  // Flow arrow across the divider — visualises Goals → Solution progression;
  // only drawn when both sides of the story actually exist for this case study.
  if ((cs.goals || []).length && (cs.solution || []).length) {
    s.addShape('ellipse', { x:divX - 0.10, y:colY + colH/2 - 0.10, w:0.20, h:0.20, fill:{color:T.white}, line:{color:T.or1, pt:1} })
    s.addText('›', { x:divX - 0.10, y:colY + colH/2 - 0.115, w:0.20, h:0.20, fontSize:12, bold:true, color:T.or1, fontFace:T.font, align:'center', valign:'middle' })
  }

  // ── LEFT: Audience Insight → Goals ────────────────────────────────────────
  const audience = cs.audience || []
  const goals    = cs.goals || []
  columnSections(s, M, lcW, colY, colH, [
    { title:'Audience Insight', items:audience },
    { title:'Goals', items:goals },
  ])

  // ── RIGHT: Solution → Business Impact ────────────────────────────────────
  const solution = cs.solution || []
  const rawImpact = cs.impact || (cs.result ? [{ label:'Result', value:cs.result }] : [])
  columnSections(s, rcX, rcW, colY, colH, [
    { title:'Solution', items:solution },
    {
      title:'Business Impact',
      items:rawImpact,
      estText: item => {
        const label = typeof item === 'string' ? '' : (item.label || '')
        const value = typeof item === 'string' ? item : (item.value || '')
        return label ? `${label}  ${value}` : value
      },
      render: (slide, item, x, y, w, h, fontSize, textW, textOffsetX, dotOffsetX) => {
        const label = typeof item === 'string' ? '' : (item.label || '')
        const value = typeof item === 'string' ? item : (item.value || '')
        dot(slide, x + dotOffsetX, y + h / 2 - 0.035)
        slide.addText([
          { text: label + (label ? '  ' : ''), options:{ bold:true, color:T.dark } },
          { text: value,                        options:{ bold:false, color:T.body } },
        ], {
          x:x + textOffsetX, y, w:textW, h,
          fontSize, fontFace:T.font, valign:'middle', wrap:true,
        })
      },
    },
  ])

  // ── Bottom separator + tech stack ─────────────────────────────────────────
  // Rendered as pill tags (not plain text) so it reads as a distinct "stack" strip
  // rather than blending into the page. Sits above the footer band (footer text
  // starts at H-0.24) — must not overlap it.
  s.addShape('rect', { x:0, y:H - 0.48, w:W, h:0.012, fill:{color:T.line}, line:{color:T.line} })
  const stack = cs.techStack || []
  if (stack.length) {
    const tagFont = 8
    const tagH = 0.19
    const tagY = H - 0.44
    const gap = 0.10
    const availW = W - M*2
    const charW = (tagFont * 0.52) / 72
    let widths = stack.map(t => Math.min(1.5, Math.max(0.55, String(t).length * charW + 0.24)))
    const totalW = widths.reduce((a, b) => a + b, 0) + gap * (stack.length - 1)
    if (totalW > availW) {
      const scale = availW / totalW
      widths = widths.map(w => w * scale)
    }
    let tx = M
    stack.forEach((tech, i) => {
      const tw = widths[i]
      s.addShape('rect', { x:tx, y:tagY, w:tw, h:tagH, fill:{color:T.lilac}, line:{color:'EEE1CC', pt:0.75}, rectRadius:tagH / 2 })
      s.addText(tech, {
        x:tx, y:tagY, w:tw, h:tagH, margin:0,
        fontSize:tagFont, bold:true, color:T.purple, fontFace:T.font, align:'center', valign:'middle', wrap:false,
      })
      tx += tw + gap
    })
  }

  ftr(s, n, total, orgName, fmtDate)
  return s
}

// ── Main export ───────────────────────────────────────────────────────────────
export async function buildPresentation(meetingData, dataDir, orgConfig = {}, opts = {}) {
  const { orgName: configOrg = 'Our Company', orgTagline = '', services = null } = orgConfig
  const { target = 'pptx' } = opts

  // One layout pass, two renderers. 'spec' records the draw calls for the live
  // HTML preview; 'pptx' writes a real file. See slideSpec.js.
  const isSpec = target === 'spec'
  const pptxInstance = isSpec ? null : new PptxGenJS()
  const pptx = isSpec ? createSpecTarget() : createPptxTarget(pptxInstance)
  pptx.layout = 'LAYOUT_16x9'

  const {
    orgName:          rawOrg      = '',
    clientName                    = 'Client',
    clientIndustry                = '',
    meetingDate                   = new Date().toISOString().split('T')[0],
    deckTitle,
    proposalTitle,
    meetingTitle,
    executiveSummary              = '',
    clientNeeds                   = [],
    proposedSolutions             = [],
    topics                        = [],
    whyCopods                     = null,
    engagementModel               = null,
    nextSteps                     = [],
    actionItems                   = [],
    webFindings                   = [],
    deckType                      = '',
    labels                        = {},
  } = meetingData

  // Destructuring defaults only fire for `undefined`. A chat edit or a local
  // model can leave an explicit `null`, which would sail past them and crash on
  // `.length`, so normalise here rather than guarding at every use site.
  const arr = v => (Array.isArray(v) ? v : [])
  // Visuals live in two places by design: on an array item (`solution.visual`),
  // which is where the model can reach them, and in a deck-level map keyed by
  // slide path, which is the only way to attach one to a slide whose source is
  // a bare string (the executive summary). visualFor() hides the difference.
  const deckVisuals = meetingData.visuals && typeof meetingData.visuals === 'object' ? meetingData.visuals : {}
  const visualFor = (srcPath, node) => node?.visual || deckVisuals[srcPath] || null
  const visualCtx = { dataDir, isSpec }

  // Per-slide look, keyed by the same slide path the chat resolves. Declared
  // next to the visuals map because they are the same idea: presentation the
  // user chose, layered over content the model produced.
  const deckStyles = meetingData.styles && typeof meetingData.styles === 'object' ? meetingData.styles : {}

  /**
   * Creates a slide, stamps its provenance, and applies any style override.
   * The background is painted before anything else so it sits behind the deck's
   * own drawing, and the returned slide recolours every later call.
   */
  const newSlide = (kind, srcPath, label) => {
    const s = pptx.addSlide()
    markSlide(s, kind, srcPath, label)
    const style = (srcPath && deckStyles[srcPath]) || deckStyles[kind] || null
    if (!style) return s
    const P = paletteFor(style)
    s.addShape('rect', { x: 0, y: 0, w: W, h: H, fill: { color: P.bg }, line: { color: P.bg } })
    return styledSlide(s, style)
  }
  const clientNeedsN = arr(clientNeeds)
  const proposedSolutionsN = arr(proposedSolutions)
  const topicsN = arr(topics)
  const nextStepsN = arr(nextSteps)
  const actionItemsN = arr(actionItems)
  const webFindingsN = arr(webFindings)
  const labelsN = labels && typeof labels === 'object' ? labels : {}
  const deckTypeN = typeof deckType === 'string' ? deckType : ''

  const orgName = (configOrg && configOrg !== 'Our Company') ? configOrg : (rawOrg || configOrg)
  const resolvedTitle = deckTitle || proposalTitle || meetingTitle || clientName || 'Presentation'
  const isProposal = deckTypeN === 'proposal' || (!deckTypeN && whyCopods != null && engagementModel != null)
  const solutionSlides = proposedSolutionsN.length > 0 ? proposedSolutionsN : topicsN
  const actionSlides   = nextStepsN.length > 0 ? nextStepsN : actionItemsN
  // Which deck-JSON field the above actually resolved to, for provenance paths
  const solutionKey    = proposedSolutionsN.length > 0 ? 'proposedSolutions' : 'topics'
  const actionKey      = nextStepsN.length > 0 ? 'nextSteps' : 'actionItems'

  const caseStudyItems = whyCopods
    ? (Array.isArray(whyCopods.relevantCaseStudies) && whyCopods.relevantCaseStudies.length
        ? whyCopods.relevantCaseStudies
        : whyCopods.relevantCaseStudy
          ? [{ title:'Case Study', description: whyCopods.relevantCaseStudy, impact:[] }]
          : [])
    : []
  const hasCaseStudySlide = caseStudyItems.length > 0
  const hasServicesSlide  = isProposal && services != null

  const lCover    = labelsN.cover    || (isProposal ? 'PROPOSAL' : deckTypeN.toUpperCase().replace(/_/g, '\n') || 'DECK')
  const lOverview = labelsN.overview || (isProposal ? 'Our Understanding' : 'Overview')
  const lNeeds    = labelsN.needs    || (isProposal ? 'Your Key Challenges' : 'Key Areas')
  const lClosing  = labelsN.closing  || (isProposal ? "Let's Build\nTogether" : 'Thank You')

  const fmtDate = new Date(meetingDate + 'T12:00:00').toLocaleDateString('en-US', {
    year:'numeric', month:'long', day:'numeric',
  })

  const total = 1
    + (String(executiveSummary || '').trim() ? 1 : 0)
    + (clientNeedsN.length > 0 ? 1 : 0)
    + (!isProposal && topicsN.length > 0 ? 1 : 0)
    + solutionSlides.length
    + (whyCopods ? 1 : 0)
    + caseStudyItems.length       // one slide per case study
    + (hasServicesSlide ? 1 : 0)
    + (engagementModel ? 1 : 0)
    + (actionSlides.length > 0 ? 1 : 0)
    + webFindingsN.length
    + 1

  let n = 0

  // ── 1. Cover ─────────────────────────────────────────────────────────────
  {
    n++
    const s = newSlide('cover', '/deckTitle', 'Cover')

    // Orange header bar
    s.addShape('rect', { x:0, y:0, w:W, h:0.72, fill:{color:T.or1}, line:{color:T.or1} })
    // White copods on orange bar
    s.addText('copods', {
      x:M, y:0.12, w:1.5, h:0.38,
      fontSize:18, bold:true, color:T.white, fontFace:T.font,
    })
    // Cover label top-right
    s.addText(lCover, {
      x:W - 2.0, y:0.16, w:1.78, h:0.30,
      fontSize:10, bold:true, color:T.white, fontFace:T.font, align:'right', charSpacing:2,
    })

    // Thin left accent bar
    s.addShape('rect', { x:M, y:1.0, w:0.05, h:3.2, fill:{color:T.or2}, line:{color:T.or2} })

    // Main title — shrink to fit so a long title can never run into the client line below
    const titleX = 0.72
    const titleY = 0.95
    const titleW = W - 0.82 - M
    const titleFont = fitFontForList([resolvedTitle], titleW, 1.70, { base:30, min:20, lineSpacingMult:1.2, padPerItem:0 })
    s.addText(resolvedTitle, {
      x:titleX, y:titleY, w:titleW, h:1.70,
      fontSize:titleFont, bold:true, color:T.dark, fontFace:T.font, wrap:true, lineSpacingMultiple:1.2, valign:'top',
    })
    const titleBlockH = textH(resolvedTitle, titleW, titleFont, 1.2)
    const clientY = titleY + titleBlockH + 0.18

    // Client name + industry
    s.addText(clientName + (clientIndustry ? `  ·  ${clientIndustry}` : ''), {
      x:0.72, y:clientY, w:titleW, h:0.40,
      fontSize:15, bold:true, color:T.purple, fontFace:T.font,
    })
    // Date
    s.addText(fmtDate, {
      x:0.72, y:clientY + 0.42, w:titleW, h:0.30,
      fontSize:11, color:T.muted, fontFace:T.font,
    })

    brandFooter(s, orgName, orgTagline)
  }

  // ── 2. Executive Summary ─────────────────────────────────────────────────
  // Drawn only when there is a summary. It used to be unconditional, so
  // "remove the executive summary" cleared the text, the chat said the slide was
  // gone, and the deck still showed an empty slide where it had been.
  if (String(executiveSummary || '').trim()) {
    n++
    const s = newSlide('exec', '/executiveSummary', lOverview)
    hdr(s, lOverview)
    ftr(s, n, total, orgName, fmtDate)

    const boxY = 0.92
    const boxH = H - boxY - 0.32
    const execVisual = visualFor('/executiveSummary', null)
    const cardW = execVisual ? 6.2 : W - M*2
    card(s, M, boxY, cardW, boxH)
    const sumW = cardW - 0.56
    const sumFit = fitSingleText(executiveSummary, sumW, boxH - 0.36, { base:14, min:10, lineSpacingMult:1.7 })
    s.addText(sumFit.text, {
      x:M + 0.28, y:boxY + 0.18, w:sumW, h:boxH - 0.36,
      fontSize:sumFit.fontSize, color:T.purple, fontFace:T.font,
      valign:'middle', wrap:true, lineSpacingMultiple:1.7,
    })
    if (execVisual) {
      const vx = M + cardW + 0.14
      const mark = itemCount(s)
      drawVisual(s, execVisual, vx, boxY, W - vx - M + 0.42 - 0.06, boxH, visualCtx)
      markSince(s, mark, '/visuals/~1executiveSummary')
    }
  }

  // ── 3. Client Challenges ─────────────────────────────────────────────────
  if (clientNeedsN.length > 0) {
    n++
    const s = newSlide('needs', '/clientNeeds', lNeeds)
    hdr(s, lNeeds)
    ftr(s, n, total, orgName, fmtDate)

    const startY = 0.94
    const availH = H - startY - 0.30
    // A visual takes a right-hand column and the cards give up the width, the
    // same trade the solution slides make. Without this the challenges slide
    // could not hold one at all, and a request naming it had nowhere to go.
    const needsVisual = visualFor('/clientNeeds', null)
    const sideW = 2.98
    const availW = W - M*2 - (needsVisual ? sideW + 0.14 : 0)
    const twoCol = clientNeedsN.length >= 3
    const cols   = twoCol ? 2 : 1
    const rows   = Math.ceil(clientNeedsN.length / cols)
    const gap    = 0.14
    const cardW  = twoCol ? (availW - gap) / 2 : availW
    const cardH  = (availH - gap * (rows - 1)) / rows

    clientNeedsN.forEach((need, i) => {
      const col = twoCol ? i % 2 : 0
      const row = Math.floor(i / cols)
      const cx  = M + col * (cardW + gap)
      const cy  = startY + row * (cardH + gap)

      s.addShape('rect', { x:cx, y:cy, w:cardW, h:cardH, fill:{color:T.white}, line:{color:T.line, pt:0.75}, rectRadius:0.10 })
      s.addShape('rect', { x:cx, y:cy, w:0.055, h:cardH, fill:{color:T.or1}, line:{color:T.or1}, rectRadius:0.04 })
      s.addText(`0${i + 1}`, {
        x:cx + cardW - 0.50, y:cy + 0.10, w:0.42, h:0.26,
        fontSize:13, bold:true, color:T.lilac, fontFace:T.font, align:'right',
      })
      s.addText(need.title, {
        x:cx + 0.20, y:cy + 0.10, w:cardW - 0.72, h:0.30,
        fontSize:13, bold:true, color:T.dark, fontFace:T.font, valign:'middle',
      })
      if (need.description) {
        const descW = cardW - 0.28
        const descH = cardH - 0.52
        const descFit = fitSingleText(need.description, descW, descH, { base:twoCol ? 10.5 : 12, min:8, lineSpacingMult:1.4 })
        s.addText(descFit.text, {
          x:cx + 0.20, y:cy + 0.42, w:descW, h:descH,
          fontSize:descFit.fontSize, color:T.body, fontFace:T.font,
          wrap:true, valign:'top', lineSpacingMultiple:1.4,
        })
      }
    })

    if (needsVisual) {
      const vx = M + availW + 0.14
      const mark = itemCount(s)
      drawVisual(s, needsVisual, vx, startY, sideW, availH, visualCtx)
      markSince(s, mark, '/visuals/~1clientNeeds')
    }
  }

  // ── Agenda (legacy meeting mode) ─────────────────────────────────────────
  if (!isProposal && topicsN.length > 0) {
    n++
    const s = newSlide('agenda', '/topics', 'Agenda')
    hdr(s, 'Agenda')
    ftr(s, n, total, orgName, fmtDate)

    const startY = 0.92
    const boxH   = H - startY - 0.30
    card(s, M, startY, W - M*2, boxH)
    const itemH  = Math.min(0.58, boxH / Math.max(topicsN.length, 1))
    topicsN.forEach((t, i) => {
      const y = startY + 0.08 + i * itemH
      s.addShape('ellipse', { x:M + 0.16, y:y + 0.10, w:0.32, h:0.32, fill:{color:T.or1}, line:{color:T.or1} })
      s.addText(`${i + 1}`, {
        x:M + 0.16, y:y + 0.10, w:0.32, h:0.32,
        fontSize:11, bold:true, color:T.white, fontFace:T.font, align:'center', valign:'middle',
      })
      s.addText(t.title, {
        x:M + 0.60, y:y + 0.10, w:W - M*2 - 0.65, h:0.32,
        fontSize:13, bold:true, color:T.dark, fontFace:T.font, valign:'middle',
      })
      if (i < topicsN.length - 1) {
        s.addShape('rect', { x:M + 0.16, y:y + itemH - 0.01, w:W - M*2 - 0.30, h:0.01, fill:{color:T.line}, line:{color:T.line} })
      }
    })
  }

  // ── Solution / Topic slides ───────────────────────────────────────────────
  for (const slide of solutionSlides) {
    n++
    const srcPath = `/${solutionKey}/${solutionSlides.indexOf(slide)}`
    const s = newSlide('solution', srcPath, slide.title)
    hdr(s, slide.title, slide.subtitle || null)
    ftr(s, n, total, orgName, fmtDate)

    const hasStat = !!slide.stat
    const visual  = visualFor(srcPath, slide)
    const points  = slide.keyPoints || []
    const topY    = slide.subtitle ? 1.06 : 0.92
    const boxH    = H - topY - 0.30
    // The right-hand column is shared: a visual takes it, a stat takes it, and
    // when a slide has both they stack rather than one silently winning.
    const useSide = hasStat || !!visual
    const mainW   = useSide ? 6.2 : W - M*2
    card(s, M, topY, mainW, boxH)

    if (points.length) {
      bulletList(s, points, { x:M, y:topY + 0.10, w:mainW, boxH:boxH - 0.20, base:12.5, min:9, lineSpacingMult:1.35,
        src: `${srcPath}/keyPoints` })
    }

    if (useSide) {
      const sx = M + mainW + 0.14
      const sW = W - sx - M + 0.42 - 0.06
      // Both blocks carry provenance, so clicking the KEY STAT panel scopes an
      // edit to the stat rather than to the whole slide.
      if (visual && hasStat) {
        const vH = boxH * 0.58
        let mark = itemCount(s)
        drawVisual(s, visual, sx, topY, sW, vH - 0.08, visualCtx)
        markSince(s, mark, `${srcPath}/visual`)
        mark = itemCount(s)
        statPanel(s, slide.stat, sx, topY + vH, sW, boxH - vH)
        markSince(s, mark, `${srcPath}/stat`)
      } else if (visual) {
        const mark = itemCount(s)
        drawVisual(s, visual, sx, topY, sW, boxH, visualCtx)
        markSince(s, mark, `${srcPath}/visual`)
      } else {
        const mark = itemCount(s)
        statPanel(s, slide.stat, sx, topY, sW, boxH)
        markSince(s, mark, `${srcPath}/stat`)
      }
    }
  }

  // ── Why Copods ────────────────────────────────────────────────────────────
  if (whyCopods) {
    n++
    const s = newSlide('why', '/whyCopods', 'Why Copods')
    hdr(s, 'Why Copods')
    ftr(s, n, total, orgName, fmtDate)

    const topY = 0.94
    const boxH = H - topY - 0.30
    const leftW = 6.4
    card(s, M, topY, leftW, boxH)

    const pts = whyCopods.keyPoints || []
    if (pts.length) {
      bulletList(s, pts, { x:M, y:topY + 0.10, w:leftW, boxH:boxH - 0.20, base:12, min:9, lineSpacingMult:1.3,
        src: '/whyCopods/keyPoints' })
    }

    // Right stats panel
    const rx = M + leftW + 0.14
    const rw = W - rx - M + 0.42 - 0.06
    s.addShape('rect', { x:rx, y:topY, w:rw, h:boxH, fill:{color:T.purple}, line:{color:T.purple}, rectRadius:0.10 })
    const statsData = [
      { v:'150+', l:'Projects\nDelivered' },
      { v:'30+',  l:'Industries\nServed'  },
      { v:'0%',   l:'Attrition\nRate'     },
      { v:'$10M', l:'New Revenue\nGenerated' },
    ]
    const statH = boxH / statsData.length
    statsData.forEach(({ v, l }, i) => {
      const sy = topY + i * statH
      if (i > 0) s.addShape('rect', { x:rx + 0.20, y:sy, w:rw - 0.40, h:0.008, fill:{color:T.or2}, line:{color:T.or2} })
      s.addText(v, {
        x:rx, y:sy + statH * 0.12, w:rw, h:statH * 0.45,
        fontSize:20, bold:true, color:T.white, fontFace:T.font, align:'center', valign:'bottom',
      })
      s.addText(l, {
        x:rx, y:sy + statH * 0.55, w:rw, h:statH * 0.38,
        fontSize:8.5, color:T.or4, fontFace:T.font, align:'center', valign:'top', lineSpacingMultiple:1.2,
      })
    })
  }

  // ── Case Studies — one structured slide per case study ───────────────────
  for (const cs of caseStudyItems) {
    n++
    addCaseStudySlide(newSlide, cs, n, total, orgName, fmtDate, `/whyCopods/relevantCaseStudies/${caseStudyItems.indexOf(cs)}`)
  }

  // ── Our Services ──────────────────────────────────────────────────────────
  if (hasServicesSlide) {
    n++
    const s = newSlide('services', null, 'Our Services')
    hdr(s, 'Our Services')
    ftr(s, n, total, orgName, fmtDate)

    const cols = [
      { label:'Research',              key:'research',          color:T.or1   },
      { label:'UX / UI Design',        key:'design',            color:'7C3AED' },
      { label:'Engineering',           key:'development',       color:'0369A1' },
      { label:'Branding & Marketing',  key:'marketingBranding', color:'065F46' },
    ]
    const topY  = 1.0
    const colH  = H - topY - 0.30
    const gap   = 0.14
    const colW  = (W - M*2 - gap * (cols.length - 1)) / cols.length
    const maxIt = 7

    cols.forEach((col, i) => {
      const cx    = M + i * (colW + gap)
      const items = (services[col.key] || []).slice(0, maxIt)
      s.addShape('rect', { x:cx, y:topY, w:colW, h:0.42, fill:{color:col.color}, line:{color:col.color}, rectRadius:0.08 })
      s.addText(col.label, {
        x:cx + 0.10, y:topY, w:colW - 0.20, h:0.42,
        fontSize:9.5, bold:true, color:T.white, fontFace:T.font, align:'center', valign:'middle',
      })
      const itemsY = topY + 0.50
      const itemsH = colH - 0.50
      card(s, cx, itemsY, colW, itemsH, { fill:T.lilac, border:'EEE1CC', r:0.08 })
      if (items.length) {
        bulletList(s, items, {
          x:cx, y:itemsY + 0.08, w:colW, boxH:itemsH - 0.16,
          base:9, min:7, lineSpacingMult:1.2, gap:0.06,
          dotOffsetX:0.14, textOffsetX:0.28,
        })
      }
    })
  }

  // ── Engagement Model ──────────────────────────────────────────────────────
  if (engagementModel) {
    n++
    const s = newSlide('engagement', '/engagementModel', 'Engagement Model')
    hdr(s, 'Engagement Model', engagementModel.description || null)
    ftr(s, n, total, orgName, fmtDate)

    const topY = engagementModel.description ? 1.08 : 0.94
    const boxH = H - topY - 0.30
    card(s, M, topY, W - M*2, boxH)

    s.addShape('rect', { x:M + 0.18, y:topY + 0.20, w:1.8, h:0.46, fill:{color:T.purple}, line:{color:T.purple}, rectRadius:0.08 })
    s.addText(engagementModel.name?.toUpperCase() || 'ENGAGE', {
      x:M + 0.18, y:topY + 0.20, w:1.8, h:0.46,
      fontSize:13, bold:true, color:T.white, fontFace:T.font, align:'center', valign:'middle', charSpacing:1.5,
    })

    const phases   = engagementModel.phases || []
    const phasesY  = topY + 0.84
    const phasesH  = boxH - 0.84 - 0.10
    const phaseTextW = W - M*2 - 0.68
    const phaseFont = fitFontForList(phases, phaseTextW, phasesH, { base:12, min:9, lineSpacingMult:1.3, padPerItem:0.10, gap:0.08 })
    const allPhaseHeights = listItemHeights(phases, phaseTextW, phaseFont, 1.3, 0.10).map(h => Math.max(h, 0.46))

    // Guard against overshoot even at min font (e.g. an unusually long phase list).
    let shownPhases = phases.length
    let phaseAcc = 0
    for (let i = 0; i < phases.length; i++) {
      const add = allPhaseHeights[i] + (i > 0 ? 0.08 : 0)
      if (phaseAcc + add > phasesH && i > 0) { shownPhases = i; break }
      phaseAcc += add
    }
    const visiblePhases = phases.slice(0, shownPhases)
    const phaseHeights = allPhaseHeights.slice(0, shownPhases)

    let py = phasesY
    visiblePhases.forEach((phase, i) => {
      const h = phaseHeights[i]
      s.addShape('ellipse', { x:M + 0.18, y:py + h / 2 - 0.15, w:0.30, h:0.30, fill:{color:T.or1}, line:{color:T.or1} })
      s.addText(`${i + 1}`, {
        x:M + 0.18, y:py + h / 2 - 0.15, w:0.30, h:0.30,
        fontSize:10, bold:true, color:T.white, fontFace:T.font, align:'center', valign:'middle',
      })
      if (i < visiblePhases.length - 1) {
        const connectorTop = py + h / 2 + 0.15
        const nextCenterY = py + h + 0.08 + phaseHeights[i + 1] / 2
        s.addShape('rect', { x:M + 0.30, y:connectorTop, w:0.06, h:Math.max(nextCenterY - 0.15 - connectorTop, 0.06), fill:{color:T.or4}, line:{color:T.or4} })
      }
      s.addText(phase, {
        x:M + 0.62, y:py, w:phaseTextW, h,
        fontSize:phaseFont, color:T.dark, fontFace:T.font, valign:'middle', wrap:true, lineSpacingMultiple:1.3,
      })
      py += h + 0.08
    })
  }

  // ── Next Steps / Action Items ─────────────────────────────────────────────
  if (actionSlides.length > 0) {
    n++
    const s = newSlide('nextSteps', `/${actionKey}`, 'Next Steps')
    hdr(s, labelsN.nextSteps || (isProposal ? 'Next Steps' : 'Action Items'))
    ftr(s, n, total, orgName, fmtDate)

    const hasDue = actionSlides.some(a => a.dueDate)
    const colW   = hasDue ? [4.5, 2.0, 2.1] : [6.2, 2.6]

    const mkHead = txt => ({ text:txt, options:{ bold:true, color:T.white, fill:T.purple, fontFace:T.font, fontSize:11 } })
    const mkCell = (txt, i) => ({ text:txt || '—', options:{ color:T.dark, fill: i%2===0 ? T.lilac : T.white, fontFace:T.font, fontSize:11, wrap:true, valign:'middle' } })

    const headerRow = hasDue
      ? [mkHead('Action'), mkHead('Owner'), mkHead('Due')]
      : [mkHead('Action'), mkHead('Owner')]

    const dataRows = actionSlides.map((a, i) => {
      const row = [mkCell(a.item, i), mkCell(a.owner, i)]
      if (hasDue) row.push(mkCell(a.dueDate, i))
      return row
    })

    // Row height follows whichever cell in the row wraps to the most lines —
    // a fixed 0.48in row clips or overlaps once the action text runs long.
    const cellPad = 0.16
    const rowH = [0.42, ...actionSlides.map(a => {
      const lines = [
        estLines(a.item || '—', colW[0] - cellPad, 11),
        estLines(a.owner || '—', colW[1] - cellPad, 11),
        ...(hasDue ? [estLines(a.dueDate || '—', colW[2] - cellPad, 11)] : []),
      ]
      return Math.max(0.42, Math.max(...lines) * lineHeightIn(11, 1.15) + cellPad)
    })]

    s.addTable([headerRow, ...dataRows], {
      x:M + 0.08, y:0.98, w:W - M*2 - 0.16,
      colW, rowH,
      border:{ pt:0.5, color:T.line },
      align:'left', valign:'middle',
    })
  }

  // ── Research / web findings ───────────────────────────────────────────────
  for (const f of webFindingsN) {
    n++
    const s = newSlide('research', `/webFindings/${webFindingsN.indexOf(f)}`, f.topic)
    hdr(s, `Research: ${f.topic}`, `Search: "${f.query}"`)
    ftr(s, n, total, orgName, fmtDate)

    const boxY = 1.08
    const boxH = H - boxY - 0.30
    card(s, M, boxY, W - M*2, boxH)
    const findW = W - M*2 - 0.44
    const findH = boxH - 0.45
    const findFit = fitSingleText(f.summary, findW, findH, { base:13, min:9.5, lineSpacingMult:1.55 })
    s.addText(findFit.text, {
      x:M + 0.22, y:boxY + 0.14, w:findW, h:findH,
      fontSize:findFit.fontSize, color:T.dark, fontFace:T.font,
      wrap:true, lineSpacingMultiple:1.55, valign:'top',
    })
    if (f.sources?.length) {
      s.addText(f.sources.slice(0, 3).map(u => `• ${u}`).join('\n'), {
        x:M, y:H - 0.50, w:W - M*2, h:0.32,
        fontSize:7, color:T.muted, fontFace:T.font, wrap:true,
      })
    }
  }

  // ── Closing ───────────────────────────────────────────────────────────────
  {
    n++
    const s = newSlide('closing', '/labels/closing', 'Closing')

    // Orange header bar (mirrors cover)
    s.addShape('rect', { x:0, y:0, w:W, h:0.72, fill:{color:T.or1}, line:{color:T.or1} })
    s.addText('copods', {
      x:M, y:0.12, w:1.5, h:0.38,
      fontSize:18, bold:true, color:T.white, fontFace:T.font,
    })

    // Left accent bar
    s.addShape('rect', { x:M, y:1.0, w:0.05, h:2.8, fill:{color:T.or2}, line:{color:T.or2} })

    const closingW = W - 0.82 - M
    const closingFont = fitFontForList(lClosing.split('\n'), closingW, 1.55, { base:40, min:26, lineSpacingMult:1.15, padPerItem:0 })
    s.addText(lClosing, {
      x:0.72, y:1.0, w:closingW, h:1.55,
      fontSize:closingFont, bold:true, color:T.dark, fontFace:T.font, lineSpacingMultiple:1.15, valign:'top',
    })
    const closingBlockH = lClosing.split('\n').reduce((sum, l) => sum + textH(l, closingW, closingFont, 1.15), 0)
    s.addText(clientName, {
      x:0.72, y:1.0 + closingBlockH + 0.18, w:closingW, h:0.44,
      fontSize:17, bold:true, color:T.purple, fontFace:T.font,
    })
    s.addText('hello@copods.co  ·  copods.co', {
      x:0.72, y:3.10, w:W - 0.82 - M, h:0.30,
      fontSize:11.5, color:T.muted, fontFace:T.font,
    })

    brandFooter(s, orgName, orgTagline)
  }

  // ── Spec target: no file, just the recorded layout ───────────────────────
  if (isSpec) {
    const spec = pptx.result()
    spec.slideCount = n
    spec.title = resolvedTitle
    return spec
  }

  // ── Save ──────────────────────────────────────────────────────────────────
  const outputDir = process.env.OUTPUT_DIR || path.join(dataDir, 'output')
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true })

  const slug     = (resolvedTitle || clientName || 'deck').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
  const dateSlug = meetingDate.slice(0, 10)
  const unique   = Date.now().toString(36).slice(-5)
  const fileName = `${dateSlug}_${slug}_${unique}.pptx`
  const filePath = path.join(outputDir, fileName)

  await pptxInstance.writeFile({ fileName: filePath })
  return { filePath, fileName, slideCount: n }
}
