/**
 * The body verb's table and list terminals.
 *
 * The same two properties `body.test.js` runs on: every write counts the `[[`
 * in the file before and after and expects exactly what the payload brought or
 * the delete took, and every refusal is coded and leaves the file alone. One
 * more is this file's own: **a table leaves every write rectangular**, so the
 * tests read the table back through the parser rather than matching bytes the
 * formatter is free to re-align.
 */
import assert from 'node:assert/strict'
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'

import {PATH_CODES, tableHeader, tableRows} from '@agent-wiki-toolbox/core'
import {createParser} from '@agent-wiki-toolbox/syntax'

import {BODY_CODES, body} from '../index.js'

const parser = createParser()

function wiki(notes) {
  const dir = mkdtempSync(join(tmpdir(), 'awt-body-tables-'))
  process.env.XDG_CACHE_HOME = join(dir, 'cache')
  const root = join(dir, 'wiki')
  mkdirSync(root, {recursive: true})
  for (const [path, source] of Object.entries(notes)) {
    mkdirSync(join(root, path, '..'), {recursive: true})
    writeFileSync(join(root, path), source)
  }
  const read = (path) => readFileSync(join(root, path), 'utf8')
  return {
    root,
    read,
    links: (path) => (read(path).match(/\[\[/g) ?? []).length,
    /** The nth table of a note, read back: its header, its rows as objects, and every row's width. */
    table: (path, nth = 0) => {
      const tables = parser.parse(read(path)).children.filter((node) => node.type === 'table')
      const table = tables[nth]
      return {header: tableHeader(table), rows: tableRows(table), widths: table.children.map((row) => row.children.length), align: table.align}
    },
    cleanup: () => rmSync(dir, {recursive: true, force: true}),
  }
}

const NOTE = `---
title: Grid
---

# Grid

## Fields

Intro to the fields, see [[other]].

| Option | Gives us         | Cost |
|:-------|------------------|-----:|
| a      | a seam, [[seam]] |  low |
| b      | refusals         | high |
| c      | again            |  mid |

- **\`status\`**: OKF's field, see [[okf]].
- **\`type\`**: the note's kind.
  - nested one
  - nested two
- a plain item

## Notes

| Only | One   |
|------|-------|
| x    | [[y]] |

1. first ordered
2. second ordered
`

const NOTES = {'grid.md': NOTE}
const FIELDS = [{section: 'Fields'}]
const TABLE = [...FIELDS, {table: {nth: 0}}]
const LIST = [...FIELDS, {list: {nth: 0}}]
const at = (box, address, operation, rest = {}) => body(box.root, {path: 'grid.md', address, operation, ...rest})

const refusal = (call) => {
  try {
    call()
  } catch (error) {
    if (!error.report) throw error
    return error.report
  }
  assert.fail('expected a refusal')
}

// ---------------------------------------------------------------------------
// table

test('table:replace swaps the whole table for the payload\'s, links and all', (t) => {
  const box = wiki(NOTES)
  t.after(() => box.cleanup())
  const before = box.links('grid.md')

  const report = at(box, TABLE, 'replace', {payload: '| K | V |\n|---|---|\n| one | [[uno]] |\n| two | [[dos]] |\n'})
  assert.equal(report.ok, true)
  assert.equal(report.target.kind, 'table')
  assert.deepEqual(box.table('grid.md'), {
    header: ['K', 'V'],
    rows: [
      {K: 'one', V: 'uno'},
      {K: 'two', V: 'dos'},
    ],
    widths: [2, 2, 2],
    align: [null, null],
  })
  assert.match(box.read('grid.md'), /\| \[\[uno\]\] \|/)
  assert.equal(box.links('grid.md'), before - 1 + 2)
  assert.match(box.read('grid.md'), /Intro to the fields, see \[\[other\]\]\.\n\n\| K/, 'the prose around it stayed')
})

test('table:replace refuses anything but one table, and table:delete needs the header', (t) => {
  const box = wiki(NOTES)
  t.after(() => box.cleanup())
  const before = box.links('grid.md')

  const prose = refusal(() => at(box, TABLE, 'replace', {payload: 'Not a table.\n'}))
  assert.equal(prose.code, BODY_CODES.PAYLOAD_NOT_A_TABLE)
  const two = refusal(() => at(box, TABLE, 'replace', {payload: '| A |\n|---|\n| 1 |\n\n| B |\n|---|\n| 2 |\n'}))
  assert.equal(two.code, BODY_CODES.PAYLOAD_NOT_A_TABLE)
  const blind = refusal(() => at(box, TABLE, 'delete'))
  assert.equal(blind.code, BODY_CODES.NOMINAL_REQUIRED)
  assert.equal(box.read('grid.md'), NOTE)

  const report = at(box, [...FIELDS, {table: {header: ['Option', 'Gives us', 'Cost']}}], 'delete')
  assert.equal(report.ok, true)
  assert.match(report.removed, /^\| Option \| Gives us +\| Cost \|\n/)
  assert.match(report.removed, /\[\[seam\]\]/)
  assert.equal(box.links('grid.md'), before - 1)
  assert.match(box.read('grid.md'), /see \[\[other\]\]\.\n\n- \*\*`status`\*\*/)
})

// ---------------------------------------------------------------------------
// row

test('row:replace takes a row line or an array of cells, parsed inline, and pads a short one', (t) => {
  const box = wiki(NOTES)
  t.after(() => box.cleanup())
  const before = box.links('grid.md')
  const row = (eq) => [...TABLE, {row: {where: {column: 'Option', eq}}}]

  const line = at(box, row('a'), 'replace', {payload: '| a2 | a [[link]] in a cell | none |'})
  assert.equal(line.ok, true)
  assert.equal(line.target.kind, 'row')
  assert.deepEqual(line.target.values, {Option: 'a', 'Gives us': 'a seam, seam', Cost: 'low'}, 'a link reads as its target')
  assert.deepEqual(box.table('grid.md').rows[0], {Option: 'a2', 'Gives us': 'a link in a cell', Cost: 'none'})
  assert.match(box.read('grid.md'), /\| a \[\[link\]\] in a cell \|/)
  assert.equal(box.links('grid.md'), before - 1 + 1)

  const short = at(box, row('b'), 'replace', {payload: ['b2', 'two `cells`']})
  assert.ok(short.notes.some((note) => /2 of 3 cells/.test(note)))
  assert.deepEqual(box.table('grid.md').rows[1], {Option: 'b2', 'Gives us': 'two cells', Cost: ''})
  assert.deepEqual(box.table('grid.md').widths, [3, 3, 3, 3])
})

test('row:replace refuses a long row, several lines, or the wrong shape', (t) => {
  const box = wiki(NOTES)
  t.after(() => box.cleanup())
  const row = [...TABLE, {row: {index: 0}}]

  const long = refusal(() => at(box, row, 'replace', {payload: '| 1 | 2 | 3 | 4 |'}))
  assert.equal(long.code, BODY_CODES.PAYLOAD_NOT_A_ROW)
  assert.equal(long.expected, 3)
  assert.equal(long.found, 4)
  const lines = refusal(() => at(box, row, 'replace', {payload: '| 1 | 2 | 3 |\n| 4 | 5 | 6 |'}))
  assert.equal(lines.code, BODY_CODES.PAYLOAD_NOT_A_ROW)
  const shape = refusal(() => at(box, row, 'replace', {payload: {Option: 'x'}}))
  assert.equal(shape.code, BODY_CODES.PAYLOAD_NOT_A_ROW)
  const block = refusal(() => at(box, row, 'replace', {payload: ['one\n\ntwo', 'b', 'c']}))
  assert.equal(block.code, BODY_CODES.PAYLOAD_NOT_INLINE)
  assert.equal(box.read('grid.md'), NOTE)
})

test('row:insert lands before or after the addressed row', (t) => {
  const box = wiki(NOTES)
  t.after(() => box.cleanup())
  const before = box.links('grid.md')
  const b = [...TABLE, {row: {where: {column: 'Option', eq: 'b'}}}]

  at(box, b, 'insert', {position: 'before', payload: '| ab | between, [[x]] | - |'})
  at(box, b, 'insert', {position: 'after', payload: ['bc', 'after', '-']})
  assert.deepEqual(
    box.table('grid.md').rows.map((row) => row.Option),
    ['a', 'ab', 'b', 'bc', 'c'],
  )
  assert.equal(box.links('grid.md'), before + 1)

  const position = refusal(() => at(box, b, 'insert', {position: 'first', payload: '| 1 | 2 | 3 |'}))
  assert.equal(position.code, BODY_CODES.BAD_POSITION)
})

test('row:delete needs where, reports the row line, and takes its links with it', (t) => {
  const box = wiki(NOTES)
  t.after(() => box.cleanup())
  const before = box.links('grid.md')

  const blind = refusal(() => at(box, [...TABLE, {row: {index: 0}}], 'delete'))
  assert.equal(blind.code, BODY_CODES.NOMINAL_REQUIRED)

  const report = at(box, [...TABLE, {row: {where: {column: 'Option', eq: 'a'}}}], 'delete')
  assert.equal(report.ok, true)
  assert.equal(report.removed, '| a | a seam, [[seam]] | low |\n')
  assert.deepEqual(box.table('grid.md').rows.map((row) => row.Option), ['b', 'c'])
  assert.equal(box.links('grid.md'), before - 1)
})

test('row:move reorders within the table: first, last, before, after, index', (t) => {
  const box = wiki(NOTES)
  t.after(() => box.cleanup())
  const order = () => box.table('grid.md').rows.map((row) => row.Option)
  const row = (eq) => [...TABLE, {row: {where: {column: 'Option', eq}}}]

  at(box, row('c'), 'move', {destination: {position: 'first'}})
  assert.deepEqual(order(), ['c', 'a', 'b'])
  at(box, row('c'), 'move', {destination: {position: 'last'}})
  assert.deepEqual(order(), ['a', 'b', 'c'])
  at(box, row('c'), 'move', {destination: {position: 'before', row: {where: {column: 'Option', eq: 'a'}}}})
  assert.deepEqual(order(), ['c', 'a', 'b'])
  at(box, row('c'), 'move', {destination: {position: 'after', row: 0}})
  assert.deepEqual(order(), ['a', 'c', 'b'])
  at(box, row('a'), 'move', {destination: {index: 2}})
  assert.deepEqual(order(), ['c', 'b', 'a'])
  assert.equal(box.links('grid.md'), NOTE.match(/\[\[/g).length)

  const same = at(box, row('a'), 'move', {destination: {position: 'last'}})
  assert.deepEqual(same.changed, [])
  assert.ok(same.notes.some((note) => /nothing written/.test(note)))
})

test('row:move refuses a destination of the wrong shape or one that names nothing', (t) => {
  const box = wiki(NOTES)
  t.after(() => box.cleanup())
  const row = [...TABLE, {row: {index: 0}}]

  for (const destination of [undefined, {}, {position: 'middle'}, {position: 'before'}, {position: 'after', row: 9}, {index: 3}, {index: -1}]) {
    const report = refusal(() => at(box, row, 'move', {destination}))
    assert.equal(report.code, BODY_CODES.BAD_DESTINATION, JSON.stringify(destination))
  }
  const column = refusal(() => at(box, row, 'move', {destination: {position: 'before', row: {where: {column: 'Nope', eq: 'x'}}}}))
  assert.equal(column.code, BODY_CODES.BAD_DESTINATION)
  assert.equal(box.read('grid.md'), NOTE)
})

test('a row named and misplaced resolves by name, and the disagreement is reported', (t) => {
  const box = wiki(NOTES)
  t.after(() => box.cleanup())
  const report = at(box, [...TABLE, {row: {where: {column: 'Option', eq: 'c'}, index: 0}}], 'replace', {payload: ['c', 'still c', 'mid']})
  assert.deepEqual(report.disagreements, [{segment: 2, type: 'row', field: 'index', expected: 0, actual: 2}])
  assert.deepEqual(box.table('grid.md').rows.map((row) => row['Gives us']), ['a seam, seam', 'refusals', 'still c'])
})

// ---------------------------------------------------------------------------
// column

test('column:replace keeps the column\'s place and takes header plus one value per row', (t) => {
  const box = wiki(NOTES)
  t.after(() => box.cleanup())
  const before = box.links('grid.md')

  const report = at(box, [...TABLE, {column: {header: 'Gives us'}}], 'replace', {payload: ['Buys', '[[a]]', '[[b]]', 'nothing']})
  assert.equal(report.ok, true)
  assert.equal(report.target.kind, 'column')
  const table = box.table('grid.md')
  assert.deepEqual(table.header, ['Option', 'Buys', 'Cost'])
  assert.deepEqual(table.rows.map((row) => row.Buys), ['a', 'b', 'nothing'])
  assert.deepEqual(table.align, ['left', null, 'right'], 'the alignments did not shift')
  assert.equal(box.links('grid.md'), before - 1 + 2)

  const short = refusal(() => at(box, [...TABLE, {column: {header: 'Buys'}}], 'replace', {payload: ['X', 'one']}))
  assert.equal(short.code, BODY_CODES.PAYLOAD_NOT_A_COLUMN)
  assert.equal(short.expected, 4)
  assert.equal(short.found, 2)
  const shape = refusal(() => at(box, [...TABLE, {column: {header: 'Buys'}}], 'replace', {payload: 'X\none\ntwo\nthree'}))
  assert.equal(shape.code, BODY_CODES.PAYLOAD_NOT_A_COLUMN)
})

test('column:insert touches the header and every row at one index, and leaves a ragged table rectangular', (t) => {
  const box = wiki({
    'grid.md': NOTE.replace('| b      | refusals         | high |', '| b      | refusals |'),
  })
  t.after(() => box.cleanup())
  assert.deepEqual(box.table('grid.md').widths, [3, 3, 2, 3], 'the fixture is ragged on purpose')
  const before = box.links('grid.md')

  at(box, [...TABLE, {column: {header: 'Option'}}], 'insert', {position: 'after', payload: ['Note', '[[na]]', '', 'nc']})
  at(box, [...TABLE, {column: {header: 'Cost'}}], 'insert', {position: 'before', payload: ['Unit', 'ms', 'ms', 'ms']})
  const table = box.table('grid.md')
  assert.deepEqual(table.header, ['Option', 'Note', 'Gives us', 'Unit', 'Cost'])
  assert.deepEqual(table.widths, [5, 5, 5, 5])
  assert.deepEqual(table.rows[1], {Option: 'b', Note: '', 'Gives us': 'refusals', Unit: 'ms', Cost: ''})
  assert.deepEqual(table.align, ['left', null, null, null, 'right'])
  assert.equal(box.links('grid.md'), before + 1)

  const position = refusal(() => at(box, [...TABLE, {column: {header: 'Cost'}}], 'insert', {position: 'last', payload: ['X', '1', '2', '3']}))
  assert.equal(position.code, BODY_CODES.BAD_POSITION)
})

test('column:delete needs the header, removes the index from every row, and reports the column as a table', (t) => {
  const box = wiki(NOTES)
  t.after(() => box.cleanup())
  const before = box.links('grid.md')

  const blind = refusal(() => at(box, [...TABLE, {column: {index: 1}}], 'delete'))
  assert.equal(blind.code, BODY_CODES.NOMINAL_REQUIRED)

  const report = at(box, [...TABLE, {column: {header: 'Gives us'}}], 'delete')
  assert.equal(report.ok, true)
  const removed = parser.parse(report.removed).children[0]
  assert.equal(removed.type, 'table')
  assert.deepEqual(tableHeader(removed), ['Gives us'])
  assert.deepEqual(tableRows(removed).map((row) => row['Gives us']), ['a seam, seam', 'refusals', 'again'])
  assert.match(report.removed, /\[\[seam\]\]/)
  const table = box.table('grid.md')
  assert.deepEqual(table.header, ['Option', 'Cost'])
  assert.deepEqual(table.widths, [2, 2, 2, 2])
  assert.deepEqual(table.align, ['left', 'right'])
  assert.equal(box.links('grid.md'), before - 1)
})

test('column:move reorders within the table, alignments travelling with the cells', (t) => {
  const box = wiki(NOTES)
  t.after(() => box.cleanup())
  const header = () => box.table('grid.md').header

  at(box, [...TABLE, {column: {header: 'Cost'}}], 'move', {destination: {position: 'first'}})
  assert.deepEqual(header(), ['Cost', 'Option', 'Gives us'])
  assert.deepEqual(box.table('grid.md').align, ['right', 'left', null])
  at(box, [...TABLE, {column: {header: 'Cost'}}], 'move', {destination: {position: 'after', column: 'Option'}})
  assert.deepEqual(header(), ['Option', 'Cost', 'Gives us'])
  at(box, [...TABLE, {column: {header: 'Option'}}], 'move', {destination: {position: 'before', column: {index: 2}}})
  assert.deepEqual(header(), ['Cost', 'Option', 'Gives us'])
  at(box, [...TABLE, {column: {header: 'Cost'}}], 'move', {destination: {position: 'last'}})
  assert.deepEqual(header(), ['Option', 'Gives us', 'Cost'])
  at(box, [...TABLE, {column: {header: 'Gives us'}}], 'move', {destination: {index: 0}})
  assert.deepEqual(header(), ['Gives us', 'Option', 'Cost'])
  assert.deepEqual(box.table('grid.md').rows[0], {'Gives us': 'a seam, seam', Option: 'a', Cost: 'low'})
  assert.equal(box.links('grid.md'), NOTE.match(/\[\[/g).length)

  const self = refusal(() => at(box, [...TABLE, {column: {header: 'Cost'}}], 'move', {destination: {position: 'before', column: 'Cost'}}))
  assert.equal(self.code, BODY_CODES.BAD_DESTINATION)
})

// ---------------------------------------------------------------------------
// cell

test('cell:replace sets one cell to inline markdown, and refuses a block', (t) => {
  const box = wiki(NOTES)
  t.after(() => box.cleanup())
  const before = box.links('grid.md')
  const cell = [...TABLE, {cell: {row: {where: {column: 'Option', eq: 'b'}}, column: 'Gives us'}}]

  const report = at(box, cell, 'replace', {payload: 'refusals, per [[toolbox-decisions]] and `code`'})
  assert.equal(report.ok, true)
  assert.equal(report.target.kind, 'cell')
  assert.equal(report.target.value, 'refusals')
  assert.equal(box.table('grid.md').rows[1]['Gives us'], 'refusals, per toolbox-decisions and code')
  assert.match(box.read('grid.md'), /\| refusals, per \[\[toolbox-decisions\]\] and `code` \|/)
  assert.equal(box.links('grid.md'), before + 1)

  const emptied = at(box, cell, 'replace', {payload: ''})
  assert.deepEqual(emptied.changed, ['grid.md'])
  assert.equal(box.table('grid.md').rows[1]['Gives us'], '')
  assert.deepEqual(box.table('grid.md').widths, [3, 3, 3, 3])

  at(box, cell, 'replace', {payload: '-'})
  assert.equal(box.table('grid.md').rows[1]['Gives us'], '-', 'a dash is a dash in a cell, not a list')
  at(box, cell, 'replace', {payload: 'a | b'})
  assert.equal(box.table('grid.md').rows[1]['Gives us'], 'a | b')
  assert.deepEqual(box.table('grid.md').widths, [3, 3, 3, 3], 'a pipe in a cell did not split it')

  const block = refusal(() => at(box, cell, 'replace', {payload: 'one\n\ntwo'}))
  assert.equal(block.code, BODY_CODES.PAYLOAD_NOT_INLINE)
  const none = refusal(() => at(box, cell, 'replace', {}))
  assert.equal(none.code, BODY_CODES.EMPTY_PAYLOAD)
  const del = refusal(() => at(box, cell, 'delete'))
  assert.equal(del.code, BODY_CODES.UNSUPPORTED)
  assert.match(del.notes[0], /does not apply to a cell/)
})

// ---------------------------------------------------------------------------
// list

test('list:replace swaps the whole list, and takes exactly one list', (t) => {
  const box = wiki(NOTES)
  t.after(() => box.cleanup())
  const before = box.links('grid.md')

  const report = at(box, LIST, 'replace', {payload: '1. one, [[uno]]\n2. two\n   - nested [[dos]]\n'})
  assert.equal(report.ok, true)
  assert.equal(report.target.kind, 'list')
  const after = box.read('grid.md')
  assert.match(after, /\| c +\| again +\| +mid \|\n\n1\. one, \[\[uno\]\]\n2\. two\n {3}- nested \[\[dos\]\]\n\n## Notes/)
  assert.doesNotMatch(after, /OKF's field/)
  assert.equal(box.links('grid.md'), before - 1 + 2)

  const prose = refusal(() => at(box, LIST, 'replace', {payload: 'Prose.\n'}))
  assert.equal(prose.code, BODY_CODES.PAYLOAD_NOT_A_LIST)
  const two = refusal(() => at(box, LIST, 'replace', {payload: '- a\n\n1. b\n'}))
  assert.equal(two.code, BODY_CODES.PAYLOAD_NOT_A_LIST)
})

test('list:delete needs the prefix of its first item, and a stale prefix is a mismatch', (t) => {
  const box = wiki(NOTES)
  t.after(() => box.cleanup())
  const before = box.links('grid.md')

  const blind = refusal(() => at(box, LIST, 'delete'))
  assert.equal(blind.code, BODY_CODES.NOMINAL_REQUIRED)
  assert.match(blind.notes[0], /list's prefix/)
  const stale = refusal(() => at(box, [...FIELDS, {list: {prefix: 'type', nth: 0}}], 'delete'))
  assert.equal(stale.code, PATH_CODES.PREFIX_MISMATCH)
  assert.equal(stale.found, "status: OKF's field, see okf.")
  assert.equal(box.read('grid.md'), NOTE)

  const report = at(box, [...FIELDS, {list: {prefix: 'status'}}], 'delete')
  assert.equal(report.ok, true)
  assert.match(report.removed, /^- \*\*`status`\*\*: OKF's field, see \[\[okf\]\]\.\n- \*\*`type`\*\*/)
  assert.match(report.removed, /- a plain item\n$/)
  assert.equal(box.links('grid.md'), before - 1)
  assert.match(box.read('grid.md'), /mid \|\n\n## Notes/)
})

// ---------------------------------------------------------------------------
// list_item

test('list_item:replace takes an item as a bullet or as bare content, nested content included', (t) => {
  const box = wiki(NOTES)
  t.after(() => box.cleanup())
  const before = box.links('grid.md')

  const bullet = at(box, [...LIST, {list_item: {term: 'type'}}], 'replace', {payload: '- **`kind`**: renamed, see [[kinds]].\n  - only one nested\n'})
  assert.equal(bullet.ok, true)
  assert.equal(bullet.target.kind, 'list_item')
  assert.equal(bullet.target.term, 'type')
  let after = box.read('grid.md')
  assert.match(after, /- \*\*`kind`\*\*: renamed, see \[\[kinds\]\]\.\n {2}- only one nested\n- a plain item/)
  assert.doesNotMatch(after, /nested two/)

  const bare = at(box, [...LIST, {list_item: {nth: 2}}], 'replace', {payload: 'a plainer item, [[plain]]\n\n- under it'})
  assert.equal(bare.ok, true)
  after = box.read('grid.md')
  assert.match(after, /- a plainer item, \[\[plain\]\]\n {2}- under it\n\n## Notes/)
  assert.equal(box.links('grid.md'), before + 2)
})

test('list_item:insert lands before or after, in an ordered list too, and the payload is one item', (t) => {
  const box = wiki(NOTES)
  t.after(() => box.cleanup())
  const before = box.links('grid.md')
  const item = [...LIST, {list_item: {term: 'type'}}]

  at(box, item, 'insert', {position: 'before', payload: '- **`ahead`**: [[a]]'})
  at(box, item, 'insert', {position: 'after', payload: '**`behind`**: [[b]]'})
  at(box, [{section: 'Notes'}, {list: {nth: 0}}, {list_item: {nth: 1}}], 'insert', {position: 'after', payload: 'third ordered'})
  const after = box.read('grid.md')
  assert.match(after, /- \*\*`ahead`\*\*: \[\[a\]\]\n- \*\*`type`\*\*: the note's kind\.\n {2}- nested one\n {2}- nested two\n- \*\*`behind`\*\*: \[\[b\]\]\n- a plain item/)
  assert.match(after, /2\. second ordered\n3\. third ordered\n$/)
  assert.equal(box.links('grid.md'), before + 2)

  const many = refusal(() => at(box, item, 'insert', {position: 'after', payload: '- one\n- two\n'}))
  assert.equal(many.code, BODY_CODES.PAYLOAD_NOT_A_LIST_ITEM)
  const heading = refusal(() => at(box, item, 'insert', {position: 'after', payload: '## Not in a list\n'}))
  assert.equal(heading.code, BODY_CODES.PAYLOAD_NOT_A_LIST_ITEM)
  const position = refusal(() => at(box, item, 'insert', {position: 'last', payload: 'x'}))
  assert.equal(position.code, BODY_CODES.BAD_POSITION)
  const empty = refusal(() => at(box, item, 'insert', {position: 'after', payload: '\n'}))
  assert.equal(empty.code, BODY_CODES.EMPTY_PAYLOAD)
})

test('list_item:delete needs the term, removes the item with what is nested under it, and reports it', (t) => {
  const box = wiki(NOTES)
  t.after(() => box.cleanup())
  const before = box.links('grid.md')

  const blind = refusal(() => at(box, [...LIST, {list_item: {nth: 0}}], 'delete'))
  assert.equal(blind.code, BODY_CODES.NOMINAL_REQUIRED)
  const plain = refusal(() => at(box, [...LIST, {list_item: {nth: 2}}], 'delete'))
  assert.equal(plain.code, BODY_CODES.NOMINAL_REQUIRED, 'an item with no term cannot be deleted by ordinal alone')

  const report = at(box, [...LIST, {list_item: {term: 'type', nth: 0}}], 'delete')
  assert.equal(report.ok, true)
  assert.deepEqual(report.disagreements, [{segment: 2, type: 'list_item', field: 'nth', expected: 0, actual: 1}])
  assert.equal(report.removed, "- **`type`**: the note's kind.\n  - nested one\n  - nested two\n")
  const after = box.read('grid.md')
  assert.match(after, /- \*\*`status`\*\*: OKF's field, see \[\[okf\]\]\.\n- a plain item\n\n## Notes/)
  assert.equal(box.links('grid.md'), before)

  const ordered = at(box, [{section: 'Notes'}, {list: {nth: 0}}, {list_item: {nth: 0}}], 'replace', {payload: '**x**: keyed'})
  assert.equal(ordered.ok, true)
  const gone = at(box, [{section: 'Notes'}, {list: {nth: 0}}, {list_item: {term: 'x'}}], 'delete')
  assert.equal(gone.removed, '1. **x**: keyed\n')
})

// ---------------------------------------------------------------------------
// dryRun

test('dryRun reports the table write and leaves the file', (t) => {
  const box = wiki(NOTES)
  t.after(() => box.cleanup())

  const dry = at(box, [...TABLE, {column: {header: 'Cost'}}], 'delete', {dryRun: true})
  assert.equal(dry.dryRun, true)
  assert.deepEqual(dry.changed, ['grid.md'])
  assert.match(dry.removed, /^\| Cost \|/)
  assert.equal(box.read('grid.md'), NOTE)

  const item = at(box, [...LIST, {list_item: {term: 'status'}}], 'insert', {position: 'after', payload: 'x', dryRun: true})
  assert.deepEqual(item.changed, ['grid.md'])
  assert.equal(box.read('grid.md'), NOTE)
})
