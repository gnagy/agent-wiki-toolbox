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

import {check, loadWorkspace} from '@agent-wiki-toolbox/core'

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

/**
 * Every verb that writes a wikilink names the note by the shortest form that
 * **resolves** to it, not by the shortest suffix no other slug shares. The two
 * come apart on a note named after its own folder: `design/toolbox/toolbox.md`
 * has the slug `design/toolbox/index`, whose unique suffix `toolbox/index` the
 * resolver reads as the folder `toolbox` and does not find. All three verbs wrote
 * that dead form — and a dead wikilink is a placeholder, which `check` calls
 * healthy, so nothing downstream said a word.
 */
test('moveNote names a note that lands on its own folder in a form that resolves', (t) => {
  const box = wiki({
    'index.md': `${front('Wiki')}Root.\n`,
    'design/thing.md': `${front('Thing')}Body.\n`,
    'notes/one.md': `${front('One')}See [[thing]].\n`,
  })
  t.after(() => box.cleanup())

  moveNote(box.root, {from: 'design/thing.md', to: 'design/toolbox/toolbox.md'})

  const index = box.index()
  assert.match(box.read('notes/one.md'), /\[\[design\/toolbox\/index]]/)
  assert.equal(index.resolve('design/toolbox/index').status, 'resolved')
  // The tell that the old form was wrong: it resolved to nothing, and a link to
  // nothing is a placeholder rather than an error.
  assert.equal(index.resolve('toolbox/index').status, 'placeholder')
  assert.deepEqual(index.placeholders(), [])
})

test('splitByHeading names its children in a form that resolves', (t) => {
  const box = wiki({
    'index.md': `${front('Wiki')}Root.\n`,
    'design/parent.md': `${front('Parent')}## Toolbox\n\nThe toolbox section.\n`,
  })
  t.after(() => box.cleanup())

  splitByHeading(box.root, {
    path: 'design/parent.md',
    plan: [{heading: 'Toolbox', path: 'design/toolbox/toolbox.md'}],
    source: 'stub',
  })

  const index = box.index()
  assert.match(box.read('design/parent.md'), /\[\[design\/toolbox\/index]]/)
  assert.equal(index.resolve('design/toolbox/index').status, 'resolved')
  assert.deepEqual(index.placeholders(), [])
})

