/**
 * The cache is the one place a wrong answer can be delivered fast, so these tests
 * are about staleness rather than speed.
 */
import assert from 'node:assert/strict'
import {mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'

import {cachePathFor, loadWorkspace} from '../index.js'

/** Each test gets its own workspace *and* its own cache directory. */
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'awt-core-'))
  const root = join(dir, 'wiki')
  mkdirSync(root, {recursive: true})
  process.env.XDG_CACHE_HOME = join(dir, 'cache')
  return {
    root,
    write(path, source) {
      const full = join(root, path)
      mkdirSync(join(full, '..'), {recursive: true})
      writeFileSync(full, source)
      return full
    },
    cleanup() {
      rmSync(dir, {recursive: true, force: true})
    },
  }
}

test('a warm load reuses everything and parses nothing', (t) => {
  const box = sandbox()
  t.after(() => box.cleanup())
  box.write('one.md', '# One\n\nto [[two]]\n')
  box.write('two.md', '# Two\n')

  assert.equal(loadWorkspace(box.root).stats.parsed, 2)
  const warm = loadWorkspace(box.root)
  assert.equal(warm.stats.parsed, 0)
  assert.equal(warm.stats.reused, 2)
  assert.equal(warm.edges.length, 1)
})

test('an edit is picked up with nothing watching', (t) => {
  const box = sandbox()
  t.after(() => box.cleanup())
  box.write('one.md', '# One\n')
  box.write('two.md', '# Two\n')
  loadWorkspace(box.root)

  box.write('one.md', '# One\n\nnow links to [[two]]\n')
  const after = loadWorkspace(box.root)
  assert.equal(after.stats.parsed, 1)
  assert.equal(after.edges.length, 1)
})

test('a file touched but not changed is not reparsed', (t) => {
  const box = sandbox()
  t.after(() => box.cleanup())
  const path = box.write('one.md', '# One\n')
  loadWorkspace(box.root)

  const later = new Date(Date.now() + 10_000)
  utimesSync(path, later, later)
  const after = loadWorkspace(box.root)
  assert.equal(after.stats.parsed, 0, 'the hash is the tiebreak when mtime moves')
  assert.equal(after.stats.hashed, 1, 'and it is only read because mtime moved')

  // And the refreshed mtime is kept. Writing the cache only when something was
  // parsed left this file failing the `stat` fast path on every load, for good.
  const again = loadWorkspace(box.root)
  assert.equal(again.stats.hashed, 0, 'the new mtime was persisted, so stat is enough now')
  assert.equal(again.stats.reused, 1)
})

test('a deleted note leaves the index', (t) => {
  const box = sandbox()
  t.after(() => box.cleanup())
  box.write('one.md', '# One\n\nto [[two]]\n')
  box.write('two.md', '# Two\n')
  loadWorkspace(box.root)

  rmSync(join(box.root, 'two.md'))
  const after = loadWorkspace(box.root)
  assert.equal(after.resources.length, 1)
  assert.deepEqual(after.placeholders().map((p) => p.target), ['two'])
})

test('a corrupt cache is a cold start, not a failure', (t) => {
  const box = sandbox()
  t.after(() => box.cleanup())
  box.write('one.md', '# One\n')
  loadWorkspace(box.root)

  writeFileSync(cachePathFor(box.root), '{ this is not json')
  const after = loadWorkspace(box.root)
  assert.equal(after.stats.parsed, 1)
  assert.equal(after.resources.length, 1)
})

test('the cache never lands inside the wiki', (t) => {
  const box = sandbox()
  t.after(() => box.cleanup())
  box.write('one.md', '# One\n')
  loadWorkspace(box.root)
  assert.ok(!cachePathFor(box.root).startsWith(box.root), 'other projects own their own directories')
})

test('`cache: false` reparses and does not consult what is stored', (t) => {
  const box = sandbox()
  t.after(() => box.cleanup())
  box.write('one.md', '# One\n')
  loadWorkspace(box.root)
  assert.equal(loadWorkspace(box.root, {cache: false}).stats.parsed, 1)
})
