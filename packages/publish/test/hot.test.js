/**
 * `awt site publish --watch`, against a stand-in for Quartz.
 *
 * The stand-in builds a "site" from one note into the directory it is given, prints the lines
 * Quartz prints, and on a change to the notes behaves as a file in its control directory says:
 * rebuild, fail the rebuild, or die. What is asserted is what is on disk in the release and
 * what the publisher said, because a reader of the release is who this is for.
 */
import assert from 'node:assert/strict'
import {appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test, {after} from 'node:test'

import {applyScheme, swap, RELEASE_RECORD} from '../lib/release.js'
import {check, classify, hotPublish, replaceRelease} from '../lib/hot.js'
import {resolveTarget} from '../lib/target.js'

const FAKE_QUARTZ = `
import fs from 'node:fs'
import path from 'node:path'
const arg = (flag) => process.argv[process.argv.indexOf(flag) + 1]
const notes = path.resolve(arg('-d'))
const out = path.resolve(arg('-o'))
const control = process.env.FAKE_CONTROL
const read = (name, fallback) => (fs.existsSync(path.join(control, name)) ? fs.readFileSync(path.join(control, name), 'utf8').trim() : fallback)
fs.appendFileSync(path.join(control, 'launches'), 'x')

if (read('startmode', 'ok') === 'fatal') {
  console.log('ERROR: Exiting Quartz due to a fatal error')
  process.exit(1)
}

const build = () => {
  fs.rmSync(out, {recursive: true, force: true})
  fs.mkdirSync(path.join(out, 'static'), {recursive: true})
  fs.writeFileSync(path.join(out, 'index.html'), '<p>' + fs.readFileSync(path.join(notes, 'a.md'), 'utf8').trim() + ' https://localhost:9/w/m/n</p>')
  fs.writeFileSync(path.join(out, 'static', 'contentIndex.json'), '{}')
}
build()
console.log('Done processing 1 files in 1s')

fs.watch(notes, {recursive: true}, () => {
  const mode = read('mode', 'ok')
  if (mode === 'die') process.exit(3)
  if (mode === 'fail') return console.error('Rebuild failed: boom')
  build()
  console.log('Done rebuilding in 5ms')
})
setInterval(() => {}, 1000)
`

const made = []
after(() => {
  for (const dir of made) rmSync(dir, {recursive: true, force: true})
})

const until = async (condition, what, ms = 8000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.fail(`timed out waiting for ${what}`)
}

test('a resident publish keeps the release current, survives a failed rebuild and a dead build, and stops clean', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'awt-hot-'))
  made.push(root)
  const quartz = join(root, 'quartz')
  const notes = join(root, 'notes')
  const control = join(root, 'control')
  const out = join(root, 'release')
  for (const dir of [join(quartz, 'quartz'), notes, control]) mkdirSync(dir, {recursive: true})
  writeFileSync(join(quartz, 'quartz', 'bootstrap-cli.mjs'), FAKE_QUARTZ)
  writeFileSync(join(notes, 'a.md'), 'one')
  process.env.FAKE_CONTROL = control
  t.after(() => delete process.env.FAKE_CONTROL)

  const said = []
  let reindexed = 0
  const target = resolveTarget({base: 'http://localhost:9/w', mount: 'm', name: 'n'}, {}, (message) => {
    throw new Error(message)
  })
  const running = hotPublish({
    quartz,
    wiki: notes,
    out,
    target,
    applyScheme,
    swap,
    recordPath: RELEASE_RECORD,
    say: (line) => said.push(line),
    reindex: () => reindexed++,
    command: process.execPath,
  })
  const release = () => (existsSync(join(out, 'index.html')) ? readFileSync(join(out, 'index.html'), 'utf8') : '')
  const launches = () => readFileSync(join(control, 'launches'), 'utf8').length
  const say = () => said.join('\n')
  const edit = (text) => appendFileSync(join(notes, 'a.md'), text)

  // Whatever happens, the publisher is stopped: a stand-in that outlives a failed test keeps the runner alive.
  try {
  // The first build publishes, with the target's scheme and a record of the address.
  await until(() => release().includes('one'), 'the first release')
  assert.match(release(), /http:\/\/localhost:9\/w\/m\/n/, 'the https:// Quartz wrote is the target\'s http://')
  assert.equal(JSON.parse(readFileSync(join(out, RELEASE_RECORD), 'utf8')).url, 'http://localhost:9/w/m/n')
  assert.match(say(), /published 1 pages/)

  // An edit reaches the release, and re-emits the index.
  edit(' two')
  await until(() => release().includes('two'), 'a rebuilt release')
  // The publisher's own watcher settles for a moment before it re-emits; the stand-in does not wait.
  await until(() => reindexed >= 1, 'the index to be re-emitted after a change')
  assert.match(say(), /republished 1 pages/)

  // A rebuild that fails leaves the release alone and starts the build over. The file system may
  // replay a change to the watcher of the build that replaced the failed one, so "at least once".
  writeFileSync(join(control, 'mode'), 'fail')
  edit(' three')
  await until(() => launches() >= 2, 'a restart after the failed rebuild')
  assert.match(say(), /the rebuild failed; the standing release is untouched\. Restarting the build from scratch/)
  await until(() => release().includes('three'), 'the restarted build to publish')

  // A build that dies leaves the release alone, and the next change starts it again.
  writeFileSync(join(control, 'mode'), 'die')
  edit(' four')
  await until(() => say().includes('the build ended (exit 3)'), 'the dead build to be noticed')
  assert.ok(!release().includes('four'), 'a build that died published nothing')
  writeFileSync(join(control, 'mode'), 'ok')
  edit(' five')
  await until(() => release().includes('five'), 'the next change to start the build again')
  assert.ok(launches() >= 3, 'the dead build was started again')

  } finally {
    // Stopping removes the work directories and leaves the last release standing.
    process.emit('SIGTERM')
  }
  assert.equal(await running, 0)
  assert.ok(existsSync(join(out, 'index.html')), 'the release outlives the publisher')
  assert.ok(!existsSync(join(root, '.release-work')) && !existsSync(join(root, '.release-next')))
  assert.match(say(), /stopped; the release at .* is the last one published/)
})

