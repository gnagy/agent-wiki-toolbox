/**
 * Where in a markdown body: a path of segments resolved against the tree.
 *
 * One scheme serves every body verb, read and write, which is what lets the
 * safety property below be enforced once instead of reinvented per verb. Nothing
 * here mutates; this is the half that says *which node*, and the verbs above it
 * say what to do there.
 *
 * **A path, not a bag of coordinates.** `{section, table, column}` as one record
 * cannot say that a column means nothing without a table, and a failed lookup has
 * nowhere to report how far it got. A path can: segments compose left to right,
 * each resolving inside what the one before it found, and a failure names the
 * segment it stopped at.
 *
 *     [{section: 'Fields'}, {table: {nth: 0}}, {row: {where: {column: 'Option', eq: 'x'}}}]
 *
 * **Each segment carries a nominal half and a positional half, and is checked when
 * it carries both.** An address computed against one reading of a document is
 * applied to a document that has since moved — usually by the caller's own
 * earlier edit. A name survives that; an offset silently lands on the wrong real
 * node. So a segment prefers its name where it has one, and when both halves are
 * supplied and disagree the name wins and the disagreement is *reported*, never
 * hidden and never fatal. That is `patch(1)`'s behaviour: context over line
 * number, and say what the fuzz was.
 *
 * The halves, per segment type:
 *
 *     section    text: heading text            nth: ordinal among sibling sections
 *     heading    text                          nth                      (terminal)
 *     table      header: [cell texts]          nth: among tables in the container
 *     row        where: {column, eq}           index: among body rows
 *     column     header: cell text             index                    (terminal)
 *     cell       row + column, each as above                            (terminal)
 *     list       —                             nth: among lists in the container
 *     list_item  term: leading bold/code span  nth: ordinal in its list
 *     block      prefix: opening text          nth: among prose blocks  (terminal)
 *
 * `block` and `list` have no name; that is the hole in the scheme, and the path
 * form quarantines it to paths *ending* there. `block` softens it with `prefix`,
 * a check on the text the caller read: it survives edits above the block and
 * trailing edits to the block itself, and breaks exactly when the block's own
 * opening changed — which is when the caller's reading was stale about the thing
 * it cared about. `list_item`'s `term` is the same reduced guarantee for the
 * bold-lead-in habit, checked where an item has one and absent where it does not.
 *
 * **Reads and writes share the scheme and differ on cardinality.** A write needs
 * exactly one node; more than one is a refusal, the toolbox's existing
 * refuse-rather-than-guess. A read may fan out: a segment with no selector, such as
 * an empty `row` object, is every row, and a shorter path returns more.
 *
 * Failures are coded rather than inferred, and localised: how many segments
 * resolved, which one failed, why, and — on ambiguity — which candidates were seen.
 */
import {stringify, visit} from '@agent-wiki-toolbox/syntax'

/** The coded failures. A caller matches on these, never on the sentence beside them. */
export const PATH_CODES = {
  /** The path is not a non-empty array. */
  BAD_PATH: 'PATH_BAD_PATH',
  /** A segment is not `{type: spec}` with one known type and known fields. */
  BAD_SEGMENT: 'PATH_BAD_SEGMENT',
  /** A segment follows one that nothing can be reached inside of. */
  NOT_TRAVERSABLE: 'PATH_NOT_TRAVERSABLE',
  /** A segment type that this container does not hold: `column` outside a table. */
  WRONG_CONTAINER: 'PATH_WRONG_CONTAINER',
  /** No node matched the segment. */
  NO_MATCH: 'PATH_NO_MATCH',
  /** A positional half pointed past the end of what the container holds. */
  OUT_OF_RANGE: 'PATH_OUT_OF_RANGE',
  /** More than one node matched, and the mode allows one. */
  AMBIGUOUS: 'PATH_AMBIGUOUS',
  /** The block at `nth` does not open with `prefix`, and no other block does. */
  PREFIX_MISMATCH: 'PATH_PREFIX_MISMATCH',
  /** A `where` or `cell` named a column the table's header row does not have. */
  COLUMN_NOT_FOUND: 'PATH_COLUMN_NOT_FOUND',
}

