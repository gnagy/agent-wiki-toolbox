/**
 * The segment-path resolver: one scheme for every body verb.
 *
 * What these pin down is the rule, not the tree walk — a name wins over an
 * ordinal and the disagreement is reported; an ambiguous name is refused for a
 * write and fanned out for a read; a failure names the segment it stopped at.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {createParser} from '@agent-wiki-toolbox/syntax'

import {
  PATH_CODES,
  columnIndex,
  describeTarget,
  listItemTerm,
  renderTarget,
  resolvePath,
  sectionEnd,
  sectionsOf,
  tableHeader,
  tableRows,
  textOf,
} from '../index.js'

const parser = createParser()
const parse = (markdown) => parser.parse(markdown)

const NOTE = parse(`---
title: Fixture
---

# Fixture

Intro paragraph.

## Fields

Before the table.

| Option       | Gives us | Cost |
|--------------|----------|------|
| aliasDivider | a seam   | low  |
| strict       | refusals | high |
| aliasDivider | again    | mid  |

- **\`status\`**: OKF's field.
- **\`type\`**: the note's kind.
  - nested one
  - nested two
- a plain item

### Notes

Notes under Fields.

## Notes

Top-level notes, first block.

\`\`\`js
const code = true
\`\`\`

Top-level notes, third block.

| Only | One |
|------|-----|
| x    | y   |

## Fields

Second Fields section.
`)

const write = (path) => resolvePath(NOTE, path, {mode: 'write'})
const read = (path) => resolvePath(NOTE, path, {mode: 'read'})

const one = (result) => {
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.targets.length, 1)
  return result.targets[0]
}

// ---------------------------------------------------------------------------
// Sections and headings

test('a section is a heading plus the range to the next heading of equal or shallower depth', () => {
  const section = one(write([{section: {text: 'Notes', nth: 1}}]))
  assert.equal(section.kind, 'section')
  assert.equal(section.depth, 2)
  const nodes = section.parent.children.slice(section.start, section.end)
  assert.equal(nodes[0].type, 'heading')
  // Paragraph, code, paragraph, table — and stops before `## Fields`.
  assert.deepEqual(nodes.slice(1).map((node) => node.type), ['paragraph', 'code', 'paragraph', 'table'])
})

test('a heading is the node alone and cannot be traversed', () => {
  const heading = one(write([{heading: {text: 'Notes', nth: 1}}]))
  assert.equal(heading.kind, 'heading')
  assert.equal(heading.node.type, 'heading')

  const result = write([{heading: {text: 'Notes', nth: 1}}, {block: {nth: 0}}])
  assert.equal(result.ok, false)
  assert.equal(result.code, PATH_CODES.NOT_TRAVERSABLE)
  assert.equal(result.segment, 1)
  assert.equal(result.resolved, 1)
})

test('a bare string names a heading; an object carries both halves', () => {
  assert.deepEqual(describeTarget(one(write([{section: 'Fixture'}]))).text, 'Fixture')
  assert.equal(one(write([{section: {text: 'Fixture', nth: 0}}])).text, 'Fixture')
  assert.equal(one(write([{section: {nth: 0}}])).text, 'Fixture')
})

test('duplicate heading text at different depths is reached through its parent', () => {
  // `### Notes` under Fields and `## Notes` at the top: a nominal-only path is ambiguous.
  const bare = write([{section: 'Notes'}])
  assert.equal(bare.ok, false)
  assert.equal(bare.code, PATH_CODES.AMBIGUOUS)
  assert.equal(bare.segment, 0)
  assert.deepEqual(
    bare.candidates.map((candidate) => [candidate.depth, candidate.nth]),
    [[3, 0], [2, 1]],
  )

  const nested = one(write([{section: 'Fixture'}, {section: {text: 'Fields', nth: 0}}, {section: 'Notes'}]))
  assert.equal(nested.depth, 3)
  // Two headings share the text; the ordinal among siblings says which.
  const top = one(write([{section: 'Fixture'}, {section: {text: 'Notes', nth: 1}}]))
  assert.equal(top.depth, 2)
})

test('duplicate heading text at the same depth is settled by the positional half', () => {
  const both = one(write([{section: 'Fixture'}, {section: {text: 'Fields', nth: 2}}]))
  assert.equal(textOf(both.parent.children[both.start + 1]), 'Second Fields section.')

  // And when no candidate sits at nth, the name is still ambiguous.
  const nowhere = write([{section: 'Fixture'}, {section: {text: 'Fields', nth: 7}}])
  assert.equal(nowhere.code, PATH_CODES.AMBIGUOUS)
})

test('a nominal half matches at any depth inside the container', () => {
  // `Fields` is an H2 under the H1; from the root it is still reachable by name.
  const first = write([{section: {text: 'Fields', nth: 0}}])
  assert.equal(first.ok, true)
  assert.equal(first.targets[0].depth, 2)
})

test('when both halves disagree the name wins and the disagreement is reported', () => {
  const result = write([{section: 'Fixture'}, {section: {text: 'Fields', nth: 0}}, {section: {text: 'Notes', nth: 3}}])
  assert.equal(result.ok, true)
  assert.equal(result.targets[0].depth, 3)
  assert.deepEqual(result.disagreements, [{segment: 2, type: 'section', field: 'nth', expected: 3, actual: 0}])
})

test('a name that matches nothing is a miss even when the ordinal would have hit', () => {
  const result = write([{section: {text: 'Gone', nth: 0}}])
  assert.equal(result.ok, false)
  assert.equal(result.code, PATH_CODES.NO_MATCH)
  assert.equal(result.resolved, 0)
})

test('an ordinal past the end is out of range', () => {
  const result = write([{section: 'Fixture'}, {section: {nth: 9}}])
  assert.equal(result.code, PATH_CODES.OUT_OF_RANGE)
  assert.equal(result.segment, 1)
  assert.equal(result.resolved, 1)
})

test('sectionsOf and sectionEnd are the range computation the verbs will splice by', () => {
  const sections = sectionsOf(NOTE)
  assert.deepEqual(sections.map((section) => [section.text, section.nth]), [['Fixture', 0]])
  const inner = sectionsOf(NOTE, sections[0].start + 1, sections[0].end)
  assert.deepEqual(inner.map((section) => section.text), ['Fields', 'Notes', 'Fields'])
  assert.equal(sectionEnd(NOTE.children, inner[0].start), inner[1].start)
  // A range that runs to the limit ends there.
  assert.equal(sectionEnd(NOTE.children, inner[2].start), NOTE.children.length)
})

test('siblings are decided by nesting, not by depth', () => {
  const tree = parse('### Deep first\n\ntext\n\n## Shallower after\n\nmore\n')
  assert.deepEqual(sectionsOf(tree).map((section) => [section.text, section.nth]), [['Deep first', 0], ['Shallower after', 1]])
})

// ---------------------------------------------------------------------------
// Tables

test('a table is found by nth or by its header signature', () => {
  const byNth = one(write([{section: 'Fixture'}, {section: {text: 'Fields', nth: 0}}, {table: {nth: 0}}]))
  assert.deepEqual(byNth.header, ['Option', 'Gives us', 'Cost'])
  // Sections are flat siblings in the tree, so from the root this is the second table.
  const byHeader = one(write([{table: {header: ['Only', 'One']}}]))
  assert.equal(byHeader.nth, 1)
  assert.equal(tableHeader(byHeader.node)[0], 'Only')

  const wrong = write([{table: {header: ['Option', 'Gives us']}}])
  assert.equal(wrong.code, PATH_CODES.NO_MATCH)
})

test('a row is selected by where, by index, or by both with the name winning', () => {
  const fields = [{section: {text: 'Fields', nth: 0}}, {table: {nth: 0}}]
  const strict = one(write([...fields, {row: {where: {column: 'Option', eq: 'strict'}}}]))
  assert.equal(strict.index, 1)

  const byIndex = one(write([...fields, {row: {index: 0}}]))
  assert.equal(describeTarget(byIndex).values.Option, 'aliasDivider')

  const moved = write([...fields, {row: {where: {column: 'Option', eq: 'strict'}, index: 0}}])
  assert.equal(moved.ok, true)
  assert.equal(moved.targets[0].index, 1)
  assert.deepEqual(moved.disagreements, [{segment: 2, type: 'row', field: 'index', expected: 0, actual: 1}])
})

test('a key value shared by two rows is ambiguous for a write and two rows for a read', () => {
  const path = [{section: {text: 'Fields', nth: 0}}, {table: {nth: 0}}, {row: {where: {column: 'Option', eq: 'aliasDivider'}}}]
  const refused = write(path)
  assert.equal(refused.code, PATH_CODES.AMBIGUOUS)
  assert.equal(refused.segment, 2)
  assert.equal(refused.resolved, 2)
  assert.deepEqual(refused.candidates.map((candidate) => candidate.index), [0, 2])

  const many = read(path)
  assert.equal(many.ok, true)
  assert.deepEqual(many.targets.map((row) => row.index), [0, 2])

  // The positional half settles which of the two, without a disagreement.
  const settled = write([...path.slice(0, 2), {row: {where: {column: 'Option', eq: 'aliasDivider'}, index: 2}}])
  assert.equal(settled.ok, true)
  assert.equal(settled.targets[0].index, 2)
  assert.deepEqual(settled.disagreements, [])
})

test('a where on a column the table lacks is its own failure', () => {
  const result = write([{section: {text: 'Fields', nth: 0}}, {table: {nth: 0}}, {row: {where: {column: 'Nope', eq: 'x'}}}])
  assert.equal(result.code, PATH_CODES.COLUMN_NOT_FOUND)
  assert.deepEqual(result.header, ['Option', 'Gives us', 'Cost'])
})

test('a column is resolved by header text once, and sliced from every row', () => {
  const table = [{section: {text: 'Fields', nth: 0}}, {table: {nth: 0}}]
  const column = one(write([...table, {column: {header: 'Cost'}}]))
  assert.equal(column.index, 2)
  assert.deepEqual(renderTarget(column).values, ['low', 'high', 'mid'])

  const shifted = write([...table, {column: {header: 'Cost', index: 0}}])
  assert.equal(shifted.targets[0].index, 2)
  assert.deepEqual(shifted.disagreements, [{segment: 2, type: 'column', field: 'index', expected: 0, actual: 2}])

  assert.equal(columnIndex(column.table.node, 'Gives us'), 1)
  assert.equal(columnIndex(column.table.node, 1), 1)
  assert.equal(columnIndex(column.table.node, 'Missing'), -1)
  assert.equal(columnIndex(column.table.node, 5), -1)
})

test('a cell is a row and a column, each nominal or positional, from a table or from a row', () => {
  const table = [{section: {text: 'Fields', nth: 0}}, {table: {nth: 0}}]
  const nominal = one(write([...table, {cell: {row: {where: {column: 'Option', eq: 'strict'}}, column: 'Gives us'}}]))
  assert.equal(textOf(nominal.node), 'refusals')
  assert.equal(nominal.rowIndex, 1)
  assert.equal(nominal.columnIndex, 1)

  const positional = one(write([...table, {cell: {row: 1, column: 1}}]))
  assert.equal(positional.node, nominal.node)

  const viaRow = one(write([...table, {row: {index: 1}}, {cell: {column: {header: 'Gives us', index: 0}}}]))
  assert.equal(viaRow.node, nominal.node)
  assert.deepEqual(write([...table, {row: {index: 1}}, {cell: {column: {header: 'Gives us', index: 0}}}]).disagreements, [
    {segment: 3, type: 'column', field: 'index', expected: 0, actual: 1},
  ])

  assert.equal(write([...table, {row: {index: 1}}, {cell: {row: 0, column: 0}}]).code, PATH_CODES.BAD_SEGMENT)
  assert.equal(write([...table, {cell: {column: 0}}]).code, PATH_CODES.BAD_SEGMENT)
})

test('a wildcard cell in read mode is every cell of a column', () => {
  const result = read([{section: {text: 'Fields', nth: 0}}, {table: {}}, {cell: {row: {}, column: 'Option'}}])
  assert.equal(result.ok, true)
  assert.deepEqual(result.targets.map((cell) => textOf(cell.node)), ['aliasDivider', 'strict', 'aliasDivider'])
})

test('column and cell are reachable only after a table', () => {
  const result = write([{section: 'Fixture'}, {column: {header: 'Option'}}])
  assert.equal(result.code, PATH_CODES.WRONG_CONTAINER)
  assert.equal(result.segment, 1)
  assert.equal(write([{cell: {row: 0, column: 0}}]).code, PATH_CODES.WRONG_CONTAINER)
  assert.equal(write([{row: {}}]).code, PATH_CODES.WRONG_CONTAINER)
})

test('tableRows is the table as row objects keyed by header text', () => {
  const table = one(write([{table: {header: ['Only', 'One']}}]))
  assert.deepEqual(tableRows(table.node), [{Only: 'x', One: 'y'}])
  assert.deepEqual(renderTarget(table), {kind: 'table', header: ['Only', 'One'], rows: [{Only: 'x', One: 'y'}]})
})

// ---------------------------------------------------------------------------
// Lists

test('a list is positional only, and a list item has an ordinal and a weak term', () => {
  const list = [{section: {text: 'Fields', nth: 0}}, {list: {nth: 0}}]
  const byTerm = one(write([...list, {list_item: {term: 'type'}}]))
  assert.equal(byTerm.nth, 1)
  const byNth = one(write([...list, {list_item: {nth: 2}}]))
  assert.equal(byNth.term, null)
  assert.equal(textOf(byNth.node), 'a plain item')

  const moved = write([...list, {list_item: {term: 'type', nth: 0}}])
  assert.equal(moved.targets[0].nth, 1)
  assert.deepEqual(moved.disagreements, [{segment: 2, type: 'list_item', field: 'nth', expected: 0, actual: 1}])

  assert.equal(write([...list, {list_item: {term: 'absent'}}]).code, PATH_CODES.NO_MATCH)
  assert.equal(write([{section: 'Fixture'}, {list_item: {nth: 0}}]).code, PATH_CODES.WRONG_CONTAINER)
})

test('a list takes a prefix on its first item, the way a block does', () => {
  const section = [{section: {text: 'Fields', nth: 0}}]
  assert.equal(one(write([...section, {list: {prefix: 'status'}}])).nth, 0)
  const moved = write([...section, {list: {prefix: 'status', nth: 4}}])
  assert.deepEqual(moved.disagreements, [{segment: 1, type: 'list', field: 'nth', expected: 4, actual: 0}])
  const stale = write([...section, {list: {prefix: 'type', nth: 0}}])
  assert.equal(stale.code, PATH_CODES.PREFIX_MISMATCH)
  assert.equal(stale.found, 'status: OKF\'s field.')
  assert.equal(write([...section, {list: {prefix: 'type'}}]).code, PATH_CODES.NO_MATCH)
})

test('a list item traverses into its nested list', () => {
  const path = [{section: {text: 'Fields', nth: 0}}, {list: {nth: 0}}, {list_item: {term: 'type'}}, {list: {nth: 0}}, {list_item: {nth: 1}}]
  const item = one(write(path))
  assert.equal(textOf(item.node), 'nested two')

  // An item with no sub-list holds no list.
  const none = write([{section: {text: 'Fields', nth: 0}}, {list: {nth: 0}}, {list_item: {term: 'status'}}, {list: {nth: 0}}])
  assert.equal(none.code, PATH_CODES.OUT_OF_RANGE)
  assert.equal(none.resolved, 3)
})

test('a term is a leading bold or code span, and a bold-wrapped code span reads as the code', () => {
  const tree = parse('- **bold lead**: x\n- `code lead`: y\n- **`both`**: z\n- plain\n- *emphasis* is not a term\n')
  assert.deepEqual(tree.children[0].children.map(listItemTerm), ['bold lead', 'code lead', 'both', null, null])
})

test('a shared term is ambiguous for a write and a fan-out for a read', () => {
  const tree = parse('- **a**: one\n- **a**: two\n')
  const refused = resolvePath(tree, [{list: {nth: 0}}, {list_item: {term: 'a'}}])
  assert.equal(refused.code, PATH_CODES.AMBIGUOUS)
  const both = resolvePath(tree, [{list: {nth: 0}}, {list_item: {term: 'a'}}], {mode: 'read'})
  assert.equal(both.targets.length, 2)
  const all = resolvePath(tree, [{list: {}}, {list_item: {}}], {mode: 'read'})
  assert.equal(all.targets.length, 2)
})

// ---------------------------------------------------------------------------
// Blocks

test('a block is a non-heading, non-list, non-table node, counted within its container', () => {
  const notes = [{section: 'Fixture'}, {section: {text: 'Notes', nth: 1}}]
  const first = one(write([...notes, {block: {nth: 0}}]))
  assert.equal(first.text, 'Top-level notes, first block.')
  const code = one(write([...notes, {block: {nth: 1}}]))
  assert.equal(code.node.type, 'code')
  // The table in that section is not a block, so nth 2 is the third paragraph and 3 is past the end.
  assert.equal(one(write([...notes, {block: {nth: 2}}])).text, 'Top-level notes, third block.')
  assert.equal(write([...notes, {block: {nth: 3}}]).code, PATH_CODES.OUT_OF_RANGE)
})

test('a prefix is checked against the block at nth, and a moved block is found by its prefix', () => {
  const notes = [{section: 'Fixture'}, {section: {text: 'Notes', nth: 1}}]
  const checked = write([...notes, {block: {nth: 0, prefix: 'Top-level notes, first'}}])
  assert.equal(checked.ok, true)
  assert.deepEqual(checked.disagreements, [])

  const moved = write([...notes, {block: {nth: 0, prefix: 'Top-level notes, third'}}])
  assert.equal(moved.ok, true)
  assert.equal(moved.targets[0].nth, 2)
  assert.deepEqual(moved.disagreements, [{segment: 2, type: 'block', field: 'nth', expected: 0, actual: 2}])

  // A code block's text is its value.
  assert.equal(one(write([...notes, {block: {prefix: 'const code'}}])).node.type, 'code')
})

test('a prefix nothing opens with is a mismatch that quotes what is there', () => {
  const result = write([{section: 'Fixture'}, {section: {text: 'Notes', nth: 1}}, {block: {nth: 0, prefix: 'The structural verbs'}}])
  assert.equal(result.ok, false)
  assert.equal(result.code, PATH_CODES.PREFIX_MISMATCH)
  assert.equal(result.segment, 2)
  assert.equal(result.resolved, 2)
  assert.equal(result.expected, 'The structural verbs')
  assert.equal(result.found, 'Top-level notes, first block.')

  // Prefix alone with no nth is a plain miss.
  assert.equal(write([{section: 'Fixture'}, {section: {text: 'Notes', nth: 1}}, {block: {prefix: 'The structural verbs'}}]).code, PATH_CODES.NO_MATCH)
})

test('two blocks with the same opening are ambiguous, and the resolver sees both rather than guessing', () => {
  const tree = parse('Same start, one.\n\nSame start, two.\n')
  const refused = resolvePath(tree, [{block: {prefix: 'Same start'}}])
  assert.equal(refused.code, PATH_CODES.AMBIGUOUS)
  assert.equal(refused.candidates.length, 2)
  // nth picks among them, with nothing to report.
  const picked = resolvePath(tree, [{block: {prefix: 'Same start', nth: 1}}])
  assert.equal(picked.ok, true)
  assert.deepEqual(picked.disagreements, [])
})

test('a block is terminal', () => {
  const result = write([{section: 'Fixture'}, {block: {nth: 0}}, {block: {nth: 0}}])
  assert.equal(result.code, PATH_CODES.NOT_TRAVERSABLE)
  assert.equal(result.resolved, 2)
})

// ---------------------------------------------------------------------------
// Cardinality and fan-out

test('a read fans out through every container; a write refuses at the first ambiguity', () => {
  // Two `Fields` sections; only the first holds a table.
  const tables = read([{section: 'Fixture'}, {section: 'Fields'}, {table: {}}])
  assert.equal(tables.ok, true)
  assert.equal(tables.targets.length, 1)

  const rows = read([{section: 'Fixture'}, {section: 'Fields'}, {table: {}}, {row: {}}])
  assert.equal(rows.targets.length, 3)

  const refused = write([{section: 'Fixture'}, {section: 'Fields'}, {table: {nth: 0}}])
  assert.equal(refused.code, PATH_CODES.AMBIGUOUS)
  assert.equal(refused.segment, 1)
})

test('a read that reaches nothing anywhere reports the first container\'s reason', () => {
  const result = read([{section: 'Fixture'}, {section: 'Fields'}, {table: {header: ['Not', 'Here']}}])
  assert.equal(result.ok, false)
  assert.equal(result.code, PATH_CODES.NO_MATCH)
  assert.equal(result.segment, 2)
  assert.equal(result.resolved, 2)
})

test('a wildcard in write mode is fine when it matches exactly one', () => {
  assert.equal(write([{table: {header: ['Only', 'One']}}, {row: {}}]).ok, true)
})

// ---------------------------------------------------------------------------
// Malformed paths

test('a malformed path or segment is coded, and names the segment', () => {
  assert.equal(write([]).code, PATH_CODES.BAD_PATH)
  assert.equal(write('Fields').code, PATH_CODES.BAD_PATH)
  assert.equal(write([{section: 'Fixture'}, 'Fields']).code, PATH_CODES.BAD_SEGMENT)
  assert.equal(write([{section: 'Fixture'}, 'Fields']).segment, 1)
  assert.equal(write([{section: 'Fixture', table: {}}]).code, PATH_CODES.BAD_SEGMENT)
  assert.equal(write([{paragraph: {nth: 0}}]).code, PATH_CODES.BAD_SEGMENT)
  assert.equal(write([{table: 'Fields'}]).code, PATH_CODES.BAD_SEGMENT)
  // A typo does not become a wildcard.
  assert.equal(write([{section: {txt: 'Fields'}}]).code, PATH_CODES.BAD_SEGMENT)
  assert.equal(write([{section: {nth: -1}}]).code, PATH_CODES.BAD_SEGMENT)
  assert.equal(write([{section: {nth: '0'}}]).code, PATH_CODES.BAD_SEGMENT)
  assert.throws(() => resolvePath(NOTE, [{section: 'Fixture'}], {mode: 'edit'}), TypeError)
})

// ---------------------------------------------------------------------------
// Rendering

test('renderTarget hands back data a read can return', () => {
  const section = renderTarget(one(write([{section: 'Fixture'}, {section: {text: 'Notes', nth: 1}}])))
  assert.equal(section.kind, 'section')
  assert.match(section.markdown, /^## Notes\n\nTop-level notes, first block\./)
  assert.equal(section.nodes.length, 5)

  const heading = renderTarget(one(write([{heading: 'Fixture'}])))
  assert.deepEqual(heading, {kind: 'heading', text: 'Fixture', depth: 1})

  const row = renderTarget(one(write([{section: {text: 'Fields', nth: 0}}, {table: {nth: 0}}, {row: {index: 1}}])))
  assert.deepEqual(row, {kind: 'row', index: 1, values: {Option: 'strict', 'Gives us': 'refusals', Cost: 'high'}})

  const cell = renderTarget(one(write([{section: {text: 'Fields', nth: 0}}, {table: {nth: 0}}, {cell: {row: 1, column: 'Cost'}}])))
  assert.deepEqual(cell, {kind: 'cell', row: 1, column: 'Cost', value: 'high'})

  const list = renderTarget(one(write([{section: {text: 'Fields', nth: 0}}, {list: {nth: 0}}])))
  assert.equal(list.ordered, false)
  assert.deepEqual(list.items.map((item) => item.term), ['status', 'type', null])

  const item = renderTarget(one(write([{section: {text: 'Fields', nth: 0}}, {list: {nth: 0}}, {list_item: {term: 'status'}}])))
  assert.equal(item.term, 'status')
  assert.match(item.markdown, /^\* \*\*`status`\*\*: OKF's field\./)

  const block = renderTarget(one(write([{section: 'Fixture'}, {block: {nth: 0}}])))
  assert.deepEqual(block, {kind: 'block', type: 'paragraph', text: 'Intro paragraph.', markdown: 'Intro paragraph.\n'})
})

test('a wikilink in a heading or cell reads as its target, so the address survives the printer', () => {
  const tree = parse('## See [[other-note]]\n\n| Note | Why |\n|---|---|\n| [[a-note]] | because |\n')
  assert.equal(one(resolvePath(tree, [{section: 'See other-note'}])).text, 'See other-note')
  const row = one(resolvePath(tree, [{table: {nth: 0}}, {row: {where: {column: 'Note', eq: 'a-note'}}}]))
  assert.equal(row.index, 0)
})
