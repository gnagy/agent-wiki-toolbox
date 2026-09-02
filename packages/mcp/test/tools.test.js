import assert from 'node:assert/strict'
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'

import {loadWorkspace} from '@agent-wiki-toolbox/core'

import {connections, createServer, resolve, search} from '../index.js'

function wiki(notes) {
  const dir = mkdtempSync(join(tmpdir(), 'awt-mcp-'))
  process.env.XDG_CACHE_HOME = join(dir, 'cache')
  const root = join(dir, 'wiki')
  mkdirSync(root, {recursive: true})
  for (const [path, source] of Object.entries(notes)) {
    mkdirSync(join(root, path, '..'), {recursive: true})
    writeFileSync(join(root, path), source)
  }
  return {root, index: () => loadWorkspace(root, {cache: false}), cleanup: () => rmSync(dir, {recursive: true, force: true})}
}

const NOTES = {
  'index.md': '# Wiki\n\nStart at [[conventions]].\n',
  'meta/conventions.md': '---\ntitle: Conventions\ntype: note\narea: meta\ntags: [conventions, linking]\n---\n\n# Conventions\n\n## Naming\n\nUnique basenames, always.\n',
  'design/shape.md': '---\ntitle: Shape\ntype: adr\narea: design\ntags: [linking]\ndescription: How it is shaped.\n---\n\n# Shape\n\nSee [[conventions#naming]] and [[missing-note]].\n',
  'design/other.md': '---\ntitle: Other\narea: design\n---\n\n# Other\n\nSee [[shape]] and [scope](vsf:meta/scope.md).\n',
}

test('search reads note bodies, which is the whole reason it exists', (t) => {
  const box = wiki(NOTES)
  t.after(() => box.cleanup())

  const found = search(box.index(), {query: 'Unique basenames'})
  assert.equal(found.total, 1)
  assert.equal(found.results[0].path, 'meta/conventions.md')
  assert.equal(found.results[0].matches[0].field, 'text')
  assert.equal(found.results[0].matches[0].line, 12)
})

test('search takes a regex, and filters by tag, type and area', (t) => {
  const box = wiki(NOTES)
  t.after(() => box.cleanup())
  const index = box.index()

  assert.equal(search(index, {query: '/basename?s/'}).total, 1)
  assert.deepEqual(search(index, {tag: 'linking'}).results.map((r) => r.path).sort(), [
    'design/shape.md',
    'meta/conventions.md',
  ])
  assert.deepEqual(search(index, {type: 'adr'}).results.map((r) => r.path), ['design/shape.md'])
  assert.deepEqual(search(index, {area: 'meta'}).results.map((r) => r.path), ['meta/conventions.md'])
})

test('connections answers what cites this, and how far it reaches', (t) => {
  const box = wiki(NOTES)
  t.after(() => box.cleanup())

  const one = connections(box.index(), {path: 'meta/conventions.md', depth: 2})
  assert.deepEqual(one.backlinks.map((entry) => entry.path).sort(), ['design/shape.md', 'index.md'])
  assert.deepEqual(one.reached.map((entry) => entry.path).sort(), [
    'design/other.md',
    'design/shape.md',
    'index.md',
  ])
})

test('resolve explains an ambiguous stem instead of guessing', (t) => {
  const box = wiki({...NOTES, 'analysis/shape.md': '# Shape, elsewhere\n'})
  t.after(() => box.cleanup())

  const outcome = resolve(box.index(), {target: 'shape'})
  assert.equal(outcome.status, 'ambiguous')
  assert.deepEqual(outcome.candidates, ['analysis/shape.md', 'design/shape.md'])
  assert.match(outcome.note, /error, not a guess/)
})

test('resolve checks the anchor against the target\'s real headings', (t) => {
  const box = wiki(NOTES)
  t.after(() => box.cleanup())
  const index = box.index()

  assert.deepEqual(resolve(index, {target: 'conventions#naming'}).anchor, {name: 'naming', status: 'ok'})
  assert.equal(resolve(index, {target: 'conventions#nope'}).anchor.status, 'missing')
})

test('resolve names a placeholder as a note worth writing, not an error', (t) => {
  const box = wiki(NOTES)
  t.after(() => box.cleanup())
  const outcome = resolve(box.index(), {target: 'missing-note'})
  assert.equal(outcome.status, 'placeholder')
  assert.match(outcome.note, /worth writing/)
})

test('resolve recognises a cross-wiki reference as not ours', (t) => {
  const box = wiki(NOTES)
  t.after(() => box.cleanup())
  const outcome = resolve(box.index(), {target: 'vsf:meta/scope.md#naming'})
  assert.equal(outcome.status, 'crossWiki')
  assert.equal(outcome.prefix, 'vsf')
  assert.equal(outcome.anchor, 'naming')
})

/**
 * Every write verb takes `--dry-run` on the CLI. A zod schema strips a key it does
 * not declare, so a tool missing it is not a tool an agent can preview a bulk
 * rewrite with — it is one that silently performs it.
 */
test('every write tool exposes dryRun', (t) => {
  const box = wiki(NOTES)
  t.after(() => box.cleanup())

  const tools = createServer({notesDir: box.root, allowWrites: true})._registeredTools
  const writes = ['rename', 'move', 'delete', 'split_by_heading', 'merge_files', 'rename_tag', 'build_listing']

  for (const name of writes) {
    const keys = Object.keys(tools[name].inputSchema?.shape ?? {})
    assert.ok(keys.includes('dryRun'), `${name} does not take dryRun`)
  }
  // And a read-only tool does not pretend to: there is nothing to preview.
  assert.ok(!Object.keys(tools.search.inputSchema?.shape ?? {}).includes('dryRun'))
})
