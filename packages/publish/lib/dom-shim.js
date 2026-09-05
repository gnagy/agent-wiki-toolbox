/**
 * The jsdom environment mermaid needs, and the two SVG methods jsdom does not
 * implement.
 *
 * This is a compatibility surface with mermaid's internals that no upstream
 * contract protects. It works against mermaid 11; re-verify against the fixture
 * on a major bump.
 */
import {JSDOM} from 'jsdom'

/**
 * Every own property of the window, not a curated list. A curated one fails
 * partway through a render on `CSSStyleSheet is not defined` — the kind of gap
 * that only surfaces once layout starts, which is far too late to be debugging
 * globals.
 */
function installGlobals(window) {
  const restore = []
  for (const key of Object.getOwnPropertyNames(window)) {
    if (key in globalThis && key !== 'document' && key !== 'window') continue
    const descriptor = Object.getOwnPropertyDescriptor(window, key)
    if (!descriptor) continue
    restore.push([key, Object.getOwnPropertyDescriptor(globalThis, key)])
    try {
      Object.defineProperty(globalThis, key, descriptor)
    } catch {
      // Some window properties are not redefinable on globalThis; mermaid does
      // not need those, and failing here would be worse than skipping them.
      restore.pop()
    }
  }
  return () => {
    for (const [key, descriptor] of restore.reverse()) {
      try {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else delete globalThis[key]
      } catch {
        // Node defines a few of these itself and will not give them up
        // (`location`, `navigator`). Leaving one in place is harmless; throwing
        // out of a `finally` while cleaning up is not.
      }
    }
  }
}

/** A `translate(x, y)` out of a `transform` attribute; everything else is ignored. */
function translationOf(element) {
  const transform = element.getAttribute?.('transform')
  if (!transform) return {x: 0, y: 0}
  const match = /translate\(\s*(-?[\d.]+)[ ,]+(-?[\d.]+)?/.exec(transform)
  if (!match) return {x: 0, y: 0}
  return {x: Number(match[1]) || 0, y: Number(match[2] ?? 0) || 0}
}

const numberOf = (element, name, fallback = 0) => {
  const value = Number(element.getAttribute?.(name))
  return Number.isFinite(value) ? value : fallback
}

function union(a, b) {
  if (!a) return b
  if (!b) return a
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return {x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y}
}

/**
 * The bounds of one element, recursively.
 *
 * A `getBBox` that handles only `<text>` produces a diagram **16 px wide**, because
 * mermaid sizes the graph from the bounds of the container group. Covering the
 * shapes as well is about ninety lines and is the whole trick.
 */
function boundsOf(element, font) {
  if (!element || element.nodeType !== 1) return null

  switch (element.tagName?.toLowerCase()) {
    case 'text':
    case 'tspan':
      return textBounds(element, font)
    case 'rect':
      return {
        x: numberOf(element, 'x'),
        y: numberOf(element, 'y'),
        width: numberOf(element, 'width'),
        height: numberOf(element, 'height'),
      }
    case 'circle': {
      const r = numberOf(element, 'r')
      return {x: numberOf(element, 'cx') - r, y: numberOf(element, 'cy') - r, width: r * 2, height: r * 2}
    }
    case 'ellipse': {
      const rx = numberOf(element, 'rx')
      const ry = numberOf(element, 'ry')
      return {x: numberOf(element, 'cx') - rx, y: numberOf(element, 'cy') - ry, width: rx * 2, height: ry * 2}
    }
    case 'line': {
      const x1 = numberOf(element, 'x1')
      const y1 = numberOf(element, 'y1')
      const x2 = numberOf(element, 'x2')
      const y2 = numberOf(element, 'y2')
      return {x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1)}
    }
    case 'polygon':
    case 'polyline':
      return pointsBounds(element.getAttribute('points') ?? '')
    case 'path':
      return pathBounds(element.getAttribute('d') ?? '')
    default:
      break
  }

  let box = null
  for (const child of element.children ?? []) {
    const childBox = boundsOf(child, font)
    if (!childBox) continue
    const {x, y} = translationOf(child)
    box = union(box, {...childBox, x: childBox.x + x, y: childBox.y + y})
  }
  return box
}

/**
 * A label's bounds.
 *
 * mermaid writes a label as one `<tspan>` per line, each holding one inline
 * `<tspan>` per word — and the word tspans carry no `x`. Unioning them therefore
 * stacks every word at x=0 and reports the width of the **longest word** instead of
 * the line. That does not throw; it draws a node narrower than its own label.
 */
