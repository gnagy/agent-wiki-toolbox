/**
 * The `body` verb's table and list terminals: `table`, `row`, `column`, `cell`,
 * `list` and `list_item`.
 *
 * One file for both families because the design says they are one shape under
 * two names — a container that scopes its elements, and an element reachable
 * only inside it — and because the hazard they share is the one that earned them
 * a place at all: **a table is not text.** The formatter re-aligns every column
 * on the way out, so a string edit computed against one reading of the file
 * matches nothing after the next write, and a column added or removed by hand
 * touches the header and every row at the same index or silently misaligns the
 * table. Everything here works on the tree and pads every row to the header's
 * width when it is done, so a table leaves this file rectangular whatever it was
 * when it came in.
 *
 * **Payloads, per terminal.** A `table` is a markdown table and a `list` a
 * markdown list, each exactly one. A `row` is one table row line — `| a | b |`,
 * split on unescaped pipes the way GFM splits it — or an array of cell strings;
 * fewer cells than the header is padded and reported, more is refused. A
 * `column` is an array of strings, header first and then one value per body row,
 * and its length has to match, since a column that is short somewhere is the
 * misalignment this exists to prevent. A `cell` is inline markdown. A
 * `list_item` is one item, written as a bullet (`- text`, with anything nested
 * under it) or as bare content; a heading, or a list of several items, is
 * refused. Every cell is parsed as inline markdown, so a `[[link]]` in one stays
 * a link.
 *
 * **`move` on a row or column stays inside its table** and takes `destination`:
 * `{position: 'first' | 'last'}`, `{position: 'before' | 'after', row}` — the
 * `row` a row spec, `{index}` or `{where: {column, eq}}`, or a bare index — or
 * `{position: 'before' | 'after', column}` with a header string, an index or
 * a spec, or `{index}` for the position it should end up at. Relocating a whole
 * table or list is the body-wide `move`, not this.
 *
 * `insert` on a row, column or list item takes `position` `before` or `after`
 * the addressed one: inside the container the address already names the
 * neighbour, so `first`/`last` would be a second way of saying `before` the
 * first or `after` the last.
 *
 * Imports `BODY_CODES` from `body.js`, which imports the operations from here.
 * The cycle is harmless — the codes are read when a handler runs, never at load —
 * and it keeps the coded failures in one table a caller can read whole.
 */
import {columnIndex, tableHeader, textOf} from '@agent-wiki-toolbox/core'

import {BODY_CODES} from './body.js'
import {refuse, serialize} from './context.js'

const VERB = 'body'
const fail = (code, message, extra = {}) => refuse(VERB, message, {code, ...extra})

// ---------------------------------------------------------------------------
// Tables

export const TABLE_OPERATIONS = {
  table: {
    replace({context, target, payload}) {
      const table = tablePayload(context, payload)
      target.parent.children.splice(target.index, 1, table)
    },

    delete({target}) {
      target.parent.children.splice(target.index, 1)
      return {removed: markdownOf([target.node])}
    },
  },

  row: {
    replace({context, target, payload, notes}) {
      const row = rowPayload(context, target.table.node, payload, notes)
      target.table.node.children.splice(target.index + 1, 1, row)
      rectangular(target.table.node)
    },

    insert({context, target, payload, position, notes}) {
      const where = positionOf(position, 'row')
      const row = rowPayload(context, target.table.node, payload, notes)
      const at = where === 'before' ? target.index : target.index + 1
      target.table.node.children.splice(at + 1, 0, row)
      rectangular(target.table.node)
    },

    delete({target}) {
      target.table.node.children.splice(target.index + 1, 1)
      return {removed: markdownOf([target.node])}
    },

    move({target, destination}) {
      const table = target.table.node
      const rows = table.children.slice(1)
      const [moving] = rows.splice(target.index, 1)
      const at = destinationIndex(destination, rows.length, (reference) => rowAt(table, rows, reference), 'row')
      rows.splice(at, 0, moving)
      table.children.splice(1, table.children.length - 1, ...rows)
    },
  },

  column: {
    replace({target, payload, context}) {
      const cells = columnPayload(context, target.table.node, payload)
      setColumn(target.table.node, target.index, cells)
    },

    insert({target, payload, position, context}) {
      const where = positionOf(position, 'column')
      const cells = columnPayload(context, target.table.node, payload)
      const at = where === 'before' ? target.index : target.index + 1
      insertColumn(target.table.node, at, cells)
    },

    delete({target}) {
      const table = target.table.node
      rectangular(table)
      const removed = columnAsTable(table, target.index)
      removeColumn(table, target.index)
      return {removed: markdownOf([removed])}
    },

    move({target, destination}) {
      const table = target.table.node
      rectangular(table)
      const width = tableHeader(table).length
      const at = destinationIndex(destination, width - 1, (reference) => columnAt(table, target.index, reference), 'column')
      // Every row moves the same cell to the same place, the alignments with them.
      for (const row of table.children) row.children.splice(at, 0, ...row.children.splice(target.index, 1))
      if (Array.isArray(table.align)) table.align.splice(at, 0, ...table.align.splice(target.index, 1))
    },
  },

  cell: {
    replace({context, target, payload}) {
      if (typeof payload !== 'string') throw fail(BODY_CODES.EMPTY_PAYLOAD, 'replacing a cell takes inline markdown')
      target.row.node.children[target.columnIndex] = cell(inlineOf(context, payload))
    },
  },
}

