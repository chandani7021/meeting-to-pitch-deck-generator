/**
 * Renders a slide spec as HTML.
 *
 * The spec comes from the same layout pass that writes the .pptx (see
 * server/lib/slideSpec.js), so this file contains NO layout decisions — it only
 * translates units. Any geometry change belongs in builder.js, where both
 * renderers pick it up.
 *
 * Units: pptxgenjs works in inches and points. 10in × 96 = 960px per slide,
 * and 1pt = 96/72 px.
 */
const PX = 96
const PT = 96 / 72
const inPx = v => `${(Number(v) || 0) * PX}px`
const ptPx = v => `${(Number(v) || 0) * PT}px`

// Calibri is not installed on macOS, and builder.js's text-fit estimator assumes
// Calibri metrics — Carlito is metric-compatible, so wrapping matches the .pptx.
const FONT_STACK = `'Calibri','Carlito','Segoe UI',system-ui,sans-serif`

// Images live on disk in the data directory; the renderer is network-jailed to
// this origin (see electron/main.js), so it reads them back through the server
// rather than via file://.
const ASSET_ORIGIN = 'http://127.0.0.1:3001'

const hex = c => {
  if (!c) return 'transparent'
  const raw = typeof c === 'object' ? (c.color || '') : String(c)
  return raw.startsWith('#') ? raw : `#${raw}`
}

function applyBox(el, o) {
  el.style.left = inPx(o.x)
  el.style.top = inPx(o.y)
  el.style.width = inPx(o.w)
  el.style.height = inPx(o.h)
}

function renderShape(item) {
  const el = document.createElement('div')
  el.className = 'sl-shape'
  applyBox(el, item)
  el.style.background = hex(item.fill)
  // pptxgenjs expresses fill transparency as 0-100 percent; CSS wants opacity.
  const alpha = item.fill?.transparency ?? item.transparency
  if (alpha) el.style.opacity = String(Math.max(0, 1 - Number(alpha) / 100))
  if (item.line && hex(item.line) !== hex(item.fill)) {
    el.style.border = `${Math.max(1, (item.line.pt || 0.75) * PT)}px solid ${hex(item.line)}`
    el.style.boxSizing = 'border-box'
  }
  if (item.type === 'ellipse') el.style.borderRadius = '50%'
  else if (item.rectRadius) el.style.borderRadius = inPx(item.rectRadius)
  // Charts and motifs are built from shapes, so a shape can now be the only
  // clickable part of a slide region.
  if (item.src) { el.dataset.src = item.src; el.classList.add('sl-selectable') }
  return el
}

/**
 * Styled runs inside one text box.
 *
 * They go in a single block wrapper rather than straight onto the flex
 * container: as flex children each run would become its own column and wrap
 * independently, so "Efficiency  40% increase…" would break in the wrong place.
 * One wrapper keeps them as ordinary inline text that wraps together.
 */
function applyRuns(el, runs) {
  const wrap = document.createElement('span')
  wrap.style.display = 'block'
  wrap.style.width = '100%'

  for (const run of runs) {
    if (run == null) continue
    const o = run.options || {}
    const span = document.createElement('span')
    span.textContent = String(run.text ?? '')
    if (o.bold) span.style.fontWeight = '700'
    if (o.italic) span.style.fontStyle = 'italic'
    if (o.underline) span.style.textDecoration = 'underline'
    if (o.color) span.style.color = hex(o.color)
    if (o.fontSize) span.style.fontSize = ptPx(o.fontSize)
    if (o.charSpacing) span.style.letterSpacing = ptPx(o.charSpacing)
    wrap.appendChild(span)
    // pptxgenjs ends a run with breakLine by starting the next one on a new line.
    if (o.breakLine) wrap.appendChild(document.createElement('br'))
  }
  el.appendChild(wrap)
}

