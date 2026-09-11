/**
 * The front-matter verb, against a real project each time — config, schema and
 * notes — because the schema check is half of what it does and a fixture with no
 * schema tests the half that cannot refuse anything.
 *
 * Two properties run through these: **an author's YAML survives an edit**, which
 * is what separates the content scopes from block scope, and **a write that the
 * schema refuses does not land**, which is what makes the check a refusal rather
 * than a report.
 */
import assert from 'node:assert/strict'
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'

import {frontmatter} from '../index.js'

const SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  additionalProperties: false,
  required: ['title', 'type'],
  properties: {
    title: {type: 'string', minLength: 1},
    type: {type: 'string', enum: ['note', 'adr']},
    status: {type: 'string', enum: ['draft', 'stable']},
    tags: {type: 'array', items: {type: 'string'}},
  },
}

/** A project the way `awt` expects one: a config at the root, a wiki home under it. */
function project(notes) {
  const dir = mkdtempSync(join(tmpdir(), 'awt-frontmatter-'))
  process.env.XDG_CACHE_HOME = join(dir, 'cache')
  const notesDir = join(dir, 'wiki', 'notes')
  mkdirSync(notesDir, {recursive: true})
  mkdirSync(join(dir, 'wiki', 'schemas'), {recursive: true})

  writeFileSync(join(dir, 'wiki', 'schemas', 'note.schema.json'), JSON.stringify(SCHEMA))
  writeFileSync(
    join(dir, 'awt.config.mjs'),
    "export default {schemas: {'./wiki/schemas/note.schema.json': ['meta/**/*.md']}}\n",
  )

  for (const [path, source] of Object.entries(notes)) {
    mkdirSync(join(notesDir, path, '..'), {recursive: true})
    writeFileSync(join(notesDir, path), source)
  }

  return {
    notesDir,
    read: (path) => readFileSync(join(notesDir, path), 'utf8'),
    cleanup: () => rmSync(dir, {recursive: true, force: true}),
  }
}

// Comments, double quotes and a flow sequence, all three of which a `parse` and
// `stringify` round trip would throw away.
const AUTHORED =
  '---\n' +
  '# what this note is\n' +
  'title: "A note"\n' +
  'type: note\n' +
  'status: draft\n' +
  'tags: [alpha, beta]\n' +
  '---\n\n' +
  '# A note\n\nBody.\n'

const NOTES = {
  'meta/a.md': AUTHORED,
  'meta/bare.md': '# Bare\n\nNo front matter at all.\n',
  // Outside the schema's glob, so nothing constrains it.
  'loose/b.md': '---\ntitle: Loose\nanything: goes\n---\n\n# Loose\n',
}

const refusal = async (call) => {
  try {
    await call()
  } catch (error) {
    if (!error.report) throw error
    return error.report
  }
  assert.fail('expected a refusal')
}

test('read returns the whole block, and one key', async (t) => {
  const box = project(NOTES)
  t.after(() => box.cleanup())

  const block = await frontmatter(box.notesDir, {path: 'meta/a.md'})
  assert.equal(block.ok, true)
  assert.deepEqual(block.frontmatter, {title: 'A note', type: 'note', status: 'draft', tags: ['alpha', 'beta']})
  assert.deepEqual(block.changed, [])

  const one = await frontmatter(box.notesDir, {path: 'meta/a.md', key: 'tags'})
  assert.deepEqual(one.frontmatter, ['alpha', 'beta'])
})

test("a note with no block reads as none, and a key in it is FRONTMATTER_ABSENT", async (t) => {
  const box = project(NOTES)
  t.after(() => box.cleanup())

  const block = await frontmatter(box.notesDir, {path: 'meta/bare.md'})
  assert.equal(block.ok, true)
  assert.equal(block.frontmatter, null)

  const key = await refusal(() => frontmatter(box.notesDir, {path: 'meta/bare.md', key: 'title'}))
  assert.equal(key.code, 'FRONTMATTER_ABSENT')

  // And a write has nothing to edit: inventing a block is block scope's job.
  const write = await refusal(() =>
    frontmatter(box.notesDir, {path: 'meta/bare.md', operation: 'replace', key: 'title', value: 'x'}),
  )
  assert.equal(write.code, 'FRONTMATTER_ABSENT')
})