export const SEGMENT_TYPES = ['section', 'heading', 'table', 'row', 'column', 'cell', 'list', 'list_item', 'block']

/**
 * What each kind of resolved target can be navigated into. A kind absent here is
 * terminal. `row` reaches `cell` so a cell can be named with its row already
 * fixed; `list_item` reaches `list` because that is what a sub-bullet is, and the
 * prose kinds beside it because an item's paragraphs and tables are ordinary
 * children of the item node.
 */
const TRAVERSABLE = {
  root: new Set(['section', 'heading', 'table', 'list', 'block']),
  section: new Set(['section', 'heading', 'table', 'list', 'block']),
  table: new Set(['row', 'column', 'cell']),
  row: new Set(['cell']),
  list: new Set(['list_item']),
  list_item: new Set(['section', 'heading', 'table', 'list', 'block']),
}

/** The fields a segment's spec may carry, so a typo cannot silently become a wildcard. */
const FIELDS = {
  section: ['text', 'nth'],
  heading: ['text', 'nth'],
  table: ['header', 'nth'],
  row: ['where', 'index'],
  column: ['header', 'index'],
  cell: ['row', 'column'],
  list: ['nth'],
  list_item: ['term', 'nth'],
  block: ['prefix', 'nth'],
}

const MODES = new Set(['read', 'write'])

// ---------------------------------------------------------------------------
// Text

/**
 * The plain text of a node, the way a person reads it: text and code runs
 * concatenated, a wikilink as its alias or target, a code block as its value.
 * Heading text here matches what the index stores for anchors.
 */
export function textOf(node) {
  if (!node) return ''
  if (node.type === 'code') return node.value ?? ''
  let text = ''
  visit(node, (child) => {
    if (child.type === 'text' || child.type === 'inlineCode') text += child.value
    else if (child.type === 'wikiLink') text += child.alias ?? child.target
  })
  return text.trim()
}

// ---------------------------------------------------------------------------
// Sections

/**
 * Where the section opened by `children[start]` ends: the index of the next
 * heading of equal or shallower depth, or `limit`. Exclusive.
 */
export function sectionEnd(children, start, limit = children.length) {
  const depth = children[start].depth
  for (let index = start + 1; index < limit; index++) {
    const node = children[index]
    if (node.type === 'heading' && node.depth <= depth) return index
  }
  return limit
}

/**
 * The immediate sections of a range — headings not nested under another heading
 * in the same range — each with its ordinal among those siblings and its own
 * range. Depth is not what decides it: `### X` followed by `## Y` are siblings,
 * because neither sits under the other.
 */
export function sectionsOf(parent, start = 0, end = parent.children.length) {
  const found = []
  let index = start
  while (index < end) {
    const node = parent.children[index]
    if (node.type !== 'heading') {
      index++
      continue
    }
    const stop = sectionEnd(parent.children, index, end)
    found.push({
      kind: 'section',
      parent,
      start: index,
      end: stop,
      node,
      depth: node.depth,
      text: textOf(node),
      nth: found.length,
    })
    index = stop
  }
  return found
}

/** Every section in a range at any depth, in document order, each with its ordinal among its own siblings. */
function allSectionsOf(parent, start, end) {
  const found = []
  for (const section of sectionsOf(parent, start, end)) {
    found.push(section)
    found.push(...allSectionsOf(parent, section.start + 1, section.end))
  }
  return found
}

// ---------------------------------------------------------------------------
// Tables

/** The header row's cell texts. A column has no name in the tree; this is where it comes from. */
export function tableHeader(table) {
  const header = table.children[0]
  return header ? header.children.map(textOf) : []
}