function renderText(item) {
  const el = document.createElement('div')
  el.className = 'sl-text'
  applyBox(el, item)
  // PowerPoint does not clip text that exceeds its box — it spills. Clipping
  // here would hide a layout problem instead of showing it, so overflow stays
  // visible and the preview tells the truth about what the .pptx will do.
  el.style.overflow = 'visible'

  const s = el.style
  s.fontFamily = FONT_STACK
  s.fontSize = ptPx(item.fontSize || 12)
  s.color = hex(item.color || '000000')
  if (item.bold) s.fontWeight = '700'
  if (item.italic) s.fontStyle = 'italic'
  if (item.charSpacing) s.letterSpacing = ptPx(item.charSpacing)
  s.lineHeight = String(item.lineSpacingMultiple || 1.2)
  s.textAlign = item.align || 'left'
  s.justifyContent = item.align === 'center' ? 'center' : item.align === 'right' ? 'flex-end' : 'flex-start'
  s.alignItems = item.valign === 'middle' ? 'center' : item.valign === 'bottom' ? 'flex-end' : 'flex-start'
  if (item.fill) s.background = hex(item.fill)

  // pptxgenjs accepts either a plain string or an array of styled runs. The
  // Business Impact rows are the latter (bold label, normal value), and
  // String()-ing that array is where "[object Object],[object Object]" came
  // from — the export was always right, only this renderer could not read it.
  el.style.whiteSpace = 'pre-wrap'
  if (item.wrap === false) el.style.whiteSpace = 'pre'
  if (Array.isArray(item.text)) applyRuns(el, item.text)
  else el.textContent = String(item.text ?? '')

  if (item.src) {
    el.dataset.src = item.src
    el.classList.add('sl-selectable')
  }
  return el
}

/**
 * An image drawn by builder.js. `sizing.type` mirrors pptxgenjs: 'contain'
 * letterboxes inside the box, 'cover' fills it. Anything else stretches, which
 * is what pptxgenjs does without a sizing option.
 */
function renderImage(item) {
  const el = document.createElement('img')
  el.className = 'sl-image'
  applyBox(el, item)
  el.src = item.url ? `${ASSET_ORIGIN}${item.url}` : (item.data || '')
  el.alt = item.altText || ''
  el.style.objectFit = item.sizing?.type === 'cover' ? 'cover'
                     : item.sizing?.type === 'contain' ? 'contain' : 'fill'
  // A missing file must not leave an empty hole with no explanation — the
  // .pptx would have the same gap.
  el.addEventListener('error', () => {
    el.replaceWith(Object.assign(document.createElement('div'), {
      className: 'sl-image-missing',
      textContent: 'image unavailable',
      style: el.style.cssText,
    }))
  })
  if (item.src) { el.dataset.src = item.src; el.classList.add('sl-selectable') }
  return el
}

function renderTable(item) {
  const wrap = document.createElement('div')
  wrap.className = 'sl-table-wrap'
  applyBox(wrap, item)

  // pptxgenjs derives a table's height from its row heights, so builder.js has
  // no reason to pass one — and applyBox() turned that missing `h` into
  // height:0. With overflow:hidden on the wrapper that clipped every table to
  // nothing: the Next Steps slide rendered blank while the .pptx was correct.
  // Summing the rows the builder already supplied is a unit translation, not a
  // layout decision, so this stays on the right side of invariant 1.
  if (!item.h) {
    const rows = item.rowH?.length ? item.rowH.reduce((a, b) => a + (Number(b) || 0), 0) : 0
    wrap.style.height = rows ? inPx(rows) : 'auto'
  }

  const table = document.createElement('table')
  table.className = 'sl-table'
  table.style.fontFamily = FONT_STACK
  const colW = item.colW || []

  ;(item.rows || []).forEach((row, r) => {
    const tr = document.createElement('tr')
    if (item.rowH?.[r]) tr.style.height = inPx(item.rowH[r])
    row.forEach((cell, c) => {
      const td = document.createElement('td')
      const o = cell?.options || {}
      // Same run-array contract as a text box — a cell can carry styled runs.
      if (Array.isArray(cell?.text)) applyRuns(td, cell.text)
      else td.textContent = String(cell?.text ?? cell ?? '')
      td.style.fontSize = ptPx(o.fontSize || 11)
      td.style.color = hex(o.color || '000000')
      td.style.background = hex(o.fill)
      if (o.bold) td.style.fontWeight = '700'
      td.style.verticalAlign = o.valign === 'middle' ? 'middle' : 'top'
      td.style.textAlign = o.align || item.align || 'left'
      if (colW[c]) td.style.width = inPx(colW[c])
      if (item.border) td.style.border = `${Math.max(1, (item.border.pt || 0.5) * PT)}px solid ${hex(item.border.color)}`
      tr.appendChild(td)
    })
    table.appendChild(tr)
  })
  wrap.appendChild(table)
  return wrap
}

