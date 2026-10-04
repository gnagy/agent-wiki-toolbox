/**
 * `awt site serve` keeping the index current, at both ends.
 *
 * The failure this covers: the index was emitted once before the dev server
 * started, the first save made it older than the notes, and the plugin's
 * staleness check failed every rebuild from then on while the server went on
 * serving the page as it was. Two halves fix it, and each is tested against real
 * files: the watcher that re-emits, and the plugin that re-reads the index and,
 * under a following server, waits for it instead of throwing.
 *
 * The waiting half blocks its thread, so the index it waits for is written by a
 * child process — which is also the arrangement it has in use, where the writer
 * is `awt` and the reader is Quartz.
 */
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'

import {counts, followNotes, FOLLOWING} from '../lib/follow.js'

const load = async () => (await import(new URL('../../../quartz-plugins/awt/index.js', import.meta.url).pathname)).default

/** A notes directory beside a site directory, the layout a project has. */
function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'awt-follow-'))
  t.after(() => rmSync(root, {recursive: true, force: true}))
  const notes = join(root, 'notes')
  mkdirSync(join(notes, 'area'), {recursive: true})
  writeFileSync(join(notes, 'area', 'one.md'), '# One\n')
  return {notes, index: join(root, 'site', '.awt-index.json')}
}

function writeIndex(file, notesDir, pages = {}) {
  mkdirSync(join(file, '..'), {recursive: true})
  writeFileSync(file, JSON.stringify({version: 1, notesDir, slugs: Object.keys(pages), pages}))
}

/** Every mtime under `notes` at `seconds`, and the index at `indexSeconds`. */
function age({notes, index}, seconds, indexSeconds) {
  for (const path of [notes, join(notes, 'area'), join(notes, 'area', 'one.md')]) utimesSync(path, seconds, seconds)
  utimesSync(index, indexSeconds, indexSeconds)
}

const quietly = (t) => {
  const real = console.log
  console.log = () => {}
  t.after(() => {
    console.log = real
  })
}