/**
 * Which column `header` names, or `-1`. A number is taken as an index and handed
 * back when the table has that many columns, so a caller can pass either half.
 */
export function columnIndex(table, header) {
  const names = tableHeader(table)
  if (typeof header === 'number') return header >= 0 && header < names.length ? header : -1
  return names.indexOf(header)
}

/** The body rows as objects keyed by header text — a table as data rather than pipes. */
export function tableRows(table) {
  const names = tableHeader(table)
  return table.children.slice(1).map((row) => rowObject(names, row))
}

function rowObject(names, row) {
  const object = {}
  names.forEach((name, index) => {
    object[name] = textOf(row.children[index])
  })
  return object
}

// ---------------------------------------------------------------------------
// Lists

/**
 * A list item's `term`: the text of a leading bold or code span, or `null`. The
 * wiki habit is `- **`status`**: …`, and a bold run wrapping a code span reads as
 * the code's text, since that is what a person calls the item.
 */
export function listItemTerm(item) {
  const first = item.children?.[0]
  if (!first || first.type !== 'paragraph') return null
  const lead = first.children?.[0]
  if (!lead) return null
  if (lead.type === 'strong' || lead.type === 'inlineCode') return textOf(lead)
  return null
}

// ---------------------------------------------------------------------------
// The container of a target: which node's children, and which slice of them

function rangeOf(target) {
  switch (target.kind) {
    case 'root':
      return {parent: target.node, start: 0, end: target.node.children.length}
    case 'section':
      return {parent: target.parent, start: target.start + 1, end: target.end}
    case 'list_item':
      return {parent: target.node, start: 0, end: target.node.children.length}
    default:
      return null
  }
}

/** Top-level nodes of a range of a given type, each with its ordinal among those. */
function nodesOf(target, type) {
  const {parent, start, end} = rangeOf(target)
  const found = []
  for (let index = start; index < end; index++) {
    const node = parent.children[index]
    if (node.type === type) found.push({parent, index, node, nth: found.length})
  }
  return found
}

const isBlock = (node) => node.type !== 'heading' && node.type !== 'list' && node.type !== 'table'

function blocksOf(target) {
  const {parent, start, end} = rangeOf(target)
  const found = []
  for (let index = start; index < end; index++) {
    const node = parent.children[index]
    if (isBlock(node)) found.push({kind: 'block', parent, index, node, nth: found.length, text: textOf(node)})
  }
  return found
}

// ---------------------------------------------------------------------------
// Segments

/** Normalise `{section: 'x'}` / `{table: {...}}` into `{type, spec}`, or a failure. */
function readSegment(raw, at) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return failure(PATH_CODES.BAD_SEGMENT, at, `segment ${at} is not an object`)
  }
  const keys = Object.keys(raw)
  if (keys.length !== 1) {
    return failure(PATH_CODES.BAD_SEGMENT, at, `segment ${at} must have exactly one key naming its type; it has ${keys.length}`)
  }
  const [type] = keys
  if (!FIELDS[type]) {
    return failure(PATH_CODES.BAD_SEGMENT, at, `segment ${at}: "${type}" is not a segment type; it is one of ${SEGMENT_TYPES.join(', ')}`)
  }
  let spec = raw[type]
  if (typeof spec === 'string' && (type === 'section' || type === 'heading')) spec = {text: spec}
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    return failure(PATH_CODES.BAD_SEGMENT, at, `segment ${at}: "${type}" takes an object${type === 'section' || type === 'heading' ? ' or a heading string' : ''}`)
  }
  const unknown = Object.keys(spec).filter((key) => !FIELDS[type].includes(key))
  if (unknown.length) {
    return failure(PATH_CODES.BAD_SEGMENT, at, `segment ${at}: "${type}" does not take ${unknown.join(', ')}; it takes ${FIELDS[type].join(', ')}`)
  }
  for (const field of ['nth', 'index']) {
    if (spec[field] !== undefined && !(Number.isInteger(spec[field]) && spec[field] >= 0)) {
      return failure(PATH_CODES.BAD_SEGMENT, at, `segment ${at}: "${field}" must be a non-negative integer`)
    }
  }
  return {type, spec}
}

