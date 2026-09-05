/**
 * Text measurement for a renderer with no browser.
 *
 * mermaid sizes every node and routes every edge from `getBBox()` and
 * `getComputedTextLength()`, and jsdom performs no layout, so both are missing.
 * A character-count guess emitted a diagram 27,040 px wide; measuring the font
 * gives the right size.
 */
import {existsSync, readFileSync} from 'node:fs'
import process from 'node:process'

/**
 * A real font file, because a real width is the point. The list is
 * platform-ordered rather than preference-ordered: the first one that exists wins,
 * and `AWT_DIAGRAM_FONT` overrides all of it.
 */
const CANDIDATES = [
  process.env.AWT_DIAGRAM_FONT,
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/System/Library/Fonts/Supplemental/Helvetica.ttf',
  '/Library/Fonts/Arial.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
  '/usr/share/fonts/TTF/DejaVuSans.ttf',
  'C:\\Windows\\Fonts\\arial.ttf',
]

export function findFont() {
  for (const candidate of CANDIDATES) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return null
}

/**
 * `{path, measure(text, fontSize) -> width, lineHeight(fontSize) -> height}`.
 *
 * `lineHeight` comes from the font's own ascender/descender rather than the
 * `fontSize * 1.2` the spike approximated — that approximation is why the spike's
 * boxes came out taller than their labels needed.
 */
export async function loadFont(file = findFont()) {
  if (!file) {
    throw new Error(
      'no font file found to measure diagram text with. Mermaid sizes every node from the width of ' +
        'its label, so this cannot be guessed — set AWT_DIAGRAM_FONT to a .ttf.',
    )
  }

  const fontkit = await import('fontkit')
  const font = (fontkit.default ?? fontkit).create(readFileSync(file))
  const perEm = font.unitsPerEm
  const ascent = font.ascent ?? perEm * 0.8
  const descent = font.descent ?? -perEm * 0.2
  const gap = font.lineGap ?? 0

  return {
    path: file,
    measure(text, fontSize) {
      if (!text) return 0
      try {
        return (font.layout(String(text)).advanceWidth / perEm) * fontSize
      } catch {
        // A glyph the font has no entry for should not take the build down.
        return String(text).length * fontSize * 0.5
      }
    },
    lineHeight(fontSize) {
      return ((ascent - descent + gap) / perEm) * fontSize
    },
    /** How far above the baseline the glyphs reach — where a box's top edge is. */
    ascent(fontSize) {
      return (ascent / perEm) * fontSize
    },
  }
}
