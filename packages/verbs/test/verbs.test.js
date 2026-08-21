/**
 * The verbs, against a real directory each time.
 *
 * The property under test throughout is **re-runnability**: decision 20 makes a
 * partial completion normal, so running a verb twice has to be safe and re-running
 * has to finish what a first run left.
 */
import assert from 'node:assert/strict'
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'

import {loadWorkspace} from '@agent-wiki-toolbox/core'

import {
  buildListing,
  createEdit,
  deleteNote,
  MARKER_END,
  MARKER_START,
  mergeFiles,
  moveNote,
  renameNote,
  renameTag,
  splitByHeading,
} from '../index.js'

function wiki(notes) {
  const dir = mkdtempSync(join(tmpdir(), 'awt-verbs-'))
  process.env.XDG_CACHE_HOME = join(dir, 'cache')
  const root = join(dir, 'wiki')
  mkdirSync(root, {recursive: true})

  const box = {
    root,
    dir,
    write(path, source) {
      mkdirSync(join(root, path, '..'), {recursive: true})
      writeFileSync(join(root, path), source)
    },
    read: (path) => readFileSync(join(root, path), 'utf8'),
    exists(path) {
      try {
        readFileSync(join(root, path))
        return true
      } catch {
        return false
      }
    },
    index: () => loadWorkspace(root, {cache: false}),
    cleanup: () => rmSync(dir, {recursive: true, force: true}),
  }
  for (const [path, source] of Object.entries(notes)) box.write(path, source)
  return box
}

const front = (title, extra = '') => `---\ntitle: ${title}\n${extra}---\n\n# ${title}\n\n`

test('moveNote rewrites every inbound link and moves the file', (t) => {
  const box = wiki({
    'design/old-name.md': `${front('Old name')}Body.\n`,
    'analysis/one.md': `${front('One')}See [[old-name]] and [[design/old-name]].\n`,
  })
  t.after(() => box.cleanup())

  const report = moveNote(box.root, {from: 'design/old-name.md', to: 'design/new-name.md'})

  assert.equal(report.ok, true)
  assert.deepEqual(report.created, ['design/new-name.md'])
  assert.deepEqual(report.changed, ['analysis/one.md'])
  assert.match(box.read('analysis/one.md'), /See \[\[new-name]] and \[\[new-name]]\./)
  assert.equal(box.exists('design/old-name.md'), false)
  assert.equal(box.index().placeholders().length, 0)
})

test('moveNote grows a folder segment when the bare stem would be ambiguous', (t) => {
  const box = wiki({
    'design/thing.md': `${front('Thing')}Body.\n`,
    'analysis/thing.md': `${front('Thing, analysed')}Body.\n`,
    'notes/one.md': `${front('One')}See [[design/thing]].\n`,
  })
  t.after(() => box.cleanup())

  moveNote(box.root, {from: 'design/thing.md', to: 'design/deep/thing.md'})
  assert.match(box.read('notes/one.md'), /\[\[deep\/thing]]/)
  assert.equal(box.index().ambiguities.length, 0)
})

test('moveNote is re-runnable: a half-done move finishes on the second run', (t) => {
  const box = wiki({
    'a/one.md': `${front('One')}Body.\n`,
    'b/two.md': `${front('Two')}See [[one]].\n`,
  })
  t.after(() => box.cleanup())

  // Simulate a run that moved the file and died before rewriting the link.
  box.write('a/moved.md', box.read('a/one.md'))
  rmSync(join(box.root, 'a/one.md'))

  const report = moveNote(box.root, {from: 'a/one.md', to: 'a/moved.md'})
  assert.equal(report.ok, true)
  assert.match(box.read('b/two.md'), /\[\[moved]]/)
  assert.match(report.notes.join(' '), /already at/)
})