/**
 * The one rule, applied to one segment against one container.
 *
 * `all` is every candidate; `nominal(c)` says whether a candidate carries the
 * name; `ordinal(c)` is its position; `nth` is the positional half or undefined.
 * With a name: the name selects, and a differing `nth` is a disagreement. Without:
 * `nth` selects, and no `nth` means everything.
 */
function select({all, hasNominal, nominal, ordinal, nth, at, type, field = 'nth', describe}) {
  if (hasNominal) {
    let matched = all.filter(nominal)
    if (matched.length === 0) return {targets: [], failure: failure(PATH_CODES.NO_MATCH, at, `segment ${at}: no ${type} matches ${describe}`)}
    // A name shared by several candidates is where the positional half earns
    // its keep: if exactly one of them sits at `nth`, the caller has said which.
    if (matched.length > 1 && nth !== undefined) {
      const placed = matched.filter((candidate) => ordinal(candidate) === nth)
      if (placed.length === 1) matched = placed
    }
    const disagreements = []
    if (nth !== undefined && matched.length === 1 && ordinal(matched[0]) !== nth) {
      disagreements.push({segment: at, type, field, expected: nth, actual: ordinal(matched[0])})
    }
    return {targets: matched, disagreements}
  }
  if (nth !== undefined) {
    const hit = all.find((candidate) => ordinal(candidate) === nth)
    if (!hit) {
      return {targets: [], failure: failure(PATH_CODES.OUT_OF_RANGE, at, `segment ${at}: ${type} ${field} ${nth} is past the ${all.length} the container holds`)}
    }
    return {targets: [hit], disagreements: []}
  }
  return {targets: all, disagreements: []}
}

