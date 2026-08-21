/**
 * The M8 acceptance test for decision 23.
 *
 * **A run that does not throw proves nothing here**: the failure mode is a wrong
 * picture. The first version of this renderer produced a perfectly valid SVG in
 * which every node was narrower than its own label, because mermaid writes a label
 * as one `<tspan>` per *word* and unioning them reports the width of the longest
 * word. Nothing threw.
 *
 * So the assertions are about the picture: labels fit inside their shapes, the
 * diagram is a plausible size, the text is SVG text rather than a `<foreignObject>`
 * a rasterizer cannot draw, and the PNG has ink in it.
 *
 * They are invariants rather than a stored geometry on purpose — glyph widths
 * differ between machines, and a fixture keyed to this laptop's Arial would fail
 * everywhere else for a reason that is not a defect. `fixtures/pipeline.png` is
 * committed beside them as the reference a person compares against.
 */
import assert from 'node:assert/strict'
import {readFileSync, writeFileSync} from 'node:fs'
import test from 'node:test'

import {rasterize, renderDiagrams} from '../lib/diagrams.js'
import {findFont, loadFont} from '../lib/font-metrics.js'

const SOURCE = readFileSync(new URL('fixtures/pipeline.mmd', import.meta.url), 'utf8')
const LABELS = ['The working copy', '~/.local/lib', 'Which consumer?', 'awt on PATH', 'the plugins']

test('a diagram renders with no browser on the machine', async (t) => {
  if (!findFont()) return t.skip('no font to measure with')

  const [result] = await renderDiagrams([SOURCE])
  assert.equal(result.ok, true, result.error)

  // The historical failure: a `getBBox` guessing from the character count emitted a
  // diagram 27,040 px wide and 34 tall. Anything in that neighbourhood is wrong.
  assert.ok(result.width > 150 && result.width < 1500, `viewBox width ${result.width}`)
  assert.ok(result.height > 150 && result.height < 2000, `viewBox height ${result.height}`)

  // htmlLabels: false — a rasterizer draws SVG text and cannot draw a foreignObject.
  assert.doesNotMatch(result.svg, /<foreignObject/i)

  for (const label of LABELS) {
    const compact = label.replace(/\s+/g, '')
    const rendered = result.svg.replace(/<[^>]*>/g, '').replace(/\s+/g, '')
    assert.ok(rendered.includes(compact), `"${label}" is missing from the rendered SVG`)
  }
})

test('every label fits inside the shape drawn for it', async (t) => {
  if (!findFont()) return t.skip('no font to measure with')

  const font = await loadFont()
  const [result] = await renderDiagrams([SOURCE])
  const overflowing = []

  // Each node is a `<g class="node ...">` holding one shape and one label.
  for (const node of result.svg.split('<g class="node').slice(1)) {
    const width = shapeWidth(node)
    if (width === null) continue
    const label = /<text[^>]*>([\s\S]*?)<\/text>/.exec(node)
    if (!label) continue
    const text = label[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
    if (!text) continue
    const measured = font.measure(text, 16)
    if (measured > width) overflowing.push(`${text}: label ${measured.toFixed(0)}px in a ${width.toFixed(0)}px shape`)
  }

  assert.deepEqual(overflowing, [], 'a node drawn narrower than its own label is the exact bug this catches')
})

test('the SVG rasterizes to a PNG with ink in it', async (t) => {
  if (!findFont()) return t.skip('no font to measure with')

  const [result] = await renderDiagrams([SOURCE])
  const {png, width, height} = await rasterize(result.svg, {scale: 2})

  // Rendered at 2x, displayed at 1x. Within a pixel: the viewBox is fractional and
  // both the display size and the raster round it independently.
  assert.ok(Math.abs(width - result.width * 2) <= 2, `${width} is not 2x ${result.width}`)
  assert.ok(Math.abs(height - result.height * 2) <= 2, `${height} is not 2x ${result.height}`)
  assert.ok(png.length > 5000, `a ${png.length}-byte PNG is a blank one`)
  assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG')

  if (process.env.AWT_WRITE_FIXTURE) {
    writeFileSync(new URL('fixtures/pipeline.png', import.meta.url), png)
  }
})

test('a diagram that will not parse is reported, not thrown', async (t) => {
  if (!findFont()) return t.skip('no font to measure with')
  const [result] = await renderDiagrams(['flowchart TD\n  A --> ((( nonsense'])
  assert.equal(result.ok, false)
  assert.ok(result.error.length > 0)
})

/** The width of a node's shape: a rect, or the bounding box of a polygon. */
function shapeWidth(node) {
  const rect = /<rect[^>]*\bwidth="([\d.]+)"/.exec(node)
  if (rect) return Number(rect[1])
  const points = /<polygon[^>]*points="([^"]+)"/.exec(node)
  if (!points) return null
  const xs = points[1]
    .trim()
    .split(/[\s,]+/)
    .map(Number)
    .filter((_, index) => index % 2 === 0)
  return Math.max(...xs) - Math.min(...xs)
}