/**
 * The read-to-write race decision 20 is about lives in the write path, so it is
 * tested there rather than through a verb: a verb loads and commits inside one
 * call, and interleaving a third party's write into that window from a test would
 * need a hook that exists only for the test.
 */
test('the write path skips a file that changed since it was read', (t) => {
  const box = wiki({'one.md': 'original\n', 'two.md': 'original\n'})
  t.after(() => box.cleanup())

  const edit = createEdit(box.root)
  edit.load('one.md')
  edit.load('two.md')
  edit.update('one.md', 'ours\n')
  edit.update('two.md', 'ours\n')

  // Another agent gets there first.
  box.write('one.md', 'theirs\n')

  const applied = edit.commit()
  assert.deepEqual(applied.changed, ['two.md'])
  assert.deepEqual(applied.skipped, [{path: 'one.md', reason: 'changed on disk since it was read'}])
  assert.equal(box.read('one.md'), 'theirs\n', 'never overwritten')
})

test('the write path skips a file that vanished since it was read', (t) => {
  const box = wiki({'one.md': 'original\n'})
  t.after(() => box.cleanup())

  const edit = createEdit(box.root)
  edit.update('one.md', 'ours\n')
  rmSync(join(box.root, 'one.md'))

  const applied = edit.commit()
  assert.deepEqual(applied.skipped, [{path: 'one.md', reason: 'gone'}])
})

/**
 * The verb-level half: a destination that appeared under us. The links are still
 * rewritten, so the verb finishes partially — which is the outcome decision 20
 * makes normal — and re-running completes it once the obstruction is gone.
 */
test('moveNote reports a partial completion, and a re-run finishes it', (t) => {
  const box = wiki({
    'a/one.md': `${front('One')}Body.\n`,
    'b/two.md': `${front('Two')}See [[one]].\n`,
  })
  t.after(() => box.cleanup())

  const stale = box.index()
  box.write('a/renamed.md', 'someone else got here first\n')

  const report = moveNote(box.root, {from: 'a/one.md', to: 'a/renamed.md', workspace: stale})
  assert.equal(report.ok, false)
  assert.deepEqual(report.skipped, [{path: 'a/one.md', reason: 'a/renamed.md already exists'}])
  assert.match(box.read('b/two.md'), /\[\[renamed]]/, 'the links were still rewritten')
  assert.equal(box.exists('a/one.md'), true, 'and the note was not moved onto theirs')

  rmSync(join(box.root, 'a/renamed.md'))
  const second = moveNote(box.root, {from: 'a/one.md', to: 'a/renamed.md'})
  assert.equal(second.ok, true)
  assert.deepEqual(second.created, ['a/renamed.md'])
})

test('renameNote refuses a path and takes a name', (t) => {
  const box = wiki({'design/old.md': `${front('Old')}Body.\n`})
  t.after(() => box.cleanup())

  assert.throws(() => renameNote(box.root, {path: 'design/old.md', name: 'other/new.md'}), /not a path/)
  const report = renameNote(box.root, {path: 'design/old.md', name: 'new.md'})
  assert.deepEqual(report.created, ['design/new.md'])
})

test('deleteNote reports what now points at nothing, and does not rewrite it', (t) => {
  const box = wiki({
    'a/gone.md': `${front('Gone')}Body.\n`,
    'b/one.md': `${front('One')}See [[gone]].\n`,
  })
  t.after(() => box.cleanup())

  const report = deleteNote(box.root, {path: 'a/gone.md'})
  assert.deepEqual(report.deleted, ['a/gone.md'])
  assert.equal(report.unresolved.length, 1)
  assert.equal(report.unresolved[0].from, 'b/one.md')
  // The link is left as a placeholder: that is the backlog signal, not a defect.
  assert.match(box.read('b/one.md'), /\[\[gone]]/)
  assert.deepEqual(box.index().placeholders().map((entry) => entry.target), ['gone'])

  const second = deleteNote(box.root, {path: 'a/gone.md'})
  assert.match(second.notes.join(' '), /already deleted/)
})