const STEP = {
  section(target, spec, at) {
    const {parent, start, end} = rangeOf(target)
    return select({
      all: allSectionsOf(parent, start, end),
      hasNominal: spec.text !== undefined,
      nominal: (section) => section.text === spec.text,
      ordinal: (section) => section.nth,
      nth: spec.nth,
      at,
      type: 'section',
      describe: `heading "${spec.text}"`,
    })
  },

  heading(target, spec, at) {
    const step = STEP.section(target, spec, at)
    step.targets = step.targets.map((section) => ({
      kind: 'heading',
      parent: section.parent,
      index: section.start,
      node: section.node,
      depth: section.depth,
      text: section.text,
      nth: section.nth,
    }))
    return step
  },

  table(target, spec, at) {
    const all = nodesOf(target, 'table').map((found) => ({kind: 'table', ...found, header: tableHeader(found.node)}))
    return select({
      all,
      hasNominal: spec.header !== undefined,
      nominal: (table) => sameHeader(table.header, spec.header),
      ordinal: (table) => table.nth,
      nth: spec.nth,
      at,
      type: 'table',
      describe: `header ${JSON.stringify(spec.header)}`,
    })
  },

  row(target, spec, at) {
    const table = target
    const all = rowsOf(table)
    if (spec.where !== undefined) {
      const column = columnIndex(table.node, spec.where.column)
      if (column < 0) return columnMissing(at, table, spec.where.column)
      const wanted = String(spec.where.eq)
      return select({
        all,
        hasNominal: true,
        nominal: (row) => textOf(row.node.children[column]) === wanted,
        ordinal: (row) => row.index,
        nth: spec.index,
        at,
        type: 'row',
        field: 'index',
        describe: `${JSON.stringify(spec.where.column)} = ${JSON.stringify(spec.where.eq)}`,
      })
    }
    return select({all, hasNominal: false, ordinal: (row) => row.index, nth: spec.index, at, type: 'row', field: 'index'})
  },

  column(target, spec, at) {
    const table = target
    const all = tableHeader(table.node).map((header, index) => ({kind: 'column', table, index, header}))
    return select({
      all,
      hasNominal: spec.header !== undefined,
      nominal: (column) => column.header === spec.header,
      ordinal: (column) => column.index,
      nth: spec.index,
      at,
      type: 'column',
      field: 'index',
      describe: `header "${spec.header}"`,
    })
  },

  cell(target, spec, at) {
    // Reached from a table, the row half is required; from a row, it is already fixed.
    let rows
    let table
    let disagreements = []
    if (target.kind === 'row') {
      if (spec.row !== undefined) return {targets: [], failure: failure(PATH_CODES.BAD_SEGMENT, at, `segment ${at}: a cell under a row does not take "row"`)}
      rows = [target]
      table = target.table
    } else {
      table = target
      if (spec.row === undefined) return {targets: [], failure: failure(PATH_CODES.BAD_SEGMENT, at, `segment ${at}: a cell under a table needs "row"`)}
      const rowSpec = typeof spec.row === 'number' ? {index: spec.row} : spec.row
      const step = STEP.row(table, rowSpec, at)
      if (step.failure) return step
      rows = step.targets
      disagreements = step.disagreements
    }
    if (spec.column === undefined) return {targets: [], failure: failure(PATH_CODES.BAD_SEGMENT, at, `segment ${at}: a cell needs "column"`)}
    const columnSpec = typeof spec.column === 'number' ? {index: spec.column} : typeof spec.column === 'string' ? {header: spec.column} : spec.column
    const columns = STEP.column(table, columnSpec, at)
    if (columns.failure) return columns
    disagreements = [...disagreements, ...columns.disagreements]

    const targets = []
    for (const row of rows) {
      for (const column of columns.targets) {
        const node = row.node.children[column.index]
        if (!node) continue // a ragged row: nothing sits there
        targets.push({kind: 'cell', table, row, column, rowIndex: row.index, columnIndex: column.index, node})
      }
    }
    if (targets.length === 0) return {targets, failure: failure(PATH_CODES.NO_MATCH, at, `segment ${at}: no cell at that row and column`)}
    return {targets, disagreements}
  },

  list(target, spec, at) {
    const all = nodesOf(target, 'list').map((found) => ({kind: 'list', ...found}))
    return select({all, hasNominal: false, ordinal: (list) => list.nth, nth: spec.nth, at, type: 'list'})
  },

  list_item(target, spec, at) {
    const list = target
    const all = list.node.children.map((node, index) => ({kind: 'list_item', list, index, nth: index, node, term: listItemTerm(node)}))
    return select({
      all,
      hasNominal: spec.term !== undefined,
      nominal: (item) => item.term === spec.term,
      ordinal: (item) => item.nth,
      nth: spec.nth,
      at,
      type: 'list_item',
      describe: `term "${spec.term}"`,
    })
  },

  block(target, spec, at) {
    const all = blocksOf(target)
    const step = select({
      all,
      hasNominal: spec.prefix !== undefined,
      nominal: (block) => block.text.startsWith(spec.prefix),
      ordinal: (block) => block.nth,
      nth: spec.nth,
      at,
      type: 'block',
      describe: `prefix ${JSON.stringify(spec.prefix)}`,
    })
    // No block opens with the prefix. When the caller also said where it sat,
    // the report quotes what is there now, so a person can tell at a glance
    // whether the verb was right to stop — a hash mismatch could not say that.
    if (step.failure?.code === PATH_CODES.NO_MATCH && spec.nth !== undefined) {
      const there = all.find((block) => block.nth === spec.nth)
      const found = there ? there.text.slice(0, Math.max(spec.prefix.length, 40)) : null
      return {
        targets: [],
        failure: failure(PATH_CODES.PREFIX_MISMATCH, at, `segment ${at}: block ${spec.nth} does not open with ${JSON.stringify(spec.prefix)}; found ${JSON.stringify(found)}`, {
          expected: spec.prefix,
          found,
        }),
      }
    }
    return step
  },
}