/** Pad every row to the header's width. What a table looks like after any write here. */
function rectangular(table) {
  const width = tableHeader(table).length
  for (const row of table.children) {
    while (row.children.length < width) row.children.push(cell([]))
    if (row.children.length > width) row.children.length = width
  }
  if (Array.isArray(table.align)) {
    while (table.align.length < width) table.align.push(null)
    if (table.align.length > width) table.align.length = width
  }
}

function cell(children) {
  return {type: 'tableCell', children}
}

function setColumn(table, index, cells) {
  rectangular(table)
  table.children.forEach((row, at) => {
    row.children[index] = cells[at]
  })
}

function insertColumn(table, index, cells) {
  rectangular(table)
  table.children.forEach((row, at) => row.children.splice(index, 0, cells[at]))
  if (Array.isArray(table.align)) table.align.splice(index, 0, null)
}

function removeColumn(table, index) {
  for (const row of table.children) row.children.splice(index, 1)
  if (Array.isArray(table.align)) table.align.splice(index, 1)
}

/** One column as a one-column table: header and values, in markdown a reader can restore from. */
function columnAsTable(table, index) {
  return {
    type: 'table',
    align: [table.align?.[index] ?? null],
    children: table.children.map((row) => ({type: 'tableRow', children: [row.children[index]]})),
  }
}

// The reference a `destination` names, as an index among the rows left after the
// moving one came out — or among the columns, where nothing has come out yet and
// the moving column is skipped over instead.

function rowAt(table, rows, reference) {
  const spec = typeof reference === 'number' ? {index: reference} : reference
  if (!spec || typeof spec !== 'object') return -1
  const all = [...Array(rows.length).keys()]
  let matched = all
  if (spec.where !== undefined) {
    const column = columnIndex(table, spec.where.column)
    if (column < 0) throw fail(BODY_CODES.BAD_DESTINATION, `the destination names no column ${JSON.stringify(spec.where.column)}; the header is ${JSON.stringify(tableHeader(table))}`)
    const wanted = String(spec.where.eq)
    matched = all.filter((at) => textOf(rows[at].children[column]) === wanted)
    if (matched.length > 1 && spec.index !== undefined) {
      const placed = matched.filter((at) => at === spec.index)
      if (placed.length === 1) matched = placed
    }
  } else if (spec.index !== undefined) {
    matched = all.filter((at) => at === spec.index)
  } else {
    return -1
  }
  if (matched.length > 1) throw fail(BODY_CODES.BAD_DESTINATION, `${matched.length} rows match the destination, and a move needs one`)
  return matched.length === 1 ? matched[0] : -1
}

function columnAt(table, moving, reference) {
  const spec = typeof reference === 'number' ? {index: reference} : typeof reference === 'string' ? {header: reference} : reference
  if (!spec || typeof spec !== 'object') return -1
  const index = spec.header !== undefined ? columnIndex(table, spec.header) : spec.index !== undefined ? columnIndex(table, spec.index) : -1
  if (index < 0 || index === moving) return -1
  // The moving column is not in the row it is about to be spliced back into.
  return index > moving ? index - 1 : index
}

/**
 * Where a moved row or column lands, as an index into the container with the
 * moving element taken out: `first`, `last`, `before`/`after` a reference, or a
 * bare `index`. Anything else, or a reference that names nothing, is refused.
 */
