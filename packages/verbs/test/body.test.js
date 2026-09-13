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

import {PATH_CODES, loadWorkspace} from '@agent-wiki-toolbox/core'

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

  // Every cell of the terminal-for matrix is built now, so the "not built yet"
  // branch has no example left; what a move without a destination gets is the
  // destination refusal, and a table move is asked for its header.
  const move = refusal(() =>
    body(box.root, {path: 'fixture.md', address: [{section: 'Fields'}, {table: {nth: 0}}, {row: {index: 0}}], operation: 'move'}),
  )
  assert.equal(move.code, BODY_CODES.BAD_DESTINATION)

  const table = refusal(() =>
    body(box.root, {path: 'fixture.md', address: [{section: 'Fields'}, {table: {nth: 0}}], operation: 'move', destination: {}}),
  )
  assert.equal(table.code, BODY_CODES.NOMINAL_REQUIRED)
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

// ---------------------------------------------------------------------------
// move: within a note

const DEEP = `---
title: Deep
---

# Deep

## Two

### Three

#### Four

##### Five

Down here, [[other]].

## Tail

The tail, with [[fixture]].
`

const LISTY = `---
title: Listy
---

# Listy

## Items

- **first**: one, [[other]]
- **second**: two

After the list.
`

test('section:move after a sibling keeps depth, links and anchors, and reports both ends', (t) => {
  const box = wiki(NOTES)
  t.after(() => box.cleanup())
  const before = box.links('fixture.md')

  const report = body(box.root, {
    path: 'fixture.md',
    address: [{section: 'Fields'}],
    operation: 'move',
    destination: {address: [{section: {text: 'Notes', nth: 2}}], position: 'after'},
  })
  assert.equal(report.ok, true, 'the anchors are still in the note, so nothing dangles')
  assert.deepEqual(report.changed, ['fixture.md'])
  assert.equal(report.moved.from.note, 'fixture.md')
  assert.equal(report.moved.to.note, 'fixture.md')
  assert.equal(report.moved.from.target.text, 'Fields')
  assert.equal(report.moved.to.target.text, 'Notes')
  assert.equal(report.moved.to.position, 'after')
  assert.equal(report.moved.depth, 2)
  assert.match(report.removed, /^## Fields\n\nBefore the table/)
  assert.deepEqual(report.disagreements, [], 'nth 2 picked the second of the two "Notes"; no disagreement to report')

  const after = box.read('fixture.md')
  assert.match(after, /Intro, with a link to \[\[other\]\]\.\n\n## Notes\n\nFirst note/)
  assert.match(after, /Repeated heading, so its anchor is notes-1\.\n\n## Fields\n\nBefore the table, see \[\[other#its-heading\]\]\.\n\n\| Option/)
  assert.match(after, /### Nested\n\nNested prose with !\[\[embed\.png\]\]\.\n$/)
  assert.equal(box.links('fixture.md'), before)
})

test('section:move inside a section is a subsection, and beside one a sibling — the depth cascades either way', (t) => {
  const box = wiki(NOTES)
  t.after(() => box.cleanup())
  const before = box.links('fixture.md')

  const inward = body(box.root, {
    path: 'fixture.md',
    address: [{section: 'Fields'}],
    operation: 'move',
    destination: {address: [{section: {text: 'Notes', nth: 1}}], position: 'last'},
  })
  assert.ok(inward.notes.some((note) => /the moved section's headings were deepened by 1 to sit at depth 3/.test(note)))
  let after = box.read('fixture.md')
  assert.match(after, /```sh\nawt check\n```\n\n### Fields\n\nBefore the table/)
  assert.match(after, /#### Nested\n\nNested prose/)
  assert.match(after, /Nested prose with !\[\[embed\.png\]\]\.\n\n## Notes\n\nRepeated/)

  // Back out, and up: Nested alone, raised to a sibling of the top sections.
  // Fields left the root, so the first "Notes" is nth 0 among its siblings now.
  const outward = body(box.root, {
    path: 'fixture.md',
    address: [{section: {text: 'Notes', nth: 0}}, {section: 'Fields'}, {section: 'Nested'}],
    operation: 'move',
    destination: {address: [{section: {text: 'Notes', nth: 0}}], position: 'before'},
  })
  assert.ok(outward.notes.some((note) => /raised by 2 to sit at depth 2/.test(note)))
  after = box.read('fixture.md')
  assert.match(after, /Intro, with a link to \[\[other\]\]\.\n\n## Nested\n\nNested prose with !\[\[embed\.png\]\]\.\n\n## Notes\n\nFirst note/)
  assert.doesNotMatch(after, /#### Nested/)

  const first = body(box.root, {
    path: 'fixture.md',
    address: [{section: 'Nested'}],
    operation: 'move',
    destination: {address: [{section: 'Fixture'}], position: 'first'},
  })
  assert.equal(first.ok, true)
  after = box.read('fixture.md')
  assert.match(after, /# Fixture\n\n## Nested\n\nNested prose with !\[\[embed\.png\]\]\.\n\nIntro, with a link/)
  assert.equal(box.links('fixture.md'), before)
})

test('section:move refuses its own range as a destination, a heading that would pass depth 6, and a non-section destination', (t) => {
  const box = wiki({...NOTES, 'deep.md': DEEP})
  t.after(() => box.cleanup())
  const source = box.read('fixture.md')
  const at = (destination) => refusal(() => body(box.root, {path: 'fixture.md', address: [{section: 'Fields'}], operation: 'move', destination}))

  assert.equal(at({address: [{section: 'Fields'}, {section: 'Nested'}], position: 'first'}).code, BODY_CODES.INTO_ITSELF)
  assert.equal(at({address: [{section: 'Fields'}], position: 'last'}).code, BODY_CODES.INTO_ITSELF)

  // Fields would sit at 6 under Five, and Nested at 7.
  const deep = at({note: 'deep.md', address: [{section: 'Five'}], position: 'last'})
  assert.equal(deep.code, BODY_CODES.DEPTH_OUT_OF_RANGE)
  assert.equal(deep.heading, 'Nested')
  assert.equal(deep.wanted, 7)
  assert.equal(box.read('deep.md'), DEEP, 'refused before either tree moved')

  const prose = at({address: [{block: {prefix: 'Intro'}}], position: 'after'})
  assert.equal(prose.code, BODY_CODES.BAD_DESTINATION)
  assert.match(prose.notes[0], /a section moves to a section/)
  assert.equal(box.read('fixture.md'), source)
})

test('section:move onto its own edge changes nothing and says so', (t) => {
  const box = wiki(NOTES)
  t.after(() => box.cleanup())
  const report = body(box.root, {
    path: 'fixture.md',
    address: [{section: 'Fields'}],
    operation: 'move',
    destination: {address: [{section: 'Fields'}], position: 'after'},
  })
  assert.deepEqual(report.changed, [])
  assert.ok(report.notes.some((note) => /nothing written/.test(note)))
  assert.equal(box.read('fixture.md'), NOTE)
})

test('block:move lands before and after a block, first and last in a section, beside a table, with no fixup', (t) => {
  const box = wiki(NOTES)
  t.after(() => box.cleanup())
  const before = box.links('fixture.md')
  const move = (address, destination) => body(box.root, {path: 'fixture.md', address, operation: 'move', destination})

  const notes = {text: 'Notes', nth: 1}
  const swapped = move([{section: notes}, {block: {prefix: 'Second note'}}], {address: [{section: notes}, {block: {prefix: 'First note'}}], position: 'before'})
  assert.equal(swapped.ok, true)
  assert.equal(swapped.removed, 'Second note paragraph, linking [[#fields]].\n')
  assert.equal(swapped.moved.to.target.kind, 'block')
  assert.match(box.read('fixture.md'), /## Notes\n\nSecond note paragraph, linking \[\[#fields\]\]\.\n\nFirst note paragraph\.\n\n```sh/)

  move([{section: notes}, {block: {prefix: 'awt check'}}], {address: [{section: 'Fields'}], position: 'first'})
  assert.match(box.read('fixture.md'), /## Fields\n\n```sh\nawt check\n```\n\nBefore the table/)

  move([{block: {prefix: 'Intro'}}], {address: [{section: 'Fields'}, {table: {nth: 0}}], position: 'after'})
  assert.match(box.read('fixture.md'), /\| a {6}\| a seam {3}\|\n\nIntro, with a link to \[\[other\]\]\.\n\n### Nested/)

  move([{section: notes}, {block: {prefix: 'First note'}}], {address: [{section: 'Fields'}, {section: 'Nested'}], position: 'last'})
  assert.match(box.read('fixture.md'), /Nested prose with !\[\[embed\.png\]\]\.\n\nFirst note paragraph\.\n\n## Notes\n\nSecond note/)

  const after = box.read('fixture.md')
  assert.doesNotMatch(after, /# Fixture\n\nIntro/, 'the intro left the root')
  assert.equal(box.links('fixture.md'), before)
  assert.equal(after.match(/^#+ /gm).length, NOTE.match(/^#+ /gm).length, 'no heading moved or changed depth')
})

test('move needs the nominal half: a section its text, a block its prefix, a table its header, a list its prefix', (t) => {
  const box = wiki({...NOTES, 'listy.md': LISTY})
  t.after(() => box.cleanup())
  const to = {address: [{section: {text: 'Notes', nth: 1}}], position: 'last'}
  const blind = (path, address) => refusal(() => body(box.root, {path, address, operation: 'move', destination: to}))

  assert.equal(blind('fixture.md', [{section: {nth: 0}}]).code, BODY_CODES.NOMINAL_REQUIRED)
  assert.equal(blind('fixture.md', [{block: {nth: 0}}]).code, BODY_CODES.NOMINAL_REQUIRED)
  assert.equal(blind('fixture.md', [{section: 'Fields'}, {table: {nth: 0}}]).code, BODY_CODES.NOMINAL_REQUIRED)
  assert.equal(blind('listy.md', [{section: 'Items'}, {list: {nth: 0}}]).code, BODY_CODES.NOMINAL_REQUIRED)
  assert.equal(box.read('fixture.md'), NOTE)
})

test('table:move carries the table whole, by header, and a block after it in the report', (t) => {
  const box = wiki(NOTES)
  t.after(() => box.cleanup())
  const before = box.links('fixture.md')

  const report = body(box.root, {
    path: 'fixture.md',
    address: [{section: 'Fields'}, {table: {header: ['Option', 'Gives us'], nth: 0}}],
    operation: 'move',
    destination: {address: [{section: {text: 'Notes', nth: 1}}, {block: {prefix: 'First note'}}], position: 'after'},
  })
  assert.equal(report.ok, true)
  assert.equal(report.moved.from.target.kind, 'table')
  assert.deepEqual(report.moved.from.target.header, ['Option', 'Gives us'])
  assert.match(report.removed, /^\| Option \| Gives us \|\n/)

  const after = box.read('fixture.md')
  assert.match(after, /Before the table, see \[\[other#its-heading\]\]\.\n\n### Nested/)
  assert.match(after, /First note paragraph\.\n\n\| Option \| Gives us \|\n\|-+\|-+\|\n\| a {6}\| a seam {3}\|\n\nSecond note/)
  assert.equal(box.links('fixture.md'), before)
})

// `list` takes its `prefix` nominal from the table-and-list branch, where the
// resolver learns the field. This build demands it (above) and the resolver
// refuses it, so the move itself runs only once the two branches meet. The
// handler is the one `table` exercises: one node, no fixup. Verified once with
// a throwaway resolver shim before the skip went on.
test('list:move carries the list whole, by prefix, with no fixup', (t) => {
  const box = wiki({...NOTES, 'listy.md': LISTY})
  t.after(() => box.cleanup())
  const before = box.links('listy.md')

  const report = body(box.root, {
    path: 'listy.md',
    address: [{section: 'Items'}, {list: {prefix: 'first', nth: 0}}],
    operation: 'move',
    destination: {address: [{section: 'Items'}, {block: {prefix: 'After the list'}}], position: 'after'},
  })
  assert.equal(report.ok, true)
  assert.equal(report.moved.from.target.kind, 'list')
  assert.match(report.removed, /^- \*\*first\*\*: one, \[\[other\]\]\n- \*\*second\*\*: two\n$/)
  assert.match(box.read('listy.md'), /## Items\n\nAfter the list\.\n\n- \*\*first\*\*: one, \[\[other\]\]\n- \*\*second\*\*: two\n$/)
  assert.equal(box.links('listy.md'), before)
})

test('move refuses a missing, malformed or unknown destination, a wrong position, and a destination that does not resolve', (t) => {
  const box = wiki(NOTES)
  t.after(() => box.cleanup())
  const at = (destination) => refusal(() => body(box.root, {path: 'fixture.md', address: [{section: 'Fields'}], operation: 'move', destination}))

  assert.equal(at(undefined).code, BODY_CODES.BAD_DESTINATION)
  assert.equal(at({address: [{section: 'Notes'}], position: 'after', extra: 1}).code, BODY_CODES.BAD_DESTINATION)
  assert.equal(at({note: 'nope.md', address: [{section: 'Notes'}], position: 'after'}).code, BODY_CODES.BAD_DESTINATION)
  assert.equal(at({address: [{section: {text: 'Notes', nth: 1}}], position: 'middle'}).code, BODY_CODES.BAD_POSITION)
  assert.equal(at({address: [{section: {text: 'Notes', nth: 1}}]}).code, BODY_CODES.BAD_POSITION)
  const row = at({address: [{section: 'Fields'}, {table: {nth: 0}}, {row: {index: 0}}], position: 'after'})
  assert.equal(row.code, BODY_CODES.BAD_DESTINATION)
  assert.match(row.notes[0], /nothing moves to a row/)

  const ambiguous = at({address: [{section: 'Notes'}], position: 'after'})
  assert.equal(ambiguous.code, PATH_CODES.AMBIGUOUS)
  assert.equal(ambiguous.where, 'destination')
  assert.equal(ambiguous.candidates.length, 2)
  assert.equal(box.read('fixture.md'), NOTE)
})

// ---------------------------------------------------------------------------
// move: between notes

test('section:move into another note stages the copy first, rebases it, and reports the anchors left behind', (t) => {
  const box = wiki(NOTES)
  t.after(() => box.cleanup())
  const fixtureLinks = box.links('fixture.md')
  const otherLinks = box.links('other.md')

  const report = body(box.root, {
    path: 'fixture.md',
    address: [{section: 'Fields'}],
    operation: 'move',
    destination: {note: 'other.md', address: [{section: {text: 'Its heading', nth: 5}}], position: 'last'},
  })
  assert.deepEqual(report.changed, ['other.md', 'fixture.md'], 'the destination is staged before the source')
  assert.deepEqual(report.disagreements, [{segment: 0, type: 'section', field: 'nth', expected: 5, actual: 0, where: 'destination'}])
  assert.ok(report.notes.some((note) => /^destination segment 0: the section named was at nth 0, not 5/.test(note)))
  assert.equal(report.ok, false, 'links into the moved section dangle, and are reported rather than propagated')
  assert.equal(report.moved.from.note, 'fixture.md')
  assert.equal(report.moved.to.note, 'other.md')
  assert.equal(report.moved.depth, 3)
  assert.match(report.removed, /^## Fields\n/, 'what was removed, as the source held it')

  const fixture = box.read('fixture.md')
  assert.doesNotMatch(fixture, /Fields|Nested/)
  assert.match(fixture, /Intro, with a link to \[\[other\]\]\.\n\n## Notes/)
  const other = box.read('other.md')
  assert.match(other, /\[\[fixture#notes-1\]\]\.\n\n### Fields\n\nBefore the table, see \[\[other#its-heading\]\]\./)
  assert.match(other, /#### Nested\n\nNested prose with !\[\[embed\.png\]\]\.\n$/)
  assert.equal(box.links('fixture.md'), fixtureLinks - 2)
  assert.equal(box.links('other.md'), otherLinks + 2)
  assert.deepEqual(
    report.unresolved.map((entry) => [entry.from, entry.target]).sort(),
    [
      ['fixture.md', '#fields'],
      ['other.md', 'fixture#fields'],
      ['other.md', 'fixture#nested'],
    ],
  )
})

test('block:move into another note needs no fixup, and dryRun stages both without writing either', (t) => {
  const box = wiki(NOTES)
  t.after(() => box.cleanup())
  const call = (dryRun) =>
    body(box.root, {
      path: 'fixture.md',
      address: [{section: {text: 'Notes', nth: 1}}, {block: {prefix: 'Second note'}}],
      operation: 'move',
      destination: {note: 'other.md', address: [{section: 'Its heading'}, {block: {prefix: 'Points back'}}], position: 'before'},
      dryRun,
    })

  const dry = call(true)
  assert.equal(dry.dryRun, true)
  assert.deepEqual(dry.changed, ['other.md', 'fixture.md'])
  assert.equal(box.read('fixture.md'), NOTE)
  assert.equal(box.read('other.md'), OTHER)

  const wet = call(false)
  assert.equal(wet.ok, true)
  assert.doesNotMatch(box.read('fixture.md'), /Second note/)
  assert.match(box.read('other.md'), /## Its heading\n\nSecond note paragraph, linking \[\[#fields\]\]\.\n\nPoints back/)
  assert.equal(box.links('fixture.md') + box.links('other.md'), NOTE.match(/\[\[/g).length + OTHER.match(/\[\[/g).length)
})

test('a source that changes on disk after the copy landed is skipped, both notes hold it, and the re-run refuses the duplicate', (t) => {
  const box = wiki(NOTES)
  t.after(() => box.cleanup())
  const theirs = `${NOTE}\nSomeone else's paragraph.\n`

  // The concurrent writer, inside the read-to-commit window: the verb reads the
  // backlinks after it has staged the destination and before it commits.
  const index = loadWorkspace(box.root)
  const raced = {
    ...index,
    backlinks(path) {
      writeFileSync(join(box.root, 'fixture.md'), theirs)
      return index.backlinks(path)
    },
  }
  const move = (workspace) =>
    body(box.root, {
      path: 'fixture.md',
      address: [{section: 'Fields'}],
      operation: 'move',
      destination: {note: 'other.md', address: [{section: 'Its heading'}], position: 'last'},
      workspace,
    })

  const report = move(raced)
  assert.deepEqual(report.changed, ['other.md'])
  assert.deepEqual(report.skipped, [{path: 'fixture.md', reason: 'changed on disk since it was read'}])
  assert.ok(report.notes.some((note) => /both notes hold it/.test(note) && /deleting the source/.test(note)))
  assert.equal(box.read('fixture.md'), theirs, 'never overwritten')
  assert.match(box.read('other.md'), /### Fields\n\nBefore the table/)
  assert.match(report.removed, /^## Fields\n/, 'the report still says what the move meant to take')

  const again = refusal(() => move(undefined))
  assert.equal(again.code, BODY_CODES.ALREADY_AT_DESTINATION)
  assert.match(box.read('fixture.md'), /## Fields\n/, 'refused, so the source is still whole')
  assert.match(box.read('other.md'), /### Fields\n/)
  assert.equal((box.read('other.md').match(/Fields/g) ?? []).length, 1, 'and the destination has one copy, not two')

  // The remedy the refusal names.
  const finished = body(box.root, {path: 'fixture.md', address: [{section: 'Fields'}], operation: 'delete'})
  assert.deepEqual(finished.changed, ['fixture.md'])
  assert.doesNotMatch(box.read('fixture.md'), /## Fields/)
})