test('splitByHeading needs a plan and a decision about the source', (t) => {
  const box = wiki({'a/big.md': `${front('Big')}## One\n\nText.\n`})
  t.after(() => box.cleanup())

  assert.throws(() => splitByHeading(box.root, {path: 'a/big.md', source: 'delete'}), /explicit heading-to-path plan/)
  assert.throws(
    () => splitByHeading(box.root, {path: 'a/big.md', plan: [{heading: 'One', path: 'a/one.md'}]}),
    /delete, stub or keep/,
  )
})

test('splitByHeading extracts sections, derives front matter, and rewrites anchored links', (t) => {
  const box = wiki({
    'design/big.md': `${front('Big', 'type: note\ntopic: things\nstatus: draft\ntags: [a]\n')}Intro.\n\n## First part\n\nOne.\n\n### Deeper\n\nDeep.\n\n## Second part\n\nTwo.\n`,
    'analysis/ref.md': `${front('Ref')}See [[big#first-part]] and [[big#second-part]].\n`,
  })
  t.after(() => box.cleanup())

  const report = splitByHeading(box.root, {
    path: 'design/big.md',
    plan: [
      {heading: 'First part', path: 'design/first-part.md'},
      {heading: 'Second part', path: 'design/second-part.md'},
    ],
    source: 'stub',
  })

  assert.equal(report.ok, true)
  assert.deepEqual(report.created.sort(), ['design/first-part.md', 'design/second-part.md'])

  const first = box.read('design/first-part.md')
  assert.match(first, /^---\ntitle: First part\ntype: note\narea: design\ntopic: things\nstatus: draft\ntags:\n {2}- a\n---/)
  assert.match(first, /^# First part$/m)
  assert.match(first, /^## Deeper$/m, 'the section keeps its shape, one level shallower')

  // `description` is judgment and is left for the author, who is told so.
  assert.doesNotMatch(first, /^description:/m)
  assert.match(report.notes.join('\n'), /no description/)

  // An anchored inbound link names exactly one child.
  assert.match(box.read('analysis/ref.md'), /\[\[first-part]] and \[\[second-part]]/)
  assert.match(box.read('design/big.md'), /Split into:/)
  assert.equal(box.index().placeholders().length, 0)
})

test('splitByHeading refuses a basename already in the wiki, and writes nothing', (t) => {
  const box = wiki({
    'design/big.md': `${front('Big')}## Taken\n\nText.\n`,
    'analysis/taken.md': `${front('Taken')}Elsewhere.\n`,
  })
  t.after(() => box.cleanup())

  assert.throws(
    () =>
      splitByHeading(box.root, {
        path: 'design/big.md',
        plan: [{heading: 'Taken', path: 'design/taken.md'}],
        source: 'keep',
      }),
    /already in the wiki/,
  )
  assert.equal(box.exists('design/taken.md'), false)
})

test('splitByHeading escalates a bare link to a note it deleted', (t) => {
  const box = wiki({
    'design/big.md': `${front('Big')}## One\n\nText.\n`,
    'analysis/ref.md': `${front('Ref')}See [[big]].\n`,
  })
  t.after(() => box.cleanup())

  const report = splitByHeading(box.root, {
    path: 'design/big.md',
    plan: [{heading: 'One', path: 'design/one.md'}],
    source: 'delete',
  })

  assert.equal(report.ok, false)
  assert.equal(report.unresolved[0].from, 'analysis/ref.md')
  assert.deepEqual(report.unresolved[0].candidates, ['design/one.md'])
})

test('mergeFiles appends each source as a section and repoints its links', (t) => {
  const box = wiki({
    'design/target.md': `${front('Target')}Intro.\n`,
    'design/a.md': `${front('Alpha')}Alpha body.\n`,
    'design/b.md': `${front('Beta')}Beta body.\n`,
    'analysis/ref.md': `${front('Ref')}See [[a]] and [[b]].\n`,
  })
  t.after(() => box.cleanup())

  const report = mergeFiles(box.root, {
    sources: ['design/a.md', 'design/b.md'],
    into: 'design/target.md',
    source: 'delete',
  })

  assert.equal(report.ok, true)
  const target = box.read('design/target.md')
  assert.match(target, /^## Alpha$/m)
  assert.match(target, /Alpha body\./)
  assert.match(target, /^## Beta$/m)
  assert.match(box.read('analysis/ref.md'), /\[\[target#alpha]] and \[\[target#beta]]/)
  assert.equal(box.exists('design/a.md'), false)

  const second = mergeFiles(box.root, {
    sources: ['design/a.md', 'design/b.md'],
    into: 'design/target.md',
    source: 'delete',
  })
  assert.match(second.notes.join(' '), /already merged/)
  assert.equal(box.read('design/target.md'), target, 'a second run changes nothing')
})

test('renameTag rewrites front matter and merges a collision', (t) => {
  const box = wiki({
    'a.md': `${front('A', 'tags: [old, keep]\n')}Body.\n`,
    'b.md': `${front('B', 'tags: [old, new]\n')}Body.\n`,
    'c.md': `${front('C', 'tags: [other]\n')}Body.\n`,
  })
  t.after(() => box.cleanup())

  const report = renameTag(box.root, {from: 'old', to: 'new'})
  assert.equal(report.ok, true)
  assert.deepEqual(report.changed.sort(), ['a.md', 'b.md'])
  assert.match(box.read('a.md'), /tags:\n {2}- new\n {2}- keep/)
  assert.match(box.read('b.md'), /tags:\n {2}- new\n---/, 'a note carrying both ends up with one')

  const second = renameTag(box.root, {from: 'old', to: 'new'})
  assert.match(second.notes.join(' '), /no note carries/)
})

test('buildListing writes only between its markers', (t) => {
  const box = wiki({
    'index.md': `---\nokf_version: "0.2"\n---\n\n# Wiki\n\nCurated prose nobody generates.\n\n## Notes by area\n\n${MARKER_START}\n\nstale\n\n${MARKER_END}\n\n## Reading paths\n\nAlso curated.\n`,
    'analysis/one.md': `---\ntitle: One\narea: analysis\ntopic: things\ndescription: The first note.\n---\n\n# One\n`,
    'design/two.md': `---\ntitle: Two\narea: design\ntopic: things\ndescription: The second note.\n---\n\n# Two\n`,
  })
  t.after(() => box.cleanup())

  const report = buildListing(box.root)
  assert.equal(report.ok, true)

  const listing = box.read('index.md')
  assert.match(listing, /Curated prose nobody generates\./)
  assert.match(listing, /## Reading paths\n\nAlso curated\./)
  assert.match(listing, /### Analysis — how things are/)
  assert.match(listing, /\| \[\[one]] +\| things +\| The first note\. +\|/)
  assert.doesNotMatch(listing, /stale/)

  const second = buildListing(box.root)
  assert.match(second.notes.join(' '), /already current/)
  assert.equal(box.read('index.md'), listing)
})

test('buildListing refuses a file with no managed block', (t) => {
  const box = wiki({'index.md': '# Wiki\n\nNo markers here.\n'})
  t.after(() => box.cleanup())
  assert.throws(() => buildListing(box.root), /no managed block/)
})

test('buildListing names the notes with no description', (t) => {
  const box = wiki({
    'index.md': `# Wiki\n\n${MARKER_START}\n\n${MARKER_END}\n`,
    'analysis/one.md': `---\ntitle: One\narea: analysis\n---\n\n# One\n`,
  })
  t.after(() => box.cleanup())

  const report = buildListing(box.root, {columns: ['note', 'about']})
  assert.match(report.notes.join(' '), /no front-matter description/)
})
