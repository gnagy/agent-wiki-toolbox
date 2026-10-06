/**
 * `awt site publish --if-stale`: when a release is out of date, and the lock that keeps two triggers
 * from building into one release.
 *
 * The unit tests run against real temporary directories. The CLI tests stop short of Quartz on
 * purpose: a stale release reaches the point where the build would start, and the missing Quartz
 * install says so, which is the decision under test without a build behind it.
 */
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import test, {after} from 'node:test'

import {LOCK, LOCK_STALE_MS, builtAt, newestNote, staleness, takeLock} from '../lib/stale.js'

const AWT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'cli', 'bin', 'awt.mjs')
const RECORD = join('static', 'awtRelease.json')

const made = []
function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'awt-stale-'))
  made.push(dir)
  return dir
}
after(() => {
  for (const dir of made) rmSync(dir, {recursive: true, force: true})
})

function put(root, rel, body = '') {
  const p = join(root, rel)
  mkdirSync(dirname(p), {recursive: true})
  writeFileSync(p, body)
  return p
}

const at = (iso) => new Date(iso)

/** A wiki with one note modified at `noteAt`, and a release built at `builtIso`, or none. */
function project({noteAt, builtIso}) {
  const root = tmp()
  const note = put(root, 'wiki/notes/a.md', '# A\n')
  utimesSync(note, at(noteAt), at(noteAt))
  const out = join(root, 'wiki/site/build/published/default')
  if (builtIso) put(out, RECORD, JSON.stringify({version: 1, builtAt: builtIso}))
  mkdirSync(join(root, 'wiki/site/build'), {recursive: true})
  return {root, wiki: join(root, 'wiki/notes'), site: join(root, 'wiki/site'), out}
}

test('a wiki with no release for the target is unbuilt, however old its notes are', () => {
  const p = project({noteAt: '2026-01-01T00:00:00Z'})
  assert.equal(staleness({wiki: p.wiki, out: p.out, recordFile: RECORD}).state, 'unbuilt')
})

test('a release built after the newest note is fresh', () => {
  const p = project({noteAt: '2026-01-01T00:00:00Z', builtIso: '2026-02-01T00:00:00.000Z'})
  assert.equal(staleness({wiki: p.wiki, out: p.out, recordFile: RECORD}).state, 'fresh')
})

test('a note newer than the release makes it stale', () => {
  const p = project({noteAt: '2026-03-01T00:00:00Z', builtIso: '2026-02-01T00:00:00.000Z'})
  assert.equal(staleness({wiki: p.wiki, out: p.out, recordFile: RECORD}).state, 'stale')
})

test('a record that cannot be read is unbuilt rather than an error', () => {
  const p = project({noteAt: '2026-01-01T00:00:00Z'})
  put(p.out, RECORD, 'not json')
  assert.equal(builtAt(p.out, RECORD), null)
  put(p.out, RECORD, JSON.stringify({builtAt: 'yesterday-ish'}))
  assert.equal(builtAt(p.out, RECORD), null)
  assert.equal(staleness({wiki: p.wiki, out: p.out, recordFile: RECORD}).state, 'unbuilt')
})

test('only markdown notes count, and not hidden directories or node_modules', () => {
  const root = tmp()
  const old = put(root, 'notes/a.md')
  utimesSync(old, at('2026-01-01T00:00:00Z'), at('2026-01-01T00:00:00Z'))
  put(root, 'notes/b.txt')
  put(root, 'notes/.obsidian/c.md')
  put(root, 'notes/node_modules/d.md')
  assert.equal(newestNote(join(root, 'notes')), at('2026-01-01T00:00:00Z').getTime())
  assert.equal(newestNote(join(root, 'missing')), 0, 'no directory is no notes, not an error')
})