test("editing one key leaves the author's comments, quoting and flow sequences alone", async (t) => {
  const box = project(NOTES)
  t.after(() => box.cleanup())

  const report = await frontmatter(box.notesDir, {
    path: 'meta/a.md',
    operation: 'replace',
    key: 'status',
    value: 'stable',
  })
  assert.deepEqual(report.changed, ['meta/a.md'])

  const source = box.read('meta/a.md')
  assert.match(source, /# what this note is/)
  assert.match(source, /title: "A note"/)
  assert.match(source, /tags: \[alpha, beta\]/)
  assert.match(source, /status: stable/)
})

test('replace at content scope adds a key that was not there', async (t) => {
  const box = project(NOTES)
  t.after(() => box.cleanup())

  await frontmatter(box.notesDir, {path: 'loose/b.md', operation: 'replace', key: 'status', value: 'draft'})
  assert.match(box.read('loose/b.md'), /status: draft/)
})

test('a key renamed keeps its value and its place in the block', async (t) => {
  const box = project(NOTES)
  t.after(() => box.cleanup())

  await frontmatter(box.notesDir, {
    path: 'loose/b.md',
    operation: 'replace',
    scope: 'marker',
    key: 'anything',
    value: 'whatever',
  })
  assert.match(box.read('loose/b.md'), /^whatever: goes$/m)
  assert.doesNotMatch(box.read('loose/b.md'), /anything/)
})

test('renaming a key onto one that exists is a collision, not a silent loss', async (t) => {
  const box = project(NOTES)
  t.after(() => box.cleanup())

  const report = await refusal(() =>
    frontmatter(box.notesDir, {
      path: 'meta/a.md',
      operation: 'replace',
      scope: 'marker',
      key: 'status',
      value: 'title',
    }),
  )
  assert.equal(report.code, 'FRONTMATTER_KEY_COLLISION')
  assert.match(box.read('meta/a.md'), /title: "A note"/)
})

test('append and prepend act on a sequence, and refuse anything else', async (t) => {
  const box = project(NOTES)
  t.after(() => box.cleanup())

  await frontmatter(box.notesDir, {path: 'meta/a.md', operation: 'append', key: 'tags', value: 'gamma'})
  await frontmatter(box.notesDir, {path: 'meta/a.md', operation: 'prepend', key: 'tags', value: 'aa'})
  assert.match(box.read('meta/a.md'), /tags: \[aa, alpha, beta, gamma\]/)

  const notASequence = await refusal(() =>
    frontmatter(box.notesDir, {path: 'meta/a.md', operation: 'append', key: 'title', value: 'x'}),
  )
  assert.equal(notASequence.code, 'FRONTMATTER_NOT_A_SEQUENCE')

  const missing = await refusal(() =>
    frontmatter(box.notesDir, {path: 'meta/a.md', operation: 'append', key: 'sources', value: 'x'}),
  )
  assert.equal(missing.code, 'FRONTMATTER_KEY_NOT_FOUND')
})

test('deleting a key that is not there is a refusal, so a typo is not reported as done', async (t) => {
  const box = project(NOTES)
  t.after(() => box.cleanup())

  const report = await refusal(() =>
    frontmatter(box.notesDir, {path: 'meta/a.md', operation: 'delete', key: 'nope'}),
  )
  assert.equal(report.code, 'FRONTMATTER_KEY_NOT_FOUND')

  await frontmatter(box.notesDir, {path: 'meta/a.md', operation: 'delete', key: 'status'})
  assert.doesNotMatch(box.read('meta/a.md'), /status/)
})

test('a write the schema refuses does not land', async (t) => {
  const box = project(NOTES)
  t.after(() => box.cleanup())
  const before = box.read('meta/a.md')

  const enumeration = await refusal(() =>
    frontmatter(box.notesDir, {path: 'meta/a.md', operation: 'replace', key: 'type', value: 'bogus'}),
  )
  assert.equal(enumeration.code, 'FRONTMATTER_SCHEMA_VIOLATION')
  assert.equal(box.read('meta/a.md'), before)

  // A key the schema does not know is refused by the same check rather than by a
  // rule of this verb's own — `additionalProperties: false` is the schema's word.
  const invented = await refusal(() =>
    frontmatter(box.notesDir, {path: 'meta/a.md', operation: 'replace', key: 'invented', value: 'x'}),
  )
  assert.equal(invented.code, 'FRONTMATTER_SCHEMA_VIOLATION')
  assert.equal(box.read('meta/a.md'), before)
})

test('a path no schema claims is written without one', async (t) => {
  const box = project(NOTES)
  t.after(() => box.cleanup())

  const report = await frontmatter(box.notesDir, {
    path: 'loose/b.md',
    operation: 'replace',
    key: 'invented',
    value: 'x',
  })
  assert.deepEqual(report.changed, ['loose/b.md'])
})

test('replacing the block wholesale needs the derived flag', async (t) => {
  const box = project(NOTES)
  t.after(() => box.cleanup())
  const before = box.read('meta/a.md')

  const refused = await refusal(() =>
    frontmatter(box.notesDir, {
      path: 'meta/a.md',
      operation: 'replace',
      scope: 'block',
      value: {title: 'A note', type: 'note'},
    }),
  )
  assert.equal(refused.ok, false)
  assert.equal(box.read('meta/a.md'), before)

  await frontmatter(box.notesDir, {
    path: 'meta/a.md',
    operation: 'replace',
    scope: 'block',
    value: {title: 'A note', type: 'note'},
    derived: true,
  })
  // Reserialised, which is what block scope is: the comment and the quoting are
  // gone, and the flag is where the caller said that was fine.
  const after = box.read('meta/a.md')
  assert.doesNotMatch(after, /# what this note is/)
  assert.match(after, /title: A note/)
})

test('block scope writes the block a note does not have, which is what a scaffolder needs', async (t) => {
  const box = project(NOTES)
  t.after(() => box.cleanup())

  await frontmatter(box.notesDir, {
    path: 'meta/bare.md',
    operation: 'replace',
    scope: 'block',
    value: {title: 'Bare', type: 'note'},
    derived: true,
  })
  assert.match(box.read('meta/bare.md'), /^---\ntitle: Bare\ntype: note\n---\n/)
})

test('the schema refuses a derived block too', async (t) => {
  const box = project(NOTES)
  t.after(() => box.cleanup())

  const report = await refusal(() =>
    frontmatter(box.notesDir, {
      path: 'meta/bare.md',
      operation: 'replace',
      scope: 'block',
      value: {title: 'Bare'},
      derived: true,
    }),
  )
  assert.equal(report.code, 'FRONTMATTER_SCHEMA_VIOLATION')
  assert.doesNotMatch(box.read('meta/bare.md'), /---/)
})

test('a dry run reports the change and writes nothing', async (t) => {
  const box = project(NOTES)
  t.after(() => box.cleanup())
  const before = box.read('meta/a.md')

  const report = await frontmatter(box.notesDir, {
    path: 'meta/a.md',
    operation: 'replace',
    key: 'status',
    value: 'stable',
    dryRun: true,
  })
  assert.equal(report.dryRun, true)
  assert.deepEqual(report.changed, ['meta/a.md'])
  assert.equal(box.read('meta/a.md'), before)
})

test('a write that changes nothing is a no-op rather than a write', async (t) => {
  const box = project(NOTES)
  t.after(() => box.cleanup())

  const report = await frontmatter(box.notesDir, {
    path: 'meta/a.md',
    operation: 'replace',
    key: 'status',
    value: 'draft',
  })
  assert.equal(report.ok, true)
  assert.deepEqual(report.changed, [])
  assert.match(report.notes.join(' '), /already says that/)
})

test('the body is not reachable, and nothing addresses across the two domains', async (t) => {
  const box = project(NOTES)
  t.after(() => box.cleanup())

  for (const call of [
    {path: 'meta/a.md', operation: 'delete', scope: 'block'},
    {path: 'meta/a.md', operation: 'append', scope: 'marker', key: 'tags', value: 'x'},
    {path: 'meta/a.md', operation: 'rewrite', key: 'title', value: 'x'},
  ]) {
    const report = await refusal(() => frontmatter(box.notesDir, call))
    assert.equal(report.ok, false)
  }

  // And the note itself is untouched by any of them.
  assert.equal(box.read('meta/a.md'), AUTHORED)
})

test('a path that is not a note is refused rather than reported ok', async (t) => {
  const box = project(NOTES)
  t.after(() => box.cleanup())

  const report = await refusal(() => frontmatter(box.notesDir, {path: 'meta/nowhere.md'}))
  assert.match(report.notes.join(' '), /no note at meta\/nowhere\.md/)
})
