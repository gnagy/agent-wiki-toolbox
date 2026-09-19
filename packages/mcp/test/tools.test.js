import assert from 'node:assert/strict'
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
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

/**
 * The area is what `area:` says. It used to fall back to the top folder, so in a
 * nested layout every note without an `area` matched `projects`, and a note in
 * `meta/` without one matched `meta` although nothing said so.
 */
test('search filters by the area front matter declares, not by folder', (t) => {
  const box = wiki({
    'meta/unlabelled.md': '---\ntitle: Unlabelled\n---\n\n# Unlabelled\n',
    'projects/p/design/nested.md': '---\ntitle: Nested\narea: design\n---\n\n# Nested\n',
    'projects/p/loose.md': '---\ntitle: Loose\n---\n\n# Loose\n',
  })
  t.after(() => box.cleanup())
  const index = box.index()

  assert.deepEqual(search(index, {area: 'design'}).results.map((r) => r.path), ['projects/p/design/nested.md'])
  assert.deepEqual(search(index, {area: 'projects'}).results, [])
  assert.deepEqual(search(index, {area: 'meta'}).results, [])
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
  assert.match(outcome.note, /folder segment/)
})

test('resolve checks the anchor against the target\'s real headings', (t) => {
  const box = wiki(NOTES)
  t.after(() => box.cleanup())
  const index = box.index()

  assert.deepEqual(resolve(index, {target: 'conventions#naming'}).anchor, {name: 'naming', status: 'ok'})
  assert.equal(resolve(index, {target: 'conventions#nope'}).anchor.status, 'missing')
})

test('resolve reports a placeholder as nothing matching, not as an error', (t) => {
  const box = wiki(NOTES)
  t.after(() => box.cleanup())
  const outcome = resolve(box.index(), {target: 'missing-note'})
  assert.equal(outcome.status, 'placeholder')
  assert.equal(outcome.note, 'nothing matches')
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
  const writes = ['rename', 'move', 'delete', 'split_by_heading', 'merge_files', 'rename_tag', 'build_listing', 'body']

  for (const name of writes) {
    const keys = Object.keys(tools[name].inputSchema?.shape ?? {})
    assert.ok(keys.includes('dryRun'), `${name} does not take dryRun`)
  }
  // And a read-only tool does not pretend to: there is nothing to preview.
  assert.ok(!Object.keys(tools.search.inputSchema?.shape ?? {}).includes('dryRun'))
})

/** The tool's own handler, as the transport would call it. */
function call(server, name, args = {}) {
  return server._registeredTools[name].handler(args, {})
}

function textOf(result) {
  return JSON.parse(result.content[0].text)
}

/**
 * A directory with no project above it is not an empty wiki, and the server used
 * to serve it as one: `notesDir` was its own cwd, and zero notes with a clean
 * graph is exactly what a healthy empty wiki reports. Harmless while every server
 * was declared per project; under a user-scoped plugin it starts in every session
 * on the machine, wiki or not.
 */
test('a directory with no project is refused rather than served as an empty wiki', async () => {
  const server = createServer({resolveTarget: async () => null, allowWrites: true})

  for (const name of ['workspace_info', 'check', 'search', 'rename', 'fmt']) {
    const body = textOf(await call(server, name, {path: 'x.md', name: 'y.md', dryRun: true}))
    assert.match(body.error ?? '', /no wiki here/, `${name} did not refuse`)
  }
})

/**
 * The layout is resolved per call, not once at startup, so the session that
 * bootstraps a wiki can use it without restarting the server that will serve it.
 */
test('a wiki that appears after the server started is found on the next call', async (t) => {
  const box = wiki(NOTES)
  t.after(() => box.cleanup())

  let exists = false
  const server = createServer({resolveTarget: async () => (exists ? {notesDir: box.root} : null), allowWrites: true})

  assert.match(textOf(await call(server, 'workspace_info')).error ?? '', /no wiki here/)
  exists = true
  const after = textOf(await call(server, 'workspace_info'))
  assert.equal(after.notesDir, box.root)
  assert.ok(after.notes > 0, 'the wiki that appeared has notes')
})

const BODY = `---
title: Fields
---

# Fields

## Options

| Option       | Gives us | Cost |
|--------------|----------|------|
| aliasDivider | a seam   | low  |
| strict       | refusals | high |

Decided 2026-09-11 and 2026-09-12.
`

/**
 * The body reads are reads, so a read-only mount serves them. `query` and
 * `measure` write nothing at all — there is no dryRun to strip and no half to
 * refuse, which is what makes them unlike `fmt` and `frontmatter`.
 */
test('query and measure are served by a read-only server', async (t) => {
  const box = wiki({...NOTES, 'design/fields.md': BODY})
  t.after(() => box.cleanup())
  const server = createServer({notesDir: box.root})

  const table = textOf(await call(server, 'query', {note: 'design/fields.md', path: [{table: {}}]}))
  assert.equal(table.ok, true)
  assert.deepEqual(table.targets[0].rows[1], {Option: 'strict', 'Gives us': 'refusals', Cost: 'high'})

  const outline = textOf(await call(server, 'query', {note: 'design/fields.md'}))
  assert.deepEqual(outline.outline.map((entry) => entry.text), ['Fields', 'Options'])

  const measured = textOf(await call(server, 'measure', {paths: ['design/fields.md'], pattern: '\\brefusals\\b'}))
  assert.equal(measured.notes[0].dates, 2)
  assert.equal(measured.notes[0].matches, 1)
})