function destinationIndex(destination, count, resolveReference, kind) {
  const bad = (why) =>
    fail(
      BODY_CODES.BAD_DESTINATION,
      `moving a ${kind} takes a destination of {position: first | last}, {position: before | after, ${kind}: …} or {index}; ${why}`,
    )
  if (!destination || typeof destination !== 'object') throw bad('none was given')
  if (destination.index !== undefined) {
    if (!Number.isInteger(destination.index) || destination.index < 0 || destination.index > count) {
      throw bad(`index ${JSON.stringify(destination.index)} is not within 0–${count}`)
    }
    return destination.index
  }
  switch (destination.position) {
    case 'first':
      return 0
    case 'last':
      return count
    case 'before':
    case 'after': {
      const reference = destination[kind]
      if (reference === undefined) throw bad(`${destination.position} needs the ${kind} it is relative to`)
      const at = resolveReference(reference)
      if (at < 0) throw bad(`no other ${kind} matches ${JSON.stringify(reference)}`)
      return destination.position === 'before' ? at : at + 1
    }
    default:
      throw bad(`position ${JSON.stringify(destination.position)} is not one of those`)
  }
}

// ---------------------------------------------------------------------------
// Lists

export const LIST_OPERATIONS = {
  list: {
    replace({context, target, payload}) {
      const list = listPayload(context, payload)
      target.parent.children.splice(target.index, 1, list)
    },

    delete({target}) {
      target.parent.children.splice(target.index, 1)
      return {removed: markdownOf([target.node])}
    },
  },

  list_item: {
    replace({context, target, payload}) {
      const item = listItemPayload(context, payload)
      target.list.node.children.splice(target.index, 1, item)
    },

    insert({context, target, payload, position}) {
      const where = positionOf(position, 'list item')
      const item = listItemPayload(context, payload)
      const at = where === 'before' ? target.index : target.index + 1
      target.list.node.children.splice(at, 0, item)
    },

    delete({target}) {
      const {node: list} = target.list
      list.children.splice(target.index, 1)
      return {removed: markdownOf([{type: 'list', ordered: list.ordered, start: list.start ?? null, spread: false, children: [target.node]}])}
    },
  },
}

// ---------------------------------------------------------------------------
// Payloads: markdown in, nodes out

/** The payload's top-level nodes, parsed by the note's own processor; front matter dropped, nothing refused. */
function parsed(context, payload, what) {
  if (typeof payload !== 'string') throw fail(BODY_CODES.EMPTY_PAYLOAD, `this operation takes ${what} as markdown`)
  const nodes = context.processor.parse(payload).children.filter((node) => node.type !== 'yaml')
  if (nodes.length === 0) throw fail(BODY_CODES.EMPTY_PAYLOAD, 'the payload holds no markdown')
  return nodes
}

/** Exactly one node of `type`, or a refusal saying what came instead. */
function single(context, payload, type, code, what) {
  const nodes = parsed(context, payload, what)
  if (nodes.length !== 1 || nodes[0].type !== type) {
    const kinds = nodes.map((node) => node.type).join(', ')
    throw fail(code, `${what} is one markdown ${type}; the payload parsed to ${nodes.length === 1 ? `a ${kinds}` : `${nodes.length} nodes (${kinds})`}`)
  }
  return nodes[0]
}

function tablePayload(context, payload) {
  return single(context, payload, 'table', BODY_CODES.PAYLOAD_NOT_A_TABLE, 'a table payload')
}

function listPayload(context, payload) {
  return single(context, payload, 'list', BODY_CODES.PAYLOAD_NOT_A_LIST, 'a list payload')
}

/**
 * A list item, written as a one-item list or as the item's bare content. A
 * heading cannot sit in an item, and a list of several items is not one item —
 * that is `list:replace`'s payload, or several inserts.
 */
function listItemPayload(context, payload) {
  const nodes = parsed(context, payload, 'a list item')
  if (nodes.length === 1 && nodes[0].type === 'list') {
    const items = nodes[0].children
    if (items.length !== 1) {
      throw fail(BODY_CODES.PAYLOAD_NOT_A_LIST_ITEM, `a list item payload holds one item, and this list holds ${items.length}; to replace the whole list, address the list`)
    }
    return items[0]
  }
  const heading = nodes.find((node) => node.type === 'heading')
  if (heading) {
    throw fail(BODY_CODES.PAYLOAD_NOT_A_LIST_ITEM, `a list item holds no heading, and this payload holds "${textOf(heading)}"`)
  }
  return {type: 'listItem', spread: false, checked: null, children: nodes}
}