test('a second lock is refused while the first is held, and free once it is released', () => {
  const site = tmp()
  const first = takeLock(site)
  assert.equal(typeof first, 'function')
  assert.equal(takeLock(site), null)
  first()
  first() // releasing twice is harmless
  const again = takeLock(site)
  assert.equal(typeof again, 'function')
  again()
})

test('a lock older than the limit is taken over, and a younger one is not', () => {
  const site = tmp()
  mkdirSync(join(site, 'build', LOCK), {recursive: true})
  assert.equal(takeLock(site), null, 'a fresh lock holds')
  const old = new Date(Date.now() - LOCK_STALE_MS - 1000)
  utimesSync(join(site, 'build', LOCK), old, old)
  const taken = takeLock(site)
  assert.equal(typeof taken, 'function', 'a lock from a dead process does not hold forever')
  taken()
})

test('taking the lock makes build/ with the file that ignores it', () => {
  const site = tmp()
  const release = takeLock(site)
  assert.ok(existsSync(join(site, 'build', '.gitignore')))
  release()
})

// ---- through the command ----------------------------------------------------------------------------

/** A project `awt` finds by its config, with an empty machine config so the real one never answers. */
function cliProject({builtIso, noteAt = '2026-03-01T00:00:00Z'}) {
  const root = tmp()
  writeFileSync(join(root, 'awt.config.mjs'), "export default {site: {title: 'T', self: 't'}}\n")
  const note = put(root, 'wiki/notes/a.md', '---\ntitle: A\ntype: note\n---\n\n# A\n')
  utimesSync(note, at(noteAt), at(noteAt))
  mkdirSync(join(root, 'wiki/site'), {recursive: true})
  const out = join(root, 'wiki/site/build/published/x')
  if (builtIso) put(out, RECORD, JSON.stringify({version: 1, builtAt: builtIso}))
  return {root, out}
}

function publishIfStale(p, extra = []) {
  const config = tmp()
  const r = spawnSync(process.execPath, [AWT, 'site', 'publish', '--if-stale', ...extra], {
    cwd: p.root,
    encoding: 'utf8',
    env: {...process.env, AWT_CONFIG_DIR: config, AWT_TARGET: ''},
  })
  return {status: r.status, out: `${r.stdout}${r.stderr}`}
}

test('--if-stale does nothing, successfully, for a wiki that was never published', () => {
  const p = cliProject({})
  const r = publishIfStale(p)
  assert.equal(r.status, 0, r.out)
  assert.match(r.out, /no release yet/)
  assert.ok(!existsSync(join(p.root, 'wiki/site/build')), 'a skipped run writes nothing, not even the index')
})

test('--if-stale does nothing for a release that is up to date', () => {
  const p = cliProject({builtIso: '2026-04-01T00:00:00.000Z'})
  const r = publishIfStale(p, ['--out', p.out])
  assert.equal(r.status, 0, r.out)
  assert.match(r.out, /up to date/)
  assert.ok(!existsSync(join(p.root, 'wiki/site/build/awt-index.json')), 'no index emitted for a skipped run')
  assert.ok(!existsSync(join(p.root, 'wiki/site/build', LOCK)), 'the lock is not left behind')
})

test('--if-stale reaches the build for a stale release, and leaves no lock when the build refuses', () => {
  const p = cliProject({builtIso: '2026-02-01T00:00:00.000Z'})
  const r = publishIfStale(p, ['--out', p.out])
  assert.notEqual(r.status, 0, 'no Quartz install here, so the build stops')
  assert.match(r.out, /Quartz install is not set up/)
  assert.ok(!existsSync(join(p.root, 'wiki/site/build', LOCK)), 'the exit handler released the lock')
})

test('--if-stale is refused with the flags it contradicts', () => {
  const p = cliProject({})
  for (const flag of ['--watch', '--offline', '--nginx']) {
    const r = publishIfStale(p, [flag])
    assert.notEqual(r.status, 0, flag)
    assert.match(r.out, /do not go together/, flag)
  }
})
