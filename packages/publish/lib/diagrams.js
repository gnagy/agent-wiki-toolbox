/**
 * Mermaid diagrams to PNG, with mermaid as a library and no browser.
 *
 * Quartz draws mermaid in the *reader's* browser, importing it from a CDN — so in a
 * handoff copy a diagram is JavaScript (`file://` runs none), a network request (a
 * reader offline makes none), and a layout computed on a machine nobody controls.
 * Without this the reader gets the diagram's source code as text.
 *
 * The pipeline, and each step is there because the one before it failed:
 *
 *   1. jsdom, with every own property of the window copied onto `globalThis`.
 *   2. `getBBox` and `getComputedTextLength` backed by **real font metrics** —
 *      fontkit over a `.ttf` on the machine.
 *   3. `getBBox` covering shapes as well as text, recursively, applying each
 *      child's `translate(...)`. Text alone gives a diagram 16 px wide.
 *   4. `htmlLabels: false`, so labels are SVG `<text>` rather than `<foreignObject>`
 *      — a rasterizer will not draw the latter.
 *   5. `@resvg/resvg-js` to rasterize, loading the same font that measured the text.
 *
 * **PNG rather than SVG, at 2x.** An SVG's `<foreignObject>` labels are laid out by
 * the reader's browser in whatever font it resolves, so on a machine missing this
 * one's fonts a label overflows the box it was measured for. A handoff copy goes to
 * machines nobody here controls, so it takes pixels — identical everywhere — and
 * gives up the searchable diagram text.
 */
import {loadFont} from './font-metrics.js'
import {createDom} from './dom-shim.js'

/**
 * The rendering environment, built once per process.
 *
 * mermaid is a module singleton and holds on to the `document` it was initialised
 * against, so tearing the DOM down between batches leaves the second batch
 * rendering into a closed window — which fails as an *error per diagram* rather
 * than as an exception, and therefore looks like "that diagram is bad".
 */
let environment = null
let rendered = 0

async function getEnvironment({theme}) {
  if (environment) return environment

  const font = await loadFont()
  const dom = createDom(font)
  const {default: mermaid} = await import('mermaid')

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'loose',
    theme,
    // Labels must be SVG text: a rasterizer cannot draw a foreignObject, and this
    // is also what makes the font metrics above the ones that matter.
    htmlLabels: false,
    flowchart: {htmlLabels: false},
    class: {htmlLabels: false},
    fontFamily: 'Arial, Helvetica, sans-serif',
  })

  environment = {font, dom, mermaid}
  return environment
}

/** Give the globals back. A caller that renders again simply builds a new one. */
export function disposeRenderer() {
  environment?.dom.dispose()
  environment = null
}

/** Render diagram sources to SVG, one result per source, in order. */
export async function renderDiagrams(sources, {scale = 2, theme = 'default'} = {}) {
  const {dom, mermaid} = await getEnvironment({theme})
  const results = []

  for (const source of sources) {
    // A unique id per render, counted across the whole process: mermaid leaves its
    // scratch element in the document, and reusing an id makes a later render draw
    // into an earlier one's leftovers — which fails as "that diagram is bad".
    const id = `awt-diagram-${rendered++}`
    try {
      const {svg} = await mermaid.render(id, source, dom.document.body)
      results.push({ok: true, svg, ...sizeOf(svg, scale)})
    } catch (error) {
      results.push({ok: false, error: error?.message ?? String(error)})
    }
  }
  return results
}

/** Rasterize an SVG. Separate from rendering so a failure names which half broke. */
export async function rasterize(svg, {scale = 2, font} = {}) {
  const {Resvg} = await import('@resvg/resvg-js')
  const metrics = font ?? (await loadFont())
  const resvg = new Resvg(svg, {
    background: 'rgba(0,0,0,0)',
    font: {loadSystemFonts: true, fontFiles: [metrics.path], defaultFontFamily: 'Arial'},
    fitTo: {mode: 'zoom', value: scale},
  })
  const image = resvg.render()
  return {png: image.asPng(), width: image.width, height: image.height}
}

/** The intrinsic size to display a rendered diagram at, from its own viewBox. */
function sizeOf(svg, scale) {
  const box = /viewBox="([\d.\-\s]+)"/.exec(svg)
  if (!box) return {width: null, height: null}
  const [, , width, height] = box[1].trim().split(/\s+/).map(Number)
  return {width: Math.round(width), height: Math.round(height), scale}
}