/**
 * Inline nodes for one cell, parsed the way the note's own cells are: inside a
 * table. So `-` is a dash and `#` a hash, as they would be in the file, rather
 * than a list and a heading, and a `|` — which nothing but a row line has already
 * escaped — is escaped on the way in as GFM demands. Empty text is an empty
 * cell; text that does not read as one cell, such as two paragraphs, is refused.
 */
function inlineOf(context, text) {
  const line = text.trim()
  if (line === '') return []
  const [table] = context.processor.parse(`| ${line.replace(/(^|[^\\])\|/g, '$1\\|')} |\n| --- |`).children
  if (table?.type !== 'table') {
    throw fail(BODY_CODES.PAYLOAD_NOT_INLINE, `a cell holds one line of inline markdown, and ${JSON.stringify(text)} does not read as one`)
  }
  return table.children[0].children[0].children
}

/**
 * A row's cells, from one `| a | b |` line or an array of strings, each parsed
 * inline. Short rows are padded and the padding is reported; long rows are
 * refused, since GFM would drop the extra cells without a word.
 */
function rowPayload(context, table, payload, notes) {
  const width = tableHeader(table).length
  let texts
  if (Array.isArray(payload) && payload.every((item) => typeof item === 'string')) {
    texts = payload
  } else if (typeof payload === 'string') {
    const line = payload.trim()
    if (line === '') throw fail(BODY_CODES.EMPTY_PAYLOAD, 'the payload holds no row')
    if (line.includes('\n')) throw fail(BODY_CODES.PAYLOAD_NOT_A_ROW, 'a row payload is one line; several rows are several inserts')
    texts = splitRow(line)
  } else {
    throw fail(BODY_CODES.PAYLOAD_NOT_A_ROW, 'a row payload is one `| a | b |` line or an array of cell strings')
  }
  if (texts.length > width) {
    throw fail(BODY_CODES.PAYLOAD_NOT_A_ROW, `the row has ${texts.length} cells and the table ${width}; the header is ${JSON.stringify(tableHeader(table))}`, {
      expected: width,
      found: texts.length,
    })
  }
  if (texts.length < width) notes.push(`the row had ${texts.length} of ${width} cells; the rest were left empty`)
  const cells = texts.map((text) => cell(inlineOf(context, text)))
  while (cells.length < width) cells.push(cell([]))
  return {type: 'tableRow', children: cells}
}

/** Cells of one row line, split on unescaped pipes the way GFM splits them; the outer pipes are optional. */
function splitRow(line) {
  const cells = []
  let current = ''
  for (let at = 0; at < line.length; at++) {
    const char = line[at]
    if (char === '\\' && line[at + 1] === '|') {
      current += '\\|'
      at++
    } else if (char === '|') {
      cells.push(current)
      current = ''
    } else {
      current += char
    }
  }
  cells.push(current)
  if (line.startsWith('|')) cells.shift()
  if (line.endsWith('|') && !line.endsWith('\\|')) cells.pop()
  return cells.map((text) => text.trim())
}

/** A column as cells, header first: as many strings as the table has rows, each parsed inline. */
function columnPayload(context, table, payload) {
  const rows = table.children.length
  if (!Array.isArray(payload) || !payload.every((item) => typeof item === 'string')) {
    throw fail(BODY_CODES.PAYLOAD_NOT_A_COLUMN, 'a column payload is an array of strings: the header, then one value per row')
  }
  if (payload.length !== rows) {
    throw fail(
      BODY_CODES.PAYLOAD_NOT_A_COLUMN,
      `a column here is ${rows} strings — the header and ${rows - 1} value${rows === 2 ? '' : 's'} — and the payload holds ${payload.length}`,
      {expected: rows, found: payload.length},
    )
  }
  return payload.map((text) => cell(inlineOf(context, text)))
}

function positionOf(position, kind) {
  if (position !== 'before' && position !== 'after') {
    throw fail(BODY_CODES.BAD_POSITION, `insert at a ${kind} takes position before, after${position === undefined ? '' : `, not "${position}"`}`)
  }
  return position
}

/** Markdown for a run of nodes, through the one printer everything is written with. */
function markdownOf(nodes) {
  return serialize({type: 'root', children: nodes})
}