/**
 * **A zod object strips what it does not declare**, and an empty segment spec is a
 * wildcard in read mode — so a misspelled segment type would arrive as `{}` and
 * come back as every section in the note, which reads as an answer. The segment
 * schema passes unknown keys through so the resolver can refuse them by name.
 */
test('a misspelled segment type is refused rather than read as a wildcard', async (t) => {
  const box = wiki({...NOTES, 'design/fields.md': BODY})
  t.after(() => box.cleanup())
  const server = createServer({notesDir: box.root})

  const typo = textOf(await call(server, 'query', {note: 'design/fields.md', path: [{sections: 'Options'}]}))
  assert.equal(typo.ok, false)
  assert.equal(typo.code, 'PATH_BAD_SEGMENT')
  assert.match(typo.message, /sections/)
})

/** A query names a note and a path, and a miss on the first is not a path failure. */
test('query says which half was wrong when the note is not there', async (t) => {
  const box = wiki(NOTES)
  t.after(() => box.cleanup())
  const server = createServer({notesDir: box.root})

  const missing = textOf(await call(server, 'query', {note: 'nope.md', path: [{table: {}}]}))
  assert.equal(missing.code, 'QUERY_NOTE_NOT_FOUND')
})

/**
 * The body's write half, over the surface that carries payloads. The four cases
 * are the ones the tool's own shape can get wrong where the verb's tests cannot:
 * a markdown payload arriving intact through zod, an array-shaped `destination`
 * key surviving a schema that could have stripped it, the write gate, and the
 * refusal reaching the caller as a code rather than as a thrown transport error.
 */
test('body replaces a section by address, over the write surface', async (t) => {
  const box = wiki({...NOTES, 'design/fields.md': BODY})
  t.after(() => box.cleanup())
  const server = createServer({notesDir: box.root, allowWrites: true})

  const report = textOf(
    await call(server, 'body', {
      path: 'design/fields.md',
      address: [{section: 'Options'}],
      operation: 'replace',
      payload: '## Options\n\nNow prose, linking [[conventions]].\n',
    }),
  )
  assert.equal(report.ok, true)
  const after = readFileSync(join(box.root, 'design/fields.md'), 'utf8')
  assert.match(after, /## Options\n\nNow prose, linking \[\[conventions\]\]\.\n/)
  assert.doesNotMatch(after, /aliasDivider/)
})

/**
 * A delete at an ordinal alone is refused, and the refusal is a report with a
 * code — not an exception the transport turns into a stack trace.
 */
test('body refuses a delete that cannot name what it is removing', async (t) => {
  const box = wiki({...NOTES, 'design/fields.md': BODY})
  t.after(() => box.cleanup())
  const server = createServer({notesDir: box.root, allowWrites: true})

  const refused = textOf(
    await call(server, 'body', {path: 'design/fields.md', address: [{section: {nth: 0}}], operation: 'delete'}),
  )
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'BODY_NOMINAL_REQUIRED')
  assert.equal(readFileSync(join(box.root, 'design/fields.md'), 'utf8'), BODY)
})

test('body previews a delete with dryRun and writes nothing', async (t) => {
  const box = wiki({...NOTES, 'design/fields.md': BODY})
  t.after(() => box.cleanup())
  const server = createServer({notesDir: box.root, allowWrites: true})

  const dry = textOf(
    await call(server, 'body', {
      path: 'design/fields.md',
      address: [{section: 'Options'}],
      operation: 'delete',
      dryRun: true,
    }),
  )
  assert.equal(dry.ok, true)
  assert.match(dry.removed, /^## Options/)
  assert.equal(readFileSync(join(box.root, 'design/fields.md'), 'utf8'), BODY)
})

/** A destination naming a second note: the one argument that reaches two files. */
test('body moves a section into another note', async (t) => {
  const box = wiki({...NOTES, 'design/fields.md': BODY, 'design/sink.md': '# Sink\n\n## Elsewhere\n\nHere.\n'})
  t.after(() => box.cleanup())
  const server = createServer({notesDir: box.root, allowWrites: true})

  const report = textOf(
    await call(server, 'body', {
      path: 'design/fields.md',
      address: [{section: 'Options'}],
      operation: 'move',
      destination: {note: 'design/sink.md', address: [{section: 'Elsewhere'}], position: 'last'},
    }),
  )
  assert.equal(report.ok, true)
  assert.equal(report.moved.to.note, 'design/sink.md')
  assert.match(readFileSync(join(box.root, 'design/sink.md'), 'utf8'), /### Options\n\n\| Option/)
  assert.doesNotMatch(readFileSync(join(box.root, 'design/fields.md'), 'utf8'), /aliasDivider/)
})

/**
 * A read-only server does not list `body` and cannot be made to call it: unlike
 * `frontmatter` and `fmt` it has no read half to keep, because `query` is it.
 */
test('body is not on a read-only server at all', async (t) => {
  const box = wiki({...NOTES, 'design/fields.md': BODY})
  t.after(() => box.cleanup())
  const tools = createServer({notesDir: box.root})._registeredTools
  assert.equal(tools.body, undefined)
  assert.ok(tools.query, 'the read half is still there')
})