/** One spec slide -> one positioned 960×540 element. */
export function renderSlide(slide, index, { width, height }) {
  const el = document.createElement('div')
  el.className = 'sl-slide'
  el.style.width = inPx(width)
  el.style.height = inPx(height)
  el.dataset.index = String(index)
  el.dataset.kind = slide.meta?.kind || ''
  if (slide.meta?.srcPath) el.dataset.src = slide.meta.srcPath

  for (const item of slide.items || []) {
    if (item.kind === 'shape') el.appendChild(renderShape(item))
    else if (item.kind === 'text') el.appendChild(renderText(item))
    else if (item.kind === 'table') el.appendChild(renderTable(item))
    else if (item.kind === 'image') el.appendChild(renderImage(item))
  }
  return el
}

/**
 * Renders a whole spec into `container`.
 * `onSelect({ srcPath, kind, label, slideIndex })` fires on click — the chat
 * uses it to scope an edit to one element, which is what keeps edit prompts
 * small enough to be fast on local inference.
 */
export function renderSpec(container, spec, { onSelect, scale = 1 } = {}) {
  container.innerHTML = ''
  if (!spec?.slides?.length) {
    container.innerHTML = '<div class="sl-empty">No slides yet.</div>'
    return
  }

  spec.slides.forEach((slide, i) => {
    const frame = document.createElement('div')
    frame.className = 'sl-frame'

    const stage = document.createElement('div')
    stage.className = 'sl-stage'
    stage.style.width = inPx(spec.width)
    stage.style.height = inPx(spec.height)
    stage.style.transform = `scale(${scale})`

    const slideEl = renderSlide(slide, i, spec)
    stage.appendChild(slideEl)

    const shell = document.createElement('div')
    shell.className = 'sl-shell'
    shell.style.width = `${spec.width * PX * scale}px`
    shell.style.height = `${spec.height * PX * scale}px`
    shell.appendChild(stage)

    const cap = document.createElement('div')
    cap.className = 'sl-caption'
    cap.innerHTML = `<span class="sl-num">${i + 1}</span><span class="sl-kind">${slide.meta?.label || slide.meta?.kind || ''}</span>`

    frame.appendChild(shell)
    frame.appendChild(cap)
    container.appendChild(frame)

    if (onSelect) {
      shell.addEventListener('click', ev => {
        // Prefer the most specific provenance under the cursor (a bullet beats
        // the slide it sits on).
        const hit = ev.target.closest('[data-src]')
        const srcPath = hit?.dataset.src || slide.meta?.srcPath || null
        container.querySelectorAll('.sl-selected').forEach(n => n.classList.remove('sl-selected'))
        ;(hit && hit !== slideEl ? hit : shell).classList.add('sl-selected')
        onSelect({
          srcPath, slideIndex: i,
          kind: slide.meta?.kind || null,
          label: slide.meta?.label || null,
          text: hit?.textContent?.slice(0, 120) || null,
        })
      })
    }
  })
}

export const SLIDE_PX = PX
