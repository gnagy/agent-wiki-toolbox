/**
 * Replacing the mermaid blocks in a built site with the PNGs `diagrams.js`
 * renders.
 *
 * Finds the blocks, hashes them so one picture embedded in five notes renders
 * once, and swaps in an `<img>`. Rendering uses no browser.
 *
 * A diagram that will not render is **reported and left as its source text**
 * rather than failing the build — the same judgement placeholders get. One bad
 * diagram should not stand between a wiki and a reader.
 */
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import { rasterize, renderDiagrams } from "./diagrams.js"
import { findFont } from "./font-metrics.js"

const unescapeHtml = (s) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, "&")

const escapeAttr = (s) =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

/**
 * The end of a start tag, skipping `>` inside quoted attribute values. Quartz
 * puts the diagram source in `data-clipboard`, and a mermaid arrow is `-->`, so
 * scanning for the first `>` ends the tag in the middle of the source.
 */
function tagEnd(html, from) {
  let quote = null
  for (let i = from; i < html.length; i++) {
    const c = html[i]
    if (quote) {
      if (c === quote) quote = null
    } else if (c === '"' || c === "'") {
      quote = c
    } else if (c === ">") {
      return i
    }
  }
  return -1
}

function findBlocks(html) {
  const blocks = []
  const re = /<code\b[^>]*?class="[^"]*\bmermaid\b/g
  let m
  while ((m = re.exec(html))) {
    const open = tagEnd(html, m.index)
    if (open === -1) continue
    const close = html.indexOf("</code>", open)
    if (close === -1) continue
    // Take the enclosing <pre> when there is one, so the button Quartz puts
    // beside the code — an expand control that needs the script we removed —
    // goes with it rather than being left as a dead thing to click.
    const preStart = html.lastIndexOf("<pre", m.index)
    const preEnd = html.indexOf("</pre>", close)
    const useP = preStart !== -1 && preEnd !== -1 && preStart < m.index
    blocks.push({
      start: useP ? preStart : m.index,
      end: useP ? preEnd + "</pre>".length : close + "</code>".length,
      source: unescapeHtml(html.slice(open + 1, close)),
    })
    re.lastIndex = close
  }
  return blocks
}

/**
 * Pre-render every mermaid block under `root` and rewrite the pages holding them.
 * Returns `{diagrams, replaced, failed}`.
 */
export async function prerenderDiagrams(root, _quartz, log) {
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name)
      return entry.isDirectory() ? walk(full) : full.endsWith(".html") ? [full] : []
    })
  const pages = walk(root)

  // One render per distinct diagram, not per appearance: the same picture is
  // routinely embedded in several notes.
  const byHash = new Map()
  for (const page of pages) {
    for (const block of findBlocks(fs.readFileSync(page, "utf8"))) {
      const hash = crypto.createHash("sha256").update(block.source).digest("hex").slice(0, 16)
      if (!byHash.has(hash)) byHash.set(hash, block.source)
    }
  }
  if (byHash.size === 0) return { diagrams: 0, replaced: 0, failed: [] }

  const font = findFont()
  if (!font) {
    throw new Error(
      byHash.size +
        " mermaid diagrams to render, and no font to measure their text with.\n" +
        "Mermaid sizes every node from the width of its label, so this is the one thing\n" +
        "that cannot be guessed — a stub guessing from the character count emits a diagram\n" +
        "27,040 pixels wide. Set AWT_DIAGRAM_FONT to a .ttf.",
    )
  }

  const hashes = [...byHash.keys()]
  log(
    `  rendering ${hashes.length} diagrams with mermaid as a library — no browser, ` +
      `measuring ${path.basename(font)}`,
  )
  const rendered = await renderDiagrams(hashes.map((hash) => byHash.get(hash)))

  const images = new Map()
  const failed = []
  const dir = path.join(root, "static", "diagrams")
  fs.mkdirSync(dir, { recursive: true })

  for (let index = 0; index < hashes.length; index++) {
    const result = rendered[index]
    if (!result?.ok) {
      failed.push({ source: byHash.get(hashes[index]), error: result?.error ?? "no result" })
      continue
    }
    try {
      const { png, width, height } = await rasterize(result.svg)
      fs.writeFileSync(path.join(dir, `${hashes[index]}.png`), png)
      // Rendered at 2x, displayed at 1x, so the diagram is sharp on the screens
      // these are read on rather than on the one that built it.
      images.set(hashes[index], { width: Math.round(width / 2), height: Math.round(height / 2) })
    } catch (error) {
      failed.push({ source: byHash.get(hashes[index]), error: `rasterizing failed: ${error.message}` })
    }
  }

  let replaced = 0
  for (const page of pages) {
    const html = fs.readFileSync(page, "utf8")
    const blocks = findBlocks(html)
    if (!blocks.length) continue
    let out = ""
    let at = 0
    for (const block of blocks) {
      const hash = crypto.createHash("sha256").update(block.source).digest("hex").slice(0, 16)
      const size = images.get(hash)
      if (!size) continue
      const rel = path
        .relative(path.dirname(page), path.join(dir, `${hash}.png`))
        .split(path.sep)
        .join("/")
      const alt = block.source.trim().split("\n")[0].trim()
      out += html.slice(at, block.start)
      out +=
        `<img src="${rel.startsWith(".") ? rel : "./" + rel}" class="mermaid-diagram" ` +
        `width="${size.width}" height="${size.height}" ` +
        `style="max-width:100%;height:auto" alt="${escapeAttr(alt)} diagram" />`
      at = block.end
      replaced++
    }
    out += html.slice(at)
    if (out !== html) fs.writeFileSync(page, out)
  }

  return { diagrams: images.size, replaced, failed }
}
