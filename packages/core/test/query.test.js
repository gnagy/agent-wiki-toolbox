/**
 * `query` — the body domain's read.
 *
 * What these pin down is the shape of the answer rather than the resolution, which
 * `segments.test.js` already owns: a table comes back as rows keyed by header, a
 * section as its markdown and the lines it sat on, an outline as the paths that
 * reach each heading, and a failure as the resolver's own report with nothing
 * added and nothing summarised away.
 */
import assert from 'node:assert/strict'
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'

import {PATH_CODES, loadWorkspace, query} from '../index.js'

const NOTE = `---
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

- **\`status\`**: OKF's field.
- **\`type\`**: the note's kind.

### Notes

Notes under Fields.

## Notes

Top-level notes.
`

function box(t) {
  const dir = mkdtempSync(join(tmpdir(), 'awt-query-'))
  process.env.XDG_CACHE_HOME = join(dir, 'cache')
  const root = join(dir, 'wiki')
  mkdirSync(root, {recursive: true})
  writeFileSync(join(root, 'fixture.md'), NOTE)
  t.after(() => rmSync(dir, {recursive: true, force: true}))
  return loadWorkspace(root, {cache: false})
}

const ask = (workspace, path, rest = {}) => query(workspace, {note: 'fixture.md', path, ...rest})

test('no path is the outline, and every heading carries the path that reaches it', (t) => {
  const workspace = box(t)
  const outline = ask(workspace, undefined)

  assert.equal(outline.ok, true)
  assert.equal(outline.kind, 'outline')
  assert.equal(outline.title, 'Fixture')
  assert.deepEqual(outline.outline.map((entry) => [entry.text, entry.depth, entry.nth]), [
    ['Fixture', 1, 0],
    ['Fields', 2, 0],
    ['Notes', 3, 0],
    ['Notes', 2, 1],
  ])
  // The ordinal is among siblings, not in the document: `### Notes` is the first
  // of its parent's children and `## Notes` the second of the note's.
  assert.deepEqual(outline.outline[2].path, [
    {section: {text: 'Fixture', nth: 0}},
    {section: {text: 'Fields', nth: 0}},
    {section: {text: 'Notes', nth: 0}},
  ])
  // And the path it hands back is one the resolver takes.
  assert.equal(ask(workspace, outline.outline[2].path).targets[0].text, 'Notes')
})

test('outline: true asks for the outline even with a path in hand', (t) => {
  const workspace = box(t)
  assert.equal(ask(workspace, [{section: 'Fields'}], {outline: true}).kind, 'outline')
})

test('a one-segment section path is the whole section, with the lines it occupies', (t) => {
  const workspace = box(t)
  const found = ask(workspace, [{section: 'Fields'}])

  assert.equal(found.ok, true)
  assert.equal(found.count, 1)
  const [section] = found.targets
  assert.equal(section.kind, 'section')
  assert.equal(section.depth, 2)
  assert.match(section.markdown, /^## Fields/)
  assert.match(section.markdown, /Notes under Fields/, 'the subsection is inside it')
  assert.equal(section.line, 9)
  assert.ok(section.endLine > section.line)
  // mdast never leaves: the transport is JSON and a position-carrying tree is
  // both enormous and useless to whoever asked.
  assert.ok(!('nodes' in section))
  assert.doesNotThrow(() => JSON.stringify(found))
})

test('a table comes back as rows keyed by header text', (t) => {
  const workspace = box(t)
  const [table] = ask(workspace, [{section: 'Fields'}, {table: {}}]).targets

  assert.deepEqual(table.header, ['Option', 'Gives us', 'Cost'])
  assert.deepEqual(table.rows, [
    {Option: 'aliasDivider', 'Gives us': 'a seam', Cost: 'low'},
    {Option: 'strict', 'Gives us': 'refusals', Cost: 'high'},
  ])
})

test('a column is its cells, and a row is an object', (t) => {
  const workspace = box(t)

  const [column] = ask(workspace, [{table: {}}, {column: {header: 'Cost'}}]).targets
  assert.deepEqual(column.values, ['low', 'high'])

  const [row] = ask(workspace, [{table: {}}, {row: {where: {column: 'Option', eq: 'strict'}}}]).targets
  assert.deepEqual(row.values, {Option: 'strict', 'Gives us': 'refusals', Cost: 'high'})

  const [cell] = ask(workspace, [{table: {}}, {cell: {row: 0, column: 'Cost'}}]).targets
  assert.equal(cell.value, 'low')
})

test('a read fans out where a write would refuse, and says how many it reached', (t) => {
  const workspace = box(t)
  const rows = ask(workspace, [{table: {}}, {row: {}}])
  assert.equal(rows.count, 2)
  assert.deepEqual(rows.targets.map((row) => row.values.Option), ['aliasDivider', 'strict'])
})

test('a list, a list item and a block come back as markdown', (t) => {
  const workspace = box(t)

  const [list] = ask(workspace, [{section: 'Fields'}, {list: {}}]).targets
  assert.equal(list.items.length, 2)
  assert.equal(list.items[0].term, 'status')

  const [item] = ask(workspace, [{section: 'Fields'}, {list: {}}, {list_item: {term: 'type'}}]).targets
  assert.match(item.markdown, /the note's kind/)

  const [block] = ask(workspace, [{section: 'Fields'}, {block: {nth: 0}}]).targets
  assert.equal(block.text, 'Before the table.')
  assert.equal(block.type, 'paragraph')
  assert.ok(block.line > 0)
})

test('a disagreement between the two halves travels with the answer', (t) => {
  const workspace = box(t)
  // The name is right and the ordinal is not: the name wins and the read says so.
  const found = ask(workspace, [{section: {text: 'Notes', nth: 0}}, {block: {nth: 0}}])
  assert.equal(found.ok, true)
  assert.equal(found.disagreements.length, 0, 'nth 0 names the ### Notes under Fields, and agrees')

  const moved = ask(workspace, [{section: {text: 'Fields', nth: 2}}])
  assert.equal(moved.ok, true)
  assert.deepEqual(moved.disagreements, [{segment: 0, type: 'section', field: 'nth', expected: 2, actual: 0}])
})

test("a failure is the resolver's report, unchanged", (t) => {
  const workspace = box(t)
  const missed = ask(workspace, [{section: 'Nowhere'}])

  assert.equal(missed.ok, false)
  assert.equal(missed.note, 'fixture.md')
  assert.equal(missed.code, PATH_CODES.NO_MATCH)
  assert.equal(missed.segment, 0)
  assert.equal(missed.resolved, 0)
  assert.match(missed.message, /Nowhere/)

  const wrong = ask(workspace, [{section: 'Fields'}, {column: {}}])
  assert.equal(wrong.code, PATH_CODES.WRONG_CONTAINER)

  const typo = ask(workspace, [{sections: 'Fields'}])
  assert.equal(typo.code, PATH_CODES.BAD_SEGMENT)
})

test('a note that is not there is said so rather than resolved against nothing', (t) => {
  const workspace = box(t)
  const missing = query(workspace, {note: 'nope.md', path: [{section: 'Fields'}]})
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'QUERY_NOTE_NOT_FOUND')
  assert.match(missing.message, /workspace-relative/)
})
