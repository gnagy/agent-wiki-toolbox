/**
 * Re-lay out GFM tables the way IntelliJ's markdown formatter lays them out, so the
 * IDE's table inspection stays quiet and the two tools stop overwriting each other
 * on every save.
 *
 * remark and IntelliJ disagree in four ways, and patching the delimiter row alone is
 * not enough to reconcile them, so this pass recomputes the whole table:
 *
 *   1. Delimiter rows are filled, not padded: `| ---- |` becomes `|------|`.
 *   2. remark pads a delimiter to at least three dashes and widens the column to fit;
 *      IntelliJ keeps the column at content width, so `|:-:|` stays `|:-:|`.
 *   3. Centered content is biased left by IntelliJ and right by remark.
 *   4. A lone `~` needs no escape; remark escapes it anyway and IntelliJ does not.
 *
 * **There used to be a fifth**, un-escaping `!\[\[` back into a wiki embed, and
 * carrying it across from `markdown-toolbox` would have been a bug. `syntax`
 * tokenises `![[embeds]]`, so the serialiser emits them unescaped and there is
 * nothing to repair — while a document that deliberately escapes the syntax to talk
 * *about* it, as this comment does, would have been rewritten into a live embed.
 *
 * Column widths count UTF-16 code units, which is what IntelliJ counts. Do not switch
 * this to display width: it makes CJK and emoji tables look better in a fixed-width
 * font and permanently disagree with the IDE.
 */

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/
const TABLE_ROW = /^(\s*)\|(.*)\|[ \t]*$/
const DELIMITER_CELL = /^:?-+:?$/
const LONE_TILDE = /\\~(?!~)/g
const CODE_SPAN = /(`+)[\s\S]*?\1/g

/** Undo an escape remark applied that IntelliJ would not have. */
function unescapeText(text) {
  return text.replace(LONE_TILDE, '~')
}

/**
 * Drop those backslashes, but not inside an inline code span, where a backslash is
 * literal text rather than an escape. This runs as its own pass before tables are laid
 * out: it changes line lengths, so doing it afterwards would invalidate every column
 * width just computed.
 */
function unescapeLine(text) {
  let result = ''
  let last = 0
  let match

  CODE_SPAN.lastIndex = 0
  while ((match = CODE_SPAN.exec(text)) !== null) {
    result += unescapeText(text.slice(last, match.index)) + match[0]
    last = match.index + match[0].length
  }

  return result + unescapeText(text.slice(last))
}

/** Split a row into trimmed cells, treating `\|` as literal text rather than a divider. */
function splitRow(line) {
  const match = TABLE_ROW.exec(line)
  if (!match) return null

  const [, indent, inner] = match
  const cells = []
  let cell = ''

  for (let index = 0; index < inner.length; index++) {
    const char = inner[index]
    if (char === '\\' && index + 1 < inner.length) {
      cell += char + inner[++index]
    } else if (char === '|') {
      cells.push(cell)
      cell = ''
    } else {
      cell += char
    }
  }
  cells.push(cell)

  return {indent, cells: cells.map((value) => value.trim())}
}

function isDelimiterRow(row) {
  return row !== null && row.cells.length > 0 && row.cells.every((cell) => DELIMITER_CELL.test(cell))
}

function alignmentOf(cell) {
  const left = cell.startsWith(':')
  const right = cell.endsWith(':') && cell.length > 1
  if (left && right) return 'center'
  if (left) return 'left'
  if (right) return 'right'
  return 'none'
}

function pad(content, width, alignment) {
  const slack = width - content.length
  if (slack <= 0) return content
  if (alignment === 'right') return ' '.repeat(slack) + content
  if (alignment === 'center') {
    const left = Math.floor(slack / 2)
    return ' '.repeat(left) + content + ' '.repeat(slack - left)
  }
  return content + ' '.repeat(slack)
}

function delimiterCell(width, alignment) {
  switch (alignment) {
    case 'center':
      return `:${'-'.repeat(Math.max(1, width - 2))}:`
    case 'left':
      return `:${'-'.repeat(Math.max(1, width - 1))}`
    case 'right':
      return `${'-'.repeat(Math.max(1, width - 1))}:`
    default:
      return '-'.repeat(Math.max(1, width))
  }
}

/** Render header + delimiter + body rows as one aligned table. */
function renderTable(rows, delimiterIndex) {
  const alignments = rows[delimiterIndex].cells.map(alignmentOf)
  const content = rows.filter((_, index) => index !== delimiterIndex)
  const columns = Math.max(...rows.map((row) => row.cells.length))

  const widths = []
  for (let column = 0; column < columns; column++) {
    let width = 1
    for (const row of content) width = Math.max(width, (row.cells[column] ?? '').length)
    widths.push(width)
  }

  const {indent} = rows[0]
  return rows.map((row, index) => {
    if (index === delimiterIndex) {
      const cells = widths.map((width, column) => delimiterCell(width + 2, alignments[column] ?? 'none'))
      return `${indent}|${cells.join('|')}|`
    }
    const cells = widths.map(
      (width, column) => ` ${pad(row.cells[column] ?? '', width, alignments[column] ?? 'none')} `,
    )
    return `${indent}|${cells.join('|')}|`
  })
}

/**
 * Apply the IntelliJ conventions to an already-serialised markdown document.
 * Fenced code is passed through untouched — which matters, because a mermaid edge
 * label such as `A -->|"yes"| B` is indistinguishable from a table row.
 */
export function intellijTables(document) {
  const lines = document.split('\n')
  const output = []

  // Pass one: unescape outside fenced code, so pass two measures the final text.
  let fence = null
  for (let index = 0; index < lines.length; index++) {
    const open = FENCE_OPEN.exec(lines[index])
    if (fence) {
      if (open && open[1][0] === fence) fence = null
      continue
    }
    if (open) {
      fence = open[1][0]
      continue
    }
    lines[index] = unescapeLine(lines[index])
  }

  // Pass two: re-lay out every table.
  fence = null
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const open = FENCE_OPEN.exec(line)

    if (fence) {
      if (open && open[1][0] === fence) fence = null
      output.push(line)
      continue
    }
    if (open) {
      fence = open[1][0]
      output.push(line)
      continue
    }

    const row = splitRow(line)
    if (row === null) {
      output.push(line)
      continue
    }

    const block = [row]
    let end = index
    while (end + 1 < lines.length) {
      const next = splitRow(lines[end + 1])
      if (next === null || next.indent !== row.indent) break
      block.push(next)
      end++
    }

    if (block.findIndex(isDelimiterRow) !== 1) {
      output.push(line)
      continue
    }

    output.push(...renderTable(block, 1))
    index = end
  }

  return output.join('\n')
}

/** remark plugin: wraps the compiler so the pass runs on the serialised output. */
export default function remarkIntellijTables() {
  const compile = this.compiler
  if (typeof compile !== 'function') {
    throw new Error('remark-intellij-tables must be used after remark-stringify')
  }
  this.compiler = (tree, file) => intellijTables(String(compile(tree, file)))
}