test('mergeFiles names its target in a form that resolves', (t) => {
  const box = wiki({
    'index.md': `${front('Wiki')}Root.\n`,
    'design/toolbox/toolbox.md': `${front('Toolbox')}Body.\n`,
    'design/source.md': `${front('Source')}Body.\n`,
    'notes/one.md': `${front('One')}See [[source]].\n`,
  })
  t.after(() => box.cleanup())

  mergeFiles(box.root, {sources: ['design/source.md'], into: 'design/toolbox/toolbox.md', source: 'delete'})

  const index = box.index()
  assert.match(box.read('notes/one.md'), /\[\[design\/toolbox\/index#source]]/)
  assert.deepEqual(index.placeholders(), [])
})

/**
 * `move` and `splitByHeading` both place a note under a name the caller chose, so
 * both have to answer one question the same way: **would this edit make a bare
 * `[[stem]]` match two notes?** They used to answer differently, and both by
 * comparing the last segment of a slug — a string question that is not the
 * resolution question. `move` warned and carried on where `splitByHeading` refused
 * outright, and a note named after its own folder tripped both, because its slug
 * ends `/index` and every wiki's root note is called `index`.
 */
test('a name that would become ambiguous is refused, by move and split alike', (t) => {
  const notes = {
    'index.md': `${front('Wiki')}Root.\n`,
    'analysis/thing.md': `${front('Thing')}Body.\n`,
    'design/other.md': `${front('Other')}Body.\n`,
    'notes/one.md': `${front('One')}See [[thing]].\n`,
  }

  const moving = wiki(notes)
  t.after(() => moving.cleanup())
  assert.throws(
    () => moveNote(moving.root, {from: 'design/other.md', to: 'design/thing.md'}),
    /already in the wiki/,
  )
  // Refused rather than reported because of whose links break: `[[thing]]` in
  // notes/one.md is not a link this move rewrites.
  assert.equal(moving.exists('design/thing.md'), false)
  assert.equal(moving.exists('design/other.md'), true)
  assert.match(moving.read('notes/one.md'), /\[\[thing]]/)

  const splitting = wiki(notes)
  t.after(() => splitting.cleanup())
  assert.throws(
    () =>
      splitByHeading(splitting.root, {
        path: 'design/other.md',
        plan: [{heading: 'Other', path: 'design/thing.md'}],
        source: 'keep',
      }),
    /already in the wiki/,
  )
  assert.equal(splitting.exists('design/thing.md'), false)
})

test('an ambiguity that was already there is not the verb\'s doing, and does not refuse it', (t) => {
  const box = wiki({
    'design/thing.md': `${front('Thing')}Body.\n`,
    'analysis/thing.md': `${front('Thing, analysed')}Body.\n`,
    'notes/one.md': `${front('One')}See [[design/thing]].\n`,
  })
  t.after(() => box.cleanup())

  const report = moveNote(box.root, {from: 'design/thing.md', to: 'design/deep/thing.md'})

  assert.equal(report.ok, true)
  assert.match(report.notes.join(' '), /already matched more than one note/)
  assert.match(box.read('notes/one.md'), /\[\[deep\/thing]]/)
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

test('moveNote rebases the moved note\'s own relative links on its new folder', (t) => {
  const box = wiki({
    'a/mover.md': `${front('Mover')}A relative link to [the other](../b/other.md).\n`,
    'b/other.md': `${front('Other')}Body.\n`,
  })
  t.after(() => box.cleanup())

  const report = moveNote(box.root, {from: 'a/mover.md', to: 'b/deep/mover.md'})

  assert.equal(report.ok, true)
  assert.match(box.read('b/deep/mover.md'), /\[the other]\(\.\.\/other\.md\)/)
  assert.deepEqual(check(box.index()).problems, [])
})

test('moveNote lands a note that both moved and was rewritten, with both', (t) => {
  const box = wiki({
    'a/mover.md': `${front('Mover')}A long-form self link: [itself](../a/mover.md).\n`,
    'b/other.md': `${front('Other')}Body.\n`,
  })
  t.after(() => box.cleanup())

  const report = moveNote(box.root, {from: 'a/mover.md', to: 'b/mover.md'})

  // The rewrite and the move are one operation on one path: staging them as two
  // used to drop the rewrite and move the stale bytes.
  assert.equal(report.ok, true)
  assert.deepEqual(report.changed, ['b/mover.md'])
  assert.match(box.read('b/mover.md'), /\[itself]\(\.\/mover\.md\)/)
  assert.deepEqual(check(box.index()).problems, [])
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

  // One message for every refused destination, showing the accepted form.
  assert.throws(() => renameNote(box.root, {path: 'design/old.md', name: 'other/new.md'}), /<new-basename\.md>/)
  assert.throws(() => renameNote(box.root, {path: 'design/old.md', name: 'new'}), /<new-basename\.md>/)
  assert.throws(() => renameNote(box.root, {path: 'design/old.md', name: undefined}), /<new-basename\.md>/)
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

  // A second delete refuses. The verb cannot tell a re-run from a typo, and it
  // used to answer `ok` for a path the wiki had never held at all.
  assert.throws(() => deleteNote(box.root, {path: 'a/gone.md'}), /no note at/)
  assert.throws(() => deleteNote(box.root, {path: 'a/never-existed.md'}), /no note at/)
})

test('deleteNote takes the path as the shell shows it, and refuses one outside the wiki', (t) => {
  const box = wiki({
    'a/gone.md': `${front('Gone')}Body.\n`,
    'b/one.md': `${front('One')}See [[gone]].\n`,
  })
  t.after(() => box.cleanup())

  // The path a caller reads off `git status`, not the notes-relative one. Before
  // this, a note that was there was reported as already deleted.
  const report = deleteNote(box.root, {path: join(box.root, 'a/gone.md')})
  assert.deepEqual(report.deleted, ['a/gone.md'])
  assert.equal(report.unresolved.length, 1)
  assert.match(report.notes.join(' '), /relative to the notes directory/)

  // A path this wiki never held is a refusal, not a success.
  assert.throws(() => deleteNote(box.root, {path: '../elsewhere.md'}), /is not a note in/)
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

test('mergeFiles takes the paths as the shell shows them, and refuses one outside the wiki', (t) => {
  const box = wiki({
    'design/target.md': `${front('Target')}Intro.\n`,
    'design/a.md': `${front('Alpha')}Alpha body.\n`,
  })
  t.after(() => box.cleanup())

  // Before this, a source given this way was reported as already merged, and the
  // target as missing.
  const report = mergeFiles(box.root, {
    sources: [join(box.root, 'design/a.md')],
    into: join(box.root, 'design/target.md'),
    source: 'delete',
  })
  assert.equal(report.ok, true)
  assert.match(box.read('design/target.md'), /^## Alpha$/m)
  assert.match(report.notes.join(' '), /relative to the notes directory/)

  // A path this wiki never held is a refusal, not a skip.
  assert.throws(
    () => mergeFiles(box.root, {sources: ['../elsewhere.md'], into: 'design/target.md', source: 'keep'}),
    /not a note in/,
  )
})

test('mergeFiles repoints a relative markdown link into a source it deleted', (t) => {
  const box = wiki({
    'design/target.md': `${front('Target')}Body.\n`,
    'design/source.md': `${front('Source')}Body.\n`,
    'analysis/one.md': `${front('One')}See [the source](../design/source.md).\n`,
  })
  t.after(() => box.cleanup())

  const report = mergeFiles(box.root, {sources: ['design/source.md'], into: 'design/target.md', source: 'delete'})

  assert.equal(report.ok, true)
  assert.match(box.read('analysis/one.md'), /\[the source]\(\.\.\/design\/target\.md#source\)/)
  assert.deepEqual(check(box.index()).problems, [])
})

test('mergeFiles follows an anchor whose slug the target had already taken', (t) => {
  const box = wiki({
    // The target already has a "Detail" heading, so it keeps `#detail` and the
    // source's becomes `#detail-1`. A link that named the source's has to follow
    // the text rather than land on the target's own section.
    'design/target.md': `${front('Target')}## Detail\n\nThe target's.\n`,
    'design/source.md': `${front('Source')}## Detail\n\nThe source's.\n`,
    'analysis/one.md': `${front('One')}See [it](../design/source.md#detail) and [[source#detail]].\n`,
  })
  t.after(() => box.cleanup())

  const report = mergeFiles(box.root, {sources: ['design/source.md'], into: 'design/target.md', source: 'delete'})

  assert.equal(report.ok, true)
  assert.match(box.read('analysis/one.md'), /\[it]\(\.\.\/design\/target\.md#detail-1\)/)
  assert.match(box.read('analysis/one.md'), /\[\[target#detail-1]]/)
  assert.deepEqual(check(box.index()).problems, [])
})

test('mergeFiles reports an anchor the source never had', (t) => {
  const box = wiki({
    'design/target.md': `${front('Target')}Body.\n`,
    'design/source.md': `${front('Source')}Body.\n`,
    'analysis/one.md': `${front('One')}See [it](../design/source.md#nowhere).\n`,
  })
  t.after(() => box.cleanup())

  const report = mergeFiles(box.root, {sources: ['design/source.md'], into: 'design/target.md', source: 'delete'})

  // `deleteNote` reports what it left broken; so does this, for the same situation.
  assert.equal(report.ok, false)
  assert.equal(report.unresolved.length, 1)
  assert.equal(report.unresolved[0].from, 'analysis/one.md')
  assert.match(report.unresolved[0].reason, /no heading "#nowhere"/)
})

test('renameTag rewrites front matter and merges a collision', (t) => {
  const box = wiki({
    'a.md': `${front('A', 'tags: [old, keep]\n')}Body.\n`,
    'b.md': `${front('B', 'tags: [old, new]\n')}Body.\n`,
    'c.md': `${front('C', 'tags: [other]\n')}Body.\n`,
    'd.md': `${front('D', 'tags:\n  - old\n  - keep\n')}Body.\n`,
  })
  t.after(() => box.cleanup())

  const report = renameTag(box.root, {from: 'old', to: 'new'})
  assert.equal(report.ok, true)
  assert.deepEqual(report.changed.sort(), ['a.md', 'b.md', 'd.md'])
  // The style the author wrote survives, in both directions: renaming one tag is
  // not permission to reformat the block around it.
  assert.match(box.read('a.md'), /tags: \[new, keep]/)
  assert.match(box.read('b.md'), /tags: \[new]/, 'a note carrying both ends up with one')
  assert.match(box.read('d.md'), /tags:\n {2}- new\n {2}- keep/)

  const second = renameTag(box.root, {from: 'old', to: 'new'})
  assert.match(second.notes.join(' '), /no note carries/)
})

test('renameTag keeps a comment in the front matter it edits', (t) => {
  const box = wiki({'a.md': `---\ntitle: A\n# still being written\ntags: [old, keep]\n---\n\n# A\n`})
  t.after(() => box.cleanup())

  renameTag(box.root, {from: 'old', to: 'new'})
  assert.match(box.read('a.md'), /# still being written\ntags: \[new, keep]/)
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
  // A heading is the folder name, nothing added.
  assert.match(listing, /### analysis\n/)
  assert.match(listing, /### design\n/)
  assert.doesNotMatch(listing, /how things are|what we will do/)
  // Two columns by default; topic is opt-in.
  assert.match(listing, /\| Note +\| About +\|\n/)
  assert.match(listing, /\| \[\[one]] +\| The first note\. +\|/)
  assert.doesNotMatch(listing, /things/)
  assert.doesNotMatch(listing, /stale/)

  const second = buildListing(box.root)
  assert.match(second.notes.join(' '), /already current/)
  assert.equal(box.read('index.md'), listing)
})

test('buildListing renders a topic column when asked for one', (t) => {
  const box = wiki({
    'index.md': `# Index\n\n${MARKER_START}\n${MARKER_END}\n`,
    'design/one.md': front('One', 'topic: things\ndescription: The first note.\n'),
  })
  t.after(() => box.cleanup())

  buildListing(box.root, {columns: ['note', 'topic', 'about']})
  const listing = box.read('index.md')
  assert.match(listing, /\| Note +\| Topic +\| About +\|\n/)
  assert.match(listing, /\| \[\[one]] +\| things +\| The first note\. +\|/)
})

test('buildListing renders an area column as the area, headed like the others', (t) => {
  const box = wiki({
    'index.md': `# Index\n\n${MARKER_START}\n${MARKER_END}\n`,
    'design/one.md': front('One', 'description: The first note.\n'),
  })
  t.after(() => box.cleanup())

  buildListing(box.root, {columns: ['note', 'area', 'about']})
  const listing = box.read('index.md')
  assert.match(listing, /\| Note +\| Area +\| About +\|\n/)
  assert.match(listing, /\| \[\[one]] +\| design +\| The first note\. +\|/)
})

test('buildListing skips the OKF reserved files at the root instead of listing a blank row', (t) => {
  const box = wiki({
    'index.md': `# Index\n\n${MARKER_START}\n${MARKER_END}\n`,
    'log.md': '# Log\n\n## 2026-09-05\n\nSomething.\n',
    'design/one.md': front('One', 'description: The first note.\n'),
  })
  t.after(() => box.cleanup())

  const report = buildListing(box.root)
  const listing = box.read('index.md')
  assert.doesNotMatch(listing, /log/)
  assert.doesNotMatch(report.notes.join(' '), /log\.md/)
  assert.match(listing, /\[\[one]]/)
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

test('buildListing names each note the shortest way that resolves to it', (t) => {
  const box = wiki({
    'index.md': `# Index\n\n${MARKER_START}\n${MARKER_END}\n`,
    'design/notes.md': front('Notes', 'description: the design one\n'),
    'analysis/notes.md': front('Notes', 'description: the analysis one\n'),
    'design/solo.md': front('Solo', 'description: the only one of its name\n'),
  })
  t.after(() => box.cleanup())

  const report = buildListing(box.root)

  assert.equal(report.ok, true)
  const listing = box.read('index.md')
  assert.match(listing, /\[\[design\/notes]]/)
  assert.match(listing, /\[\[analysis\/notes]]/)
  // The unique basename still gets the short form: a folder segment is what the
  // duplicate needs, not what every row gets.
  assert.match(listing, /\[\[solo]]/)
  // The point of the whole exercise: the block this verb generated passes check.
  assert.deepEqual(check(box.index()).problems, [])
})

test('buildListing escapes a pipe in a topic as well as in a description', (t) => {
  const box = wiki({
    'index.md': `# Index\n\n${MARKER_START}\n${MARKER_END}\n`,
    'design/one.md': front('One', 'description: a | b\ntopic: c | d\n'),
  })
  t.after(() => box.cleanup())

  buildListing(box.root, {columns: ['note', 'topic', 'about']})
  const row = box.read('index.md').split('\n').find((line) => line.includes('[[one]]'))
  // Only the cell walls are unescaped pipes: three cells, not five.
  assert.equal(row.split(/(?<!\\)\|/).length, 5)
  assert.match(row, /c \\\| d/)
})