test('a build that dies before its first release is a failure, with what it said', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'awt-hot-'))
  made.push(root)
  const control = join(root, 'control')
  mkdirSync(join(root, 'quartz', 'quartz'), {recursive: true})
  mkdirSync(join(root, 'notes'), {recursive: true})
  mkdirSync(control, {recursive: true})
  writeFileSync(join(root, 'quartz', 'quartz', 'bootstrap-cli.mjs'), FAKE_QUARTZ)
  writeFileSync(join(control, 'startmode'), 'fatal')
  process.env.FAKE_CONTROL = control
  t.after(() => delete process.env.FAKE_CONTROL)

  const said = []
  const code = await hotPublish({
    quartz: join(root, 'quartz'),
    wiki: join(root, 'notes'),
    out: join(root, 'release'),
    target: null,
    applyScheme,
    swap,
    recordPath: RELEASE_RECORD,
    say: (line) => said.push(line),
    command: process.execPath,
  })
  assert.equal(code, 1)
  assert.match(said.join('\n'), /ended before it produced a release[\s\S]*fatal error/)
  assert.ok(!existsSync(join(root, 'release')), 'nothing was published')
})

test('what Quartz prints is read for the three things that matter, ANSI and all', () => {
  assert.equal(classify('\u001b[32mDone processing 238 files in 3s\u001b[0m'), 'built')
  assert.equal(classify('Done rebuilding in 506ms'), 'rebuilt')
  assert.equal(classify('Rebuild failed: awt: the two resolvers disagree'), 'failed')
  assert.equal(classify('Emitted 313 files to `../../public` in 506ms'), null)
})

test('a copy that is not a site is refused by throwing, and one that is, counted', () => {
  const root = mkdtempSync(join(tmpdir(), 'awt-hot-'))
  made.push(root)
  assert.throws(() => check(root), /no index\.html/)
  writeFileSync(join(root, 'index.html'), 'x')
  assert.throws(() => check(root), /no static\/contentIndex\.json/)
  mkdirSync(join(root, 'static'))
  writeFileSync(join(root, 'static', 'contentIndex.json'), '{}')
  assert.deepEqual(check(root), {pages: 1})
})

test('replacing a release keeps nothing of the last one, and works when none stood', () => {
  const root = mkdtempSync(join(tmpdir(), 'awt-hot-'))
  made.push(root)
  const out = join(root, 'release')
  const next = join(root, '.release-next')
  mkdirSync(next)
  writeFileSync(join(next, 'x'), '1')
  replaceRelease(next, out)
  assert.equal(readFileSync(join(out, 'x'), 'utf8'), '1')

  mkdirSync(next)
  writeFileSync(join(next, 'x'), '2')
  replaceRelease(next, out)
  assert.equal(readFileSync(join(out, 'x'), 'utf8'), '2')
  assert.deepEqual(
    [existsSync(next), existsSync(join(root, '.release-prev'))],
    [false, false],
    'the staging copy is gone and no previous release was kept by a rebuild',
  )
})