function textBounds(element, font) {
  const size = fontSizeOf(element)
  const height = font.lineHeight(size)
  const lines = [...(element.children ?? [])].filter((child) => child.tagName?.toLowerCase() === 'tspan')

  const width =
    lines.length > 0
      ? Math.max(...lines.map((line) => font.measure(line.textContent ?? '', fontSizeOf(line))))
      : font.measure(element.textContent ?? '', size)
  const total = Math.max(1, lines.length) * height

  const x = numberOf(element, 'x')
  // mermaid puts the anchor on the line tspan for a node label and nowhere at all
  // for an edge label, so look at the element, then the line, then what it
  // inherits — `text-anchor` is an inherited presentation attribute.
  const anchor =
    element.getAttribute?.('text-anchor') ??
    lines[0]?.getAttribute?.('text-anchor') ??
    ancestorAttribute(element, 'text-anchor')
  const left = anchor === 'middle' ? x - width / 2 : anchor === 'end' ? x - width : x

  // The first line's own `y` and `dy` move the baseline, and mermaid writes both
  // in `em` — `<text y="-10.1"><tspan y="-0.1em" dy="1.1em">`. Ignoring them puts
  // the box a whole line above the text, which is what draws an edge label's
  // background rect somewhere the label is not.
  const first = lines[0]
  const shift = first ? lengthOf(first, 'y', size, 0) + lengthOf(first, 'dy', size, 0) : 0
  const baseline = numberOf(element, 'y') + shift

  return {x: left, y: baseline - font.ascent(size), width, height: total}
}

/** A length attribute in user units or `em`. */
function lengthOf(element, name, fontSize, fallback) {
  const raw = element.getAttribute?.(name)
  if (!raw) return fallback
  const value = Number.parseFloat(raw)
  if (!Number.isFinite(value)) return fallback
  return raw.trim().endsWith('em') ? value * fontSize : value
}

function ancestorAttribute(element, name) {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const value = node.getAttribute?.(name)
    if (value) return value
  }
  return null
}

/**
 * mermaid sets most sizes in a `<style>` block rather than on the element, so the
 * attribute is checked first, then the cascade, then the ancestors.
 */
function fontSizeOf(element) {
  for (let node = element; node; node = node.parentElement) {
    const attribute = node.getAttribute?.('font-size')
    const inline = /font-size:\s*([\d.]+)/.exec(node.getAttribute?.('style') ?? '')
    const direct = Number.parseFloat(attribute ?? inline?.[1] ?? '')
    if (Number.isFinite(direct) && direct > 0) return direct

    const computed = Number.parseFloat(node.ownerDocument?.defaultView?.getComputedStyle?.(node)?.fontSize ?? '')
    if (Number.isFinite(computed) && computed > 0) return computed
  }
  return 16
}

function pointsBounds(points) {
  const numbers = points.trim().split(/[\s,]+/).map(Number).filter(Number.isFinite)
  let box = null
  for (let index = 0; index + 1 < numbers.length; index += 2) {
    box = union(box, {x: numbers[index], y: numbers[index + 1], width: 0, height: 0})
  }
  return box
}

/**
 * Every coordinate pair in a path, treated as a point. It over-estimates a curve's
 * bounds by including its control points, which for mermaid's edges is a few pixels
 * of margin rather than a wrong picture.
 */
function pathBounds(d) {
  const numbers = d.match(/-?\d*\.?\d+(?:e-?\d+)?/gi)?.map(Number) ?? []
  let box = null
  for (let index = 0; index + 1 < numbers.length; index += 2) {
    box = union(box, {x: numbers[index], y: numbers[index + 1], width: 0, height: 0})
  }
  return box
}

/**
 * A DOM mermaid can lay out in. Returns the window plus a `dispose` that puts
 * `globalThis` back the way it was.
 */
export function createDom(font) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {pretendToBeVisual: true})
  const {window} = dom
  const restore = installGlobals(window)

  const element = window.SVGElement.prototype
  element.getBBox = function getBBox() {
    return boundsOf(this, font) ?? {x: 0, y: 0, width: 0, height: 0}
  }
  element.getComputedTextLength = function getComputedTextLength() {
    return font.measure(this.textContent ?? '', fontSizeOf(this))
  }
  element.getBoundingClientRect = function getBoundingClientRect() {
    const box = boundsOf(this, font) ?? {x: 0, y: 0, width: 0, height: 0}
    return {...box, top: box.y, left: box.x, right: box.x + box.width, bottom: box.y + box.height}
  }
  // mermaid asks for these on edges; jsdom has neither, and an edge that cannot
  // report its length is an edge with no label placed on it.
  if (!element.getTotalLength) element.getTotalLength = () => 0
  if (!element.getPointAtLength) element.getPointAtLength = () => ({x: 0, y: 0})

  return {
    window,
    document: window.document,
    dispose() {
      restore()
      dom.window.close()
    },
  }
}

export {boundsOf}
