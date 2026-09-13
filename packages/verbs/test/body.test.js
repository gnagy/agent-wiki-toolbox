/**
 * The body verb: section, heading and block writes by segment path.
 *
 * Two properties run through every write here. **Nothing is string-spliced**:
 * the payload goes in as nodes and comes out through the wikilink-aware printer,
 * so every test counts the `[[` in the file before and after and expects the
 * difference to be exactly what the payload brought or the delete took. And
 * **refusals are coded and leave the file alone**.
 */
import assert from 'node:assert/strict'
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'

import {PATH_CODES} from '@agent-wiki-toolbox/core'

import {BODY_CODES, body} from '../index.js'

function wiki(notes) {
  const dir = mkdtempSync(join(tmpdir(), 'awt-body-'))
  process.env.XDG_CACHE_HOME = join(dir, 'cache')
  const root = join(dir, 'wiki')
  mkdirSync(root, {recursive: true})
  for (const [path, source] of Object.entries(notes)) {
    mkdirSync(join(root, path, '..'), {recursive: true})
    writeFileSync(join(root, path), source)
  }
  return {
    root,
    read: (path) => readFileSync(join(root, path), 'utf8'),
    links: (path) => (readFileSync(join(root, path), 'utf8').match(/\[\[/g) ?? []).length,
    cleanup: () => rmSync(dir, {recursive: true, force: true}),
  }
}

const NOTE = `---
title: Fixture
---

# Fixture

Intro, with a link to [[other]].

## Fields

Before the table, see [[other#its-heading]].

| Option | Gives us |
|--------|----------|
| a      | a seam   |

### Nested

Nested prose with ![[embed.png]].

## Notes

First note paragraph.

Second note paragraph, linking [[#fields]].

\`\`\`sh
awt check
\`\`\`

## Notes

Repeated heading, so its anchor is notes-1.
`

const OTHER = `---
title: Other
---

# Other

## Its heading

Points back at [[fixture#fields]] and [[fixture#nested]] and [[fixture#notes-1]].
`

const NOTES = {'fixture.md': NOTE, 'other.md': OTHER}

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
// section

test('section:replace swaps heading and range, keeps links, and rebases the payload depth', (t) => {
  const box = wiki(NOTES)
  t.after(() => box.cleanup())
  const before = box.links('fixture.md')

  const report = body(box.root, {
    path: 'fixture.md',
    address: [{section: 'Fields'}],
    operation: 'replace',
    // Written one level too shallow, and carrying a link of its own.
    payload: '# Fields\n\nNew body with [[other]] and ![[pic.png]].\n\n## Sub\n\nUnder it.\n',
  })

  assert.deepEqual(report.changed, ['fixture.md'])
  assert.equal(report.ok, false, 'the write landed, and a link into it dangles — the same verdict splitByHeading gives')
  assert.equal(report.target.kind, 'section')
  assert.equal(report.target.text, 'Fields')
  const after = box.read('fixture.md')
  assert.match(after, /## Fields\n\nNew body with \[\[other\]\] and !\[\[pic\.png\]\]\.\n\n### Sub\n\nUnder it\.\n\n## Notes/)
  assert.doesNotMatch(after, /Before the table/)
  assert.doesNotMatch(after, /### Nested/)
  // Lost: [[other#its-heading]] and ![[embed.png]]. Gained: [[other]] and ![[pic.png]].
  assert.equal(box.links('fixture.md'), before - 2 + 2)
  assert.ok(report.notes.some((note) => /deepened by 1/.test(note)))
  // The subsection's anchor is gone, and the link into it is reported, not lost quietly.
  assert.deepEqual(report.unresolved.map((entry) => [entry.from, entry.target]), [['other.md', 'fixture#nested']])
})

test('section:replace refuses a payload that does not open with a heading, or holds two sections', (t) => {
  const box = wiki(NOTES)
  t.after(() => box.cleanup())
  const source = box.read('fixture.md')

  const headless = refusal(() =>
    body(box.root, {path: 'fixture.md', address: [{section: 'Fields'}], operation: 'replace', payload: 'Just prose.\n'}),
  )
  assert.equal(headless.code, BODY_CODES.PAYLOAD_NOT_A_SECTION)

  const two = refusal(() =>
    body(box.root, {
      path: 'fixture.md',
      address: [{section: 'Fields'}],
      operation: 'replace',
      payload: '## Fields\n\nOne.\n\n## Another\n\nTwo.\n',
    }),
  )
  assert.equal(two.code, BODY_CODES.PAYLOAD_NOT_A_SECTION)

  const empty = refusal(() =>
    body(box.root, {path: 'fixture.md', address: [{section: 'Fields'}], operation: 'replace', payload: '\n\n'}),
  )
  assert.equal(empty.code, BODY_CODES.EMPTY_PAYLOAD)
  assert.equal(box.read('fixture.md'), source)
})

test('section:insert lands at first, last, before and after', (t) => {
  const box = wiki(NOTES)
  t.after(() => box.cleanup())
  const before = box.links('fixture.md')
  const at = (position, payload) =>
    body(box.root, {path: 'fixture.md', address: [{section: 'Fields'}], operation: 'insert', position, payload})

  at('first', 'At first, [[a]].\n')
  at('last', 'At last, [[b]].\n')
  at('before', 'Before it, [[c]].\n')
  at('after', 'After it, [[d]].\n')

  const after = box.read('fixture.md')
  assert.match(after, /Before it, \[\[c\]\]\.\n\n## Fields\n\nAt first, \[\[a\]\]\.\n\nBefore the table/)
  assert.match(after, /Nested prose with !\[\[embed\.png\]\]\.\n\nAt last, \[\[b\]\]\.\n\nAfter it, \[\[d\]\]\.\n\n## Notes/)
  assert.equal(box.links('fixture.md'), before + 4)
})

test('section:insert rebases a heading payload: a subsection inside, a sibling beside', (t) => {
  const box = wiki(NOTES)
  t.after(() => box.cleanup())

  body(box.root, {path: 'fixture.md', address: [{section: 'Fields'}], operation: 'insert', position: 'last', payload: '# Added inside\n\nX.\n'})
  body(box.root, {path: 'fixture.md', address: [{section: 'Fields'}], operation: 'insert', position: 'after', payload: '#### Added beside\n\nY.\n'})

  const after = box.read('fixture.md')
  assert.match(after, /### Added inside\n\nX\.\n\n## Added beside\n\nY\.\n\n## Notes/)
})

test('section:insert refuses a missing or wrong position', (t) => {
  const box = wiki(NOTES)
  t.after(() => box.cleanup())
  const report = refusal(() =>
    body(box.root, {path: 'fixture.md', address: [{section: 'Fields'}], operation: 'insert', position: 'middle', payload: 'x'}),
  )
  assert.equal(report.code, BODY_CODES.BAD_POSITION)
  const none = refusal(() => body(box.root, {path: 'fixture.md', address: [{section: 'Fields'}], operation: 'insert', payload: 'x'}))
  assert.equal(none.code, BODY_CODES.BAD_POSITION)
})

test('section:delete removes heading and range, reports what went, and needs the heading text', (t) => {
  const box = wiki(NOTES)
  t.after(() => box.cleanup())
  const before = box.links('fixture.md')

  const blind = refusal(() => body(box.root, {path: 'fixture.md', address: [{section: {nth: 0}}], operation: 'delete'}))
  assert.equal(blind.code, BODY_CODES.NOMINAL_REQUIRED)
  assert.equal(box.read('fixture.md'), NOTE)

  const report = body(box.root, {path: 'fixture.md', address: [{section: 'Fields'}], operation: 'delete'})
  assert.equal(report.ok, false, 'inbound links went dangling, so the verb is not clean')
  assert.deepEqual(report.changed, ['fixture.md'])
  assert.match(report.removed, /^## Fields\n\nBefore the table, see \[\[other#its-heading\]\]\./)
  assert.match(report.removed, /### Nested\n\nNested prose with !\[\[embed\.png\]\]\.\n$/)
  const after = box.read('fixture.md')
  assert.doesNotMatch(after, /Fields|Nested/)
  assert.match(after, /Intro, with a link to \[\[other\]\]\.\n\n## Notes/)
  // The section carried two links out.
  assert.equal(box.links('fixture.md'), before - 2)
  // And three came in: two from other.md, one from the note's own body.
  assert.deepEqual(
    report.unresolved.map((entry) => [entry.from, entry.target]).sort(),
    [
      ['fixture.md', '#fields'],
      ['other.md', 'fixture#fields'],
      ['other.md', 'fixture#nested'],
    ],
  )
})

test('shift_level moves the heading and every heading under it, and refuses at the boundary', (t) => {
  const box = wiki(NOTES)
  t.after(() => box.cleanup())

  const report = body(box.root, {path: 'fixture.md', address: [{section: 'Fields'}], operation: 'shift_level', delta: 2})
  assert.equal(report.ok, true)
  const after = box.read('fixture.md')
  assert.match(after, /#### Fields\n/)
  assert.match(after, /##### Nested\n/)
  assert.match(after, /\n## Notes\n/, 'siblings do not move')
  assert.equal(after.match(/\[\[/g).length, NOTE.match(/\[\[/g).length)

  // Nested is now at 5; +2 would take it to 7.
  const over = refusal(() =>
    body(box.root, {path: 'fixture.md', address: [{section: 'Fields'}], operation: 'shift_level', delta: 2}),
  )
  assert.equal(over.code, BODY_CODES.DEPTH_OUT_OF_RANGE)
  assert.equal(over.heading, 'Nested')
  assert.equal(over.wanted, 7)
  assert.equal(box.read('fixture.md'), after, 'refused, so nothing moved — not even the heading that would have fit')

  const under = refusal(() =>
    body(box.root, {path: 'fixture.md', address: [{section: 'Fixture'}], operation: 'shift_level', delta: -1}),
  )
  assert.equal(under.code, BODY_CODES.DEPTH_OUT_OF_RANGE)

  const bad = refusal(() => body(box.root, {path: 'fixture.md', address: [{section: 'Fields'}], operation: 'shift_level', delta: 0}))
  assert.equal(bad.code, BODY_CODES.BAD_DELTA)
})

// ---------------------------------------------------------------------------
// heading

test('heading:replace renames the heading alone and repoints every link into it', (t) => {
  const box = wiki(NOTES)
  t.after(() => box.cleanup())

  const report = body(box.root, {
    path: 'fixture.md',
    address: [{heading: 'Fields'}],
    operation: 'replace',
    payload: 'The `fields`, per [[other]]',
  })
  assert.equal(report.ok, true)
  assert.deepEqual(report.changed.sort(), ['fixture.md', 'other.md'])
  assert.equal(report.target.kind, 'heading')

  const after = box.read('fixture.md')
  assert.match(after, /## The `fields`, per \[\[other\]\]\n\nBefore the table/, 'depth kept, body untouched')
  assert.match(after, /linking \[\[#the-fields-per-other\]\]/, 'the note\'s own anchor link followed')
  assert.equal(box.links('fixture.md'), NOTE.match(/\[\[/g).length + 1)
  assert.match(box.read('other.md'), /\[\[fixture#the-fields-per-other\]\] and \[\[fixture#nested\]\]/)
  assert.deepEqual(report.unresolved, [])
  assert.ok(report.notes.some((note) => /repointed 2 links from #fields to #the-fields-per-other/.test(note)))
})

test('heading:replace takes one line, ignores heading marks, and is a no-op on the same text', (t) => {
  const box = wiki(NOTES)
  t.after(() => box.cleanup())

  const marked = body(box.root, {path: 'fixture.md', address: [{heading: 'Fields'}], operation: 'replace', payload: '#### Renamed'})
  assert.match(box.read('fixture.md'), /## Renamed\n/)
  assert.ok(marked.notes.some((note) => /depth was ignored/.test(note)))

  const same = body(box.root, {path: 'fixture.md', address: [{heading: 'Renamed'}], operation: 'replace', payload: 'Renamed'})
  assert.deepEqual(same.changed, [])
  assert.ok(same.notes.some((note) => /nothing written/.test(note)))

  const two = refusal(() =>
    body(box.root, {path: 'fixture.md', address: [{heading: 'Renamed'}], operation: 'replace', payload: 'One\n\nTwo'}),
  )
  assert.equal(two.code, BODY_CODES.PAYLOAD_NOT_A_HEADING)
  const blank = refusal(() => body(box.root, {path: 'fixture.md', address: [{heading: 'Renamed'}], operation: 'replace', payload: ' '}))
  assert.equal(blank.code, BODY_CODES.PAYLOAD_NOT_A_HEADING)
})

test('heading:replace onto a heading the note already has says the anchors moved', (t) => {
  const box = wiki(NOTES)
  t.after(() => box.cleanup())
  const report = body(box.root, {path: 'fixture.md', address: [{heading: 'Fields'}], operation: 'replace', payload: 'Notes'})
  assert.ok(report.notes.some((note) => /#notes was already an anchor/.test(note)))
  assert.match(box.read('fixture.md'), /linking \[\[#notes\]\]/)
})

test('heading is terminal for replace only, and says which refusal it is', (t) => {
  const box = wiki(NOTES)
  t.after(() => box.cleanup())
  const del = refusal(() => body(box.root, {path: 'fixture.md', address: [{heading: 'Fields'}], operation: 'delete'}))
  assert.equal(del.code, BODY_CODES.UNSUPPORTED)
  assert.match(del.notes[0], /does not apply to a heading/)

  const move = refusal(() => body(box.root, {path: 'fixture.md', address: [{section: 'Fields'}], operation: 'move'}))
  assert.equal(move.code, BODY_CODES.UNSUPPORTED)
  assert.match(move.notes[0], /not built yet/)

  const table = refusal(() =>
    body(box.root, {path: 'fixture.md', address: [{section: 'Fields'}, {table: {nth: 0}}], operation: 'move', destination: {}}),
  )
  assert.equal(table.code, BODY_CODES.UNSUPPORTED)
  assert.match(table.notes[0], /not built yet/)
})

// ---------------------------------------------------------------------------
// block

test('block:replace swaps one prose node inside its section, by prefix', (t) => {
  const box = wiki(NOTES)
  t.after(() => box.cleanup())
  const before = box.links('fixture.md')

  const report = body(box.root, {
    path: 'fixture.md',
    address: [{section: {text: 'Notes', nth: 1}}, {block: {prefix: 'Second note'}}],
    operation: 'replace',
    payload: 'Replaced, now linking [[other]] twice: [[other#its-heading]].\n',
  })
  assert.equal(report.ok, true)
  assert.equal(report.target.kind, 'block')
  const after = box.read('fixture.md')
  assert.match(after, /First note paragraph\.\n\nReplaced, now linking \[\[other\]\] twice: \[\[other#its-heading\]\]\.\n\n```sh/)
  assert.doesNotMatch(after, /Second note paragraph/)
  assert.equal(box.links('fixture.md'), before - 1 + 2)
})

test('block:insert before and after, and a block payload may not carry a heading', (t) => {
  const box = wiki(NOTES)
  t.after(() => box.cleanup())
  const before = box.links('fixture.md')
  const address = [{section: {text: 'Notes', nth: 1}}, {block: {prefix: 'First note'}}]

  body(box.root, {path: 'fixture.md', address, operation: 'insert', position: 'before', payload: 'Ahead, [[x]].\n'})
  body(box.root, {path: 'fixture.md', address, operation: 'insert', position: 'after', payload: 'Behind, [[y]].\n\n- a list too\n'})

  const after = box.read('fixture.md')
  assert.match(after, /## Notes\n\nAhead, \[\[x\]\]\.\n\nFirst note paragraph\.\n\nBehind, \[\[y\]\]\.\n\n- a list too\n\nSecond note/)
  assert.equal(box.links('fixture.md'), before + 2)

  const heading = refusal(() =>
    body(box.root, {path: 'fixture.md', address, operation: 'insert', position: 'after', payload: '## Not here\n'}),
  )
  assert.equal(heading.code, BODY_CODES.PAYLOAD_NOT_A_BLOCK)
  const first = refusal(() => body(box.root, {path: 'fixture.md', address, operation: 'insert', position: 'first', payload: 'x'}))
  assert.equal(first.code, BODY_CODES.BAD_POSITION)
})

test('block:delete needs a prefix, removes one node, and reports it', (t) => {
  const box = wiki(NOTES)
  t.after(() => box.cleanup())
  const before = box.links('fixture.md')

  const blind = refusal(() =>
    body(box.root, {path: 'fixture.md', address: [{section: {text: 'Notes', nth: 1}}, {block: {nth: 2}}], operation: 'delete'}),
  )
  assert.equal(blind.code, BODY_CODES.NOMINAL_REQUIRED)

  const report = body(box.root, {
    path: 'fixture.md',
    address: [{section: {text: 'Notes', nth: 1}}, {block: {prefix: 'awt check', nth: 2}}],
    operation: 'delete',
  })
  assert.equal(report.ok, true)
  assert.equal(report.removed, '```sh\nawt check\n```\n')
  assert.doesNotMatch(box.read('fixture.md'), /```sh/)
  assert.equal(box.links('fixture.md'), before)
})

test('a block at the root is the prose before any heading', (t) => {
  const box = wiki(NOTES)
  t.after(() => box.cleanup())
  const report = body(box.root, {
    path: 'fixture.md',
    address: [{block: {prefix: 'Intro'}}],
    operation: 'replace',
    payload: 'A new intro, still to [[other]].\n',
  })
  assert.equal(report.ok, true)
  assert.match(box.read('fixture.md'), /# Fixture\n\nA new intro, still to \[\[other\]\]\.\n\n## Fields/)
})

// ---------------------------------------------------------------------------
// The resolver's side of the protocol, seen through the verb

test('resolver failures pass through with their codes and their localisation', (t) => {
  const box = wiki(NOTES)
  t.after(() => box.cleanup())
  const source = box.read('fixture.md')

  const ambiguous = refusal(() => body(box.root, {path: 'fixture.md', address: [{section: 'Notes'}], operation: 'delete'}))
  assert.equal(ambiguous.code, PATH_CODES.AMBIGUOUS)
  assert.equal(ambiguous.segment, 0)
  assert.equal(ambiguous.candidates.length, 2)

  const missing = refusal(() =>
    body(box.root, {path: 'fixture.md', address: [{section: 'Fields'}, {section: 'Nope'}], operation: 'delete'}),
  )
  assert.equal(missing.code, PATH_CODES.NO_MATCH)
  assert.equal(missing.resolved, 1)

  const stale = refusal(() =>
    body(box.root, {
      path: 'fixture.md',
      address: [{section: {text: 'Notes', nth: 1}}, {block: {prefix: 'Not what is there', nth: 0}}],
      operation: 'replace',
      payload: 'x',
    }),
  )
  assert.equal(stale.code, PATH_CODES.PREFIX_MISMATCH)
  assert.equal(stale.found, 'First note paragraph.')

  const bad = refusal(() => body(box.root, {path: 'fixture.md', address: 'Fields', operation: 'delete'}))
  assert.equal(bad.code, PATH_CODES.BAD_PATH)
  assert.equal(box.read('fixture.md'), source)
})

test('a disagreement between the two halves is reported, and the name wins', (t) => {
  const box = wiki(NOTES)
  t.after(() => box.cleanup())
  const report = body(box.root, {
    path: 'fixture.md',
    address: [{section: {text: 'Fields', nth: 3}}],
    operation: 'shift_level',
    delta: 1,
  })
  assert.equal(report.ok, true)
  assert.deepEqual(report.disagreements, [{segment: 0, type: 'section', field: 'nth', expected: 3, actual: 0}])
  assert.match(box.read('fixture.md'), /### Fields\n/)
})

test('dryRun reports the write and leaves the file, and a missing note or operation is refused', (t) => {
  const box = wiki(NOTES)
  t.after(() => box.cleanup())

  const dry = body(box.root, {path: 'fixture.md', address: [{section: 'Fields'}], operation: 'delete', dryRun: true})
  assert.equal(dry.dryRun, true)
  assert.deepEqual(dry.changed, ['fixture.md'])
  assert.match(dry.removed, /^## Fields/)
  assert.equal(box.read('fixture.md'), NOTE)

  assert.match(refusal(() => body(box.root, {path: 'nope.md', address: [{section: 'x'}], operation: 'delete'})).notes[0], /no note at nope\.md/)
  assert.match(refusal(() => body(box.root, {path: 'fixture.md', address: [{section: 'x'}], operation: 'rename'})).notes[0], /no such operation/)
})