function rowsOf(table) {
  return table.node.children.slice(1).map((node, index) => ({kind: 'row', table, index, node}))
}

function sameHeader(actual, wanted) {
  return Array.isArray(wanted) && actual.length === wanted.length && actual.every((cell, index) => cell === wanted[index])
}

function columnMissing(at, table, column) {
  return {
    targets: [],
    failure: failure(PATH_CODES.COLUMN_NOT_FOUND, at, `segment ${at}: no column ${JSON.stringify(column)}; the header is ${JSON.stringify(table.header)}`, {
      header: table.header,
    }),
  }
}

function failure(code, segment, message, extra = {}) {
  return {code, segment, message, ...extra}
}

// ---------------------------------------------------------------------------
// The resolver

/**
 * Resolve a path against a tree the syntax processor produced.
 *
 * Returns `{ok: true, targets, disagreements, resolved, segments, mode}` — in
 * write mode `targets` has exactly one entry; in read mode as many as the path
 * reaches — or `{ok: false, code, segment, message, resolved, …}` naming the
 * segment that failed, with `candidates` on an ambiguity and `expected`/`found`
 * on a prefix mismatch. `disagreements` travels on both: a segment whose two
 * halves pointed at different nodes resolved to the named one, and says so here.
 *
 * A target carries the node and enough of its surroundings to edit it: a section
 * has `parent`, `start` (its heading's index) and `end` (exclusive); a row or
 * column its table; a cell both; a list item its list. `describeTarget` reduces
 * one to data for a report, and `renderTarget` to data for a read.
 */
export function resolvePath(tree, path, {mode = 'write'} = {}) {
  if (!MODES.has(mode)) throw new TypeError(`mode must be read or write, not ${JSON.stringify(mode)}`)
  const base = {mode, segments: Array.isArray(path) ? path.length : 0}
  if (!Array.isArray(path) || path.length === 0) {
    return {ok: false, ...base, resolved: 0, segment: 0, code: PATH_CODES.BAD_PATH, message: 'a path is a non-empty array of segments', disagreements: []}
  }
  if (!tree || tree.type !== 'root') throw new TypeError('resolvePath wants an mdast root')

  let current = [{kind: 'root', node: tree}]
  const disagreements = []

  for (let at = 0; at < path.length; at++) {
    const segment = readSegment(path[at], at)
    if (segment.code) return {ok: false, ...base, resolved: at, disagreements, ...segment}
    const {type, spec} = segment

    // Traversability is a property of the segment kinds, not of the document, so
    // it is checked before anything is looked at.
    for (const target of current) {
      const allowed = TRAVERSABLE[target.kind]
      if (!allowed) {
        return {ok: false, ...base, resolved: at, disagreements, ...failure(PATH_CODES.NOT_TRAVERSABLE, at, `segment ${at}: nothing can be reached inside a ${target.kind}`)}
      }
      if (!allowed.has(type)) {
        return {
          ok: false,
          ...base,
          resolved: at,
          disagreements,
          ...failure(PATH_CODES.WRONG_CONTAINER, at, `segment ${at}: a ${target.kind} holds ${[...allowed].join(', ')}, not ${type}`),
        }
      }
    }

    const next = []
    let firstFailure = null
    for (const target of current) {
      const step = STEP[type](target, spec, at)
      if (step.failure) {
        firstFailure ??= step.failure
        continue
      }
      next.push(...step.targets)
      disagreements.push(...step.disagreements)
    }

    if (next.length === 0) {
      return {ok: false, ...base, resolved: at, disagreements, ...(firstFailure ?? failure(PATH_CODES.NO_MATCH, at, `segment ${at}: no ${type} matched`))}
    }
    if (mode === 'write' && next.length > 1) {
      return {
        ok: false,
        ...base,
        resolved: at,
        disagreements,
        ...failure(PATH_CODES.AMBIGUOUS, at, `segment ${at}: ${next.length} ${type}s match, and a write needs one`, {
          candidates: next.map(describeTarget),
        }),
      }
    }
    current = next
  }

  return {ok: true, ...base, resolved: path.length, targets: current, disagreements}
}

