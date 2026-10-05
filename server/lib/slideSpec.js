/**
 * Slide spec layer — one layout pass, two renderers.
 *
 * builder.js computes every slide in absolute inches with explicit font sizes.
 * Rather than duplicate that geometry in an HTML previewer (two renderers that
 * silently drift, so the preview lies about the .pptx), we hand builder.js a
 * recorder that quacks like a pptxgenjs deck and captures the draw calls.
 *
 *   buildPresentation(data, dir, cfg, { target: 'pptx' })  → writes a .pptx
 *   buildPresentation(data, dir, cfg, { target: 'spec' })  → returns spec JSON
 *
 * The preview renders the spec; the .pptx renders the same spec through
 * pptxgenjs. Both agree by construction — there is only one layout.
 */

export const SLIDE_W = 10      // inches
export const SLIDE_H = 5.625
export const PX_PER_IN = 96    // 10in × 96 = 960px, a clean preview scale

/**
 * A pptxgenjs-shaped recorder. builder.js only ever calls addSlide/addText/
 * addShape/addTable/addImage and sets `.layout`, so this is a complete stand-in.
 */
export function createSpecTarget() {
  const slides = []

  return {
    layout: null,
    __isSpecTarget: true,

    addSlide() {
      const items = []
      // `meta` is stamped by builder.js via markSlide() so the chat can map a
      // clicked slide back to the deck-JSON path that produced it.
      const slide = { meta: {}, items }
      slides.push(slide)
      return {
        __slide: slide,
        addText:  (text, opts = {}) => { items.push({ kind: 'text',  text, ...opts }); },
        addShape: (type, opts = {}) => { items.push({ kind: 'shape', type, ...opts }); },
        addTable: (rows, opts = {}) => { items.push({ kind: 'table', rows, ...opts }); },
        // pptxgenjs reads `path` off disk; the preview cannot, so builder.js
        // also supplies `url` pointing at the server's asset route. Both
        // describe the same file — only the transport differs.
        addImage: (opts = {}) => { items.push({ kind: 'image', ...opts }); },
      }
    },

    result() {
      return { width: SLIDE_W, height: SLIDE_H, slides }
    },
  }
}

/**
 * Wraps a real pptxgenjs instance so builder.js can treat both targets
 * identically, including the markSlide() provenance calls.
 */
export function createPptxTarget(pptx) {
  return {
    set layout(v) { pptx.layout = v },
    get layout() { return pptx.layout },
    __isSpecTarget: false,
    addSlide: () => pptx.addSlide(),
    pptx,
  }
}

/**
 * Tags a slide with where it came from in the deck JSON.
 * No-op on the pptx target — provenance only matters for the interactive preview.
 *
 *   markSlide(s, 'solution', '/proposedSolutions/2', 'Discovery Sprint')
 */
export function markSlide(slide, kind, srcPath, label) {
  if (slide?.__slide) {
    slide.__slide.meta = { kind, srcPath: srcPath || null, label: label || null }
  }
  return slide
}

/** How many items a slide has recorded so far (spec target only). */
export function itemCount(slide) {
  return slide?.__slide?.items.length ?? 0
}

/**
 * Attaches a deck-JSON path to every item recorded since `before`.
 * Safer than counting by hand when a block draws a variable number of shapes —
 * over-counting would steal provenance from the items drawn before it.
 */
export function markSince(slide, before, srcPath) {
  if (!slide?.__slide || !srcPath) return
  const items = slide.__slide.items
  for (let i = Math.max(0, before); i < items.length; i++) items[i].src = srcPath
}

/** Attaches a deck-JSON path to the most recently recorded item(s). */
export function markLastItems(slide, count, srcPath) {
  if (!slide?.__slide || !srcPath) return
  const items = slide.__slide.items
  for (let i = Math.max(0, items.length - count); i < items.length; i++) {
    items[i].src = srcPath
  }
}