const until = async (predicate, ms = 5000) => {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

// ------------------------------------------------------------------ the watcher

test('a change counts unless it is inside a dot-directory', () => {
  assert.equal(counts('area/one.md'), true)
  assert.equal(counts('area'), true)
  assert.equal(counts('image.png'), true)
  // Creating it moves area/'s mtime, which the plugin's check reads.
  assert.equal(counts('area/.one.md.swp'), true)
  assert.equal(counts('.obsidian/workspace.json'), false)
  assert.equal(counts('area/node_modules/x/readme.md'), false)
  // fs.watch may not say which file; assume it mattered.
  assert.equal(counts(''), true)
})

/**
 * Wait until the watcher has gone quiet: `emits` has not moved for two settle windows. fs.watch on macOS
 * reports events from just before it was started, and under file-system load it reports the writes of
 * one burst late and apart, so counting from a fixed delay after starting counts the wrong thing.
 */
const quiet = async (counter, settle) => {
  let seen = -1
  while (seen !== counter()) {
    seen = counter()
    await new Promise((resolve) => setTimeout(resolve, settle * 2))
  }
}

test('an edit re-emits, a burst re-emits once, and an edit during an emit re-emits after it', async (t) => {
  const {notes} = project(t)
  // Far longer than the file system takes to deliver the five writes of a burst, even loaded: a burst
  // whose events arrive further apart than this is, correctly, two bursts, and that is not what is tested.
  const settle = 200
  let emits = 0
  let hold = false
  let release = null
  const stop = followNotes(
    notes,
    () => {
      emits++
      // Whether this emit blocks is decided by the test, not by how many came before it: a replayed
      // event from before the watch started would otherwise move the count.
      if (hold) return new Promise((resolve) => (release = resolve))
    },
    {settle},
  )
  t.after(stop)
  await quiet(() => emits, settle)
  emits = 0

  for (let i = 0; i < 5; i++) writeFileSync(join(notes, 'area', 'one.md'), `# One ${i}\n`)
  await until(() => emits >= 1)
  await quiet(() => emits, settle)
  assert.equal(emits, 1, 'a burst of writes is one emit')

  hold = true
  writeFileSync(join(notes, 'area', 'two.md'), '# Two\n')
  await until(() => emits === 2)
  // Emit 2 is still running; this edit has to be covered by an emit that
  // starts after it, not folded into the one already reading the tree.
  writeFileSync(join(notes, 'area', 'two.md'), '# Two, again\n')
  await new Promise((resolve) => setTimeout(resolve, settle * 3))
  assert.equal(emits, 2, 'never two emits at once')
  hold = false
  release()
  await until(() => emits === 3)
})

test('an emit that throws is reported and the watch goes on', async (t) => {
  const {notes} = project(t)
  const reported = []
  let emits = 0
  const stop = followNotes(
    notes,
    () => {
      emits++
      throw new Error('bad note')
    },
    {settle: 20, report: (line) => reported.push(line)},
  )
  t.after(stop)
  await new Promise((resolve) => setTimeout(resolve, 200))
  emits = 0

  writeFileSync(join(notes, 'area', 'one.md'), '# One, edited\n')
  await until(() => emits >= 1)
  writeFileSync(join(notes, 'area', 'one.md'), '# One, edited again\n')
  await until(() => emits >= 2)
  assert.match(reported[0], /could not re-emit the index: bad note/)
})

// ------------------------------------------------------------------ the plugin

test('the plugin re-reads an index that changed under a running server', async (t) => {
  const paths = project(t)
  const page = (address) => ({path: 'area/one.md', address, links: [], unresolved: [], ambiguous: [], headings: []})
  writeIndex(paths.index, paths.notes, {'area/one': page('area/one')})
  age(paths, 1000, 2000)

  const plugin = (await load())({index: paths.index, shadow: false, headings: false})
  const moved = (slug) => {
    const file = {data: {slug}}
    plugin.markdownPlugins({})[0]()({type: 'root', children: []}, file)
    return file.data.slug
  }
  assert.equal(moved('area/one'), 'area/one')

  // Quartz keeps this instance for the whole dev server. The second index moves
  // the note; an instance that read the file once would never see that.
  writeIndex(paths.index, paths.notes, {'area/one': page('area/one/index')})
  age(paths, 1000, 3000)
  assert.equal(moved('area/one'), 'area/one/index')
})

test('outside a following server, a stale index still fails at once', async (t) => {
  quietly(t)
  delete process.env[FOLLOWING]
  const paths = project(t)
  writeIndex(paths.index, paths.notes)
  age(paths, 2000, 1000)

  const plugin = (await load())({index: paths.index, shadow: false, headings: false})
  const started = Date.now()
  await assert.rejects(plugin.emit({argv: {}}, []), /is older than the newest note/)
  assert.ok(Date.now() - started < 1000, 'it did not wait')
})

test('a deleted note makes the index stale, though no note got newer', async (t) => {
  quietly(t)
  delete process.env[FOLLOWING]
  const paths = project(t)
  writeFileSync(join(paths.notes, 'area', 'two.md'), '# Two\n')
  writeIndex(paths.index, paths.notes)
  age(paths, 1000, 2000)
  utimesSync(join(paths.notes, 'area', 'two.md'), 1000, 1000)

  const plugin = (await load())({index: paths.index, shadow: false, headings: false})
  await plugin.emit({argv: {}}, [])

  rmSync(join(paths.notes, 'area', 'two.md'))
  await assert.rejects(plugin.emit({argv: {}}, []), /is older than the newest note/)
})

test('under a following server, a stale index is waited for rather than refused', async (t) => {
  quietly(t)
  process.env[FOLLOWING] = '1'
  t.after(() => delete process.env[FOLLOWING])
  const paths = project(t)
  writeIndex(paths.index, paths.notes)
  age(paths, 2000, 1000)

  // The re-emit lands 400 ms later, from another process, as `awt` would.
  const writer = spawn(process.execPath, [
    '-e',
    `setTimeout(() => require('fs').utimesSync(${JSON.stringify(paths.index)}, 3000, 3000), 400)`,
  ])
  t.after(() => writer.kill())

  const plugin = (await load())({index: paths.index, shadow: false, headings: false})
  const started = Date.now()
  await plugin.emit({argv: {}}, [])
  assert.ok(Date.now() - started >= 300, 'it waited for the re-emit')
  assert.equal(statSync(paths.index).mtimeMs, 3000 * 1000)
})

test('under a following server, an index that never catches up fails with its own reason', async (t) => {
  quietly(t)
  process.env[FOLLOWING] = '1'
  t.after(() => delete process.env[FOLLOWING])
  const paths = project(t)
  writeIndex(paths.index, paths.notes)
  age(paths, 2000, 1000)

  const plugin = (await load())({index: paths.index, shadow: false, headings: false, followTimeoutMs: 200})
  await assert.rejects(plugin.emit({argv: {}}, []), /did not catch up with the notes .* within 0.2s/)
})

test('a page whose note changed after Quartz read it is set aside, not failed', async (t) => {
  delete process.env[FOLLOWING]
  const warned = []
  const real = console.warn
  console.warn = (line) => warned.push(line)
  t.after(() => {
    console.warn = real
  })
  quietly(t)
  const paths = project(t)
  // The index has the note linking somewhere; the page Quartz rendered does not,
  // because it read the note before the link was written.
  const page = {path: 'area/one.md', address: 'area/one', links: ['area/two'], unresolved: [], ambiguous: [], headings: []}
  writeIndex(paths.index, paths.notes, {'area/one': page})
  age(paths, 2000, 3000)
  const rendered = (readAt) => [[{type: 'root', children: []}, {data: {slug: 'area/one', awtReadAt: readAt}}]]

  const plugin = (await load())({index: paths.index, headings: false})
  await plugin.emit({argv: {}}, rendered(1000 * 1000))
  assert.match(warned.join('\n'), /not compared, changed after Quartz read them: area\/one/)

  // Read after its last change, the same page is compared, and disagrees.
  await assert.rejects(plugin.emit({argv: {}}, rendered(2500 * 1000)), /disagree on 1 of 1 pages/)
})