// ---------------------------------------------------------------------------
// Targets as data

/** A target reduced to what a report can print: its kind, its name where it has one, and where it sat. */
export function describeTarget(target) {
  const line = target.node?.position?.start.line
  switch (target.kind) {
    case 'section':
    case 'heading':
      return {kind: target.kind, text: target.text, depth: target.depth, nth: target.nth, line}
    case 'table':
      return {kind: 'table', header: target.header, nth: target.nth, line}
    case 'row':
      return {kind: 'row', index: target.index, values: rowObject(target.table.header, target.node), line}
    case 'column':
      return {kind: 'column', header: target.header, index: target.index}
    case 'cell':
      return {kind: 'cell', row: target.rowIndex, column: target.column.header, value: textOf(target.node), line}
    case 'list':
      return {kind: 'list', nth: target.nth, ordered: Boolean(target.node.ordered), line}
    case 'list_item':
      return {kind: 'list_item', nth: target.nth, term: target.term, text: textOf(target.node).slice(0, 80), line}
    case 'block':
      return {kind: 'block', nth: target.nth, type: target.node.type, text: target.text.slice(0, 80), line}
    default:
      return {kind: target.kind}
  }
}

/** Markdown for a run of nodes, in the dialect's plain form — links survive, house style is `format`'s concern. */
function markdownOf(nodes) {
  return stringify({type: 'root', children: nodes})
}

/**
 * A resolved target as the data a read hands back: a table as rows keyed by
 * header text, a section as its heading plus its markdown and nodes, a cell as
 * its value. Reads are a later increment and may extend this; what is here is
 * what the resolver already knows.
 */
export function renderTarget(target) {
  switch (target.kind) {
    case 'root':
      return {kind: 'root', markdown: markdownOf(target.node.children), nodes: target.node.children}
    case 'section': {
      const nodes = target.parent.children.slice(target.start, target.end)
      return {kind: 'section', text: target.text, depth: target.depth, markdown: markdownOf(nodes), nodes}
    }
    case 'heading':
      return {kind: 'heading', text: target.text, depth: target.depth}
    case 'table':
      return {kind: 'table', header: target.header, rows: tableRows(target.node)}
    case 'row':
      return {kind: 'row', index: target.index, values: rowObject(target.table.header, target.node)}
    case 'column':
      return {
        kind: 'column',
        header: target.header,
        index: target.index,
        values: target.table.node.children.slice(1).map((row) => textOf(row.children[target.index])),
      }
    case 'cell':
      return {kind: 'cell', row: target.rowIndex, column: target.column.header, value: textOf(target.node)}
    case 'list':
      return {
        kind: 'list',
        ordered: Boolean(target.node.ordered),
        items: target.node.children.map((node, index) => renderTarget({kind: 'list_item', list: target, index, nth: index, node, term: listItemTerm(node)})),
      }
    case 'list_item':
      return {
        kind: 'list_item',
        nth: target.nth,
        term: target.term,
        checked: target.node.checked ?? null,
        text: textOf(target.node),
        markdown: markdownOf([{type: 'list', ordered: target.list.node.ordered, spread: false, children: [target.node]}]),
      }
    case 'block':
      return {kind: 'block', type: target.node.type, text: target.text, markdown: markdownOf([target.node])}
    default:
      throw new TypeError(`cannot render a ${target.kind}`)
  }
}
