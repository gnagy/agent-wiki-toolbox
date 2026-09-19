/**
 * What a child note's front matter is, against a real project — config, schemas
 * and notes — because what a split may get wrong about front matter is only
 * visible where a schema says what is right.
 *
 * The property throughout: **the child inherits and invents nothing.** Every key
 * comes from the source as it was written, none comes from the path, and what a
 * copy may have got wrong is reported rather than guessed at.
 */
import assert from 'node:assert/strict'
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'

import {FRONTMATTER_CODES, splitByHeading} from '../index.js'

/** A schema for one area of a nested layout, which pins `area` to that area. */
const areaSchema = (area) => ({
  type: 'object',
  required: ['title', 'area'],
  properties: {title: {type: 'string'}, area: {const: area}, tags: {type: 'array'}},
})

/**
 * A project the way `awt` expects one. `schemas` maps a schema file's name to its
 * content and globs; none at all is a wiki that declares no vocabulary.
 */
function project(notes, schemas = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'awt-split-'))
  process.env.XDG_CACHE_HOME = join(dir, 'cache')
  const notesDir = join(dir, 'wiki', 'notes')
  mkdirSync(notesDir, {recursive: true})
  mkdirSync(join(dir, 'wiki', 'schemas'), {recursive: true})

  const declared = {}
  for (const [name, {schema, globs}] of Object.entries(schemas)) {
    writeFileSync(join(dir, 'wiki', 'schemas', name), JSON.stringify(schema))
    declared[`./wiki/schemas/${name}`] = globs
  }
  if (Object.keys(declared).length > 0) {
    writeFileSync(join(dir, 'awt.config.mjs'), `export default {schemas: ${JSON.stringify(declared)}}\n`)
  }

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

const NESTED_SCHEMAS = {
  'design.schema.json': {schema: areaSchema('design'), globs: ['projects/*/design/**/*.md']},
  'analysis.schema.json': {schema: areaSchema('analysis'), globs: ['projects/*/analysis/**/*.md']},
}

// A comment, a quoted title and a flow sequence: what a parse-and-stringify loses.
const BIG =
  '---\n' +
  '# the design of the thing\n' +
  'title: "Big"\n' +
  'description: The whole design.\n' +
  'area: design\n' +
  'tags: [alpha, beta]\n' +
  '---\n\n' +
  '# Big\n\nIntro.\n\n## Part\n\nThe part.\n'

test('a child in a nested area keeps the source\'s area rather than the top folder', async (t) => {
  const box = project({'projects/p/design/big.md': BIG}, NESTED_SCHEMAS)
  t.after(() => box.cleanup())

  const report = await splitByHeading(box.notesDir, {
    path: 'projects/p/design/big.md',
    plan: [{heading: 'Part', path: 'projects/p/design/part.md'}],
    source: 'keep',
  })

  assert.equal(report.ok, true)
  assert.equal(report.violations, undefined)
  assert.equal(report.code, undefined)
  // The author's block, style and all, with the title the heading and no
  // description. `area: projects` is what reading the top folder wrote.
  assert.match(
    box.read('projects/p/design/part.md'),
    /^---\n# the design of the thing\ntitle: "Part"\narea: design\ntags: \[alpha, beta]\n---\n\n# Part\n/,
  )
  assert.match(report.notes.join('\n'), /no description/)
  // Same folder: nothing was written for somewhere else.
  assert.doesNotMatch(report.notes.join('\n'), /copied from/)
})

test('a wiki with no area field gets no area, and no type or status either', async (t) => {
  const box = project({
    'notes/big.md': '---\ntitle: Big\ntags: [a]\n---\n\n# Big\n\n## Part\n\nThe part.\n',
    'bare/big.md': '# Bare\n\n## Piece\n\nThe piece.\n',
  })
  t.after(() => box.cleanup())

  await splitByHeading(box.notesDir, {
    path: 'notes/big.md',
    plan: [{heading: 'Part', path: 'notes/part.md'}],
    source: 'keep',
  })
  assert.match(box.read('notes/part.md'), /^---\ntitle: Part\ntags: \[a]\n---\n/)

  // A source with no front matter gives a child with a title and nothing else.
  await splitByHeading(box.notesDir, {
    path: 'bare/big.md',
    plan: [{heading: 'Piece', path: 'bare/piece.md'}],
    source: 'keep',
  })
  assert.match(box.read('bare/piece.md'), /^---\ntitle: Piece\n---\n/)
})

test('a child split into another folder keeps what it copied, and is told what may be wrong', async (t) => {
  const box = project({'projects/p/design/big.md': BIG}, NESTED_SCHEMAS)
  t.after(() => box.cleanup())

  const report = await splitByHeading(box.notesDir, {
    path: 'projects/p/design/big.md',
    plan: [{heading: 'Part', path: 'projects/p/analysis/part.md'}],
    source: 'keep',
  })

  // Written, and kept as copied: which keys depend on placement is the project's
  // knowledge, so the toolbox does not rewrite them.
  assert.deepEqual(report.created, ['projects/p/analysis/part.md'])
  assert.match(box.read('projects/p/analysis/part.md'), /^area: design$/m)

  const said = report.notes.join('\n')
  assert.match(said, /copied from projects\/p\/design\/big\.md in projects\/p\/design\/.*area, tags/)
  assert.match(said, /inherited area: design, which names a folder/)
  assert.match(said, /schema for projects\/p\/analysis\/part\.md does not accept the result/)

  // Coded and listed the way a `frontmatter` write reports a violation.
  assert.equal(report.code, FRONTMATTER_CODES.SCHEMA_VIOLATION)
  assert.equal(report.violations.length, 1)
  assert.match(report.violations[0], /^projects\/p\/analysis\/part\.md: /)
})

test('a key the child\'s schema requires and the source lacks is reported, not guessed', async (t) => {
  const box = project(
    {'meta/big.md': '---\ntitle: Big\n---\n\n# Big\n\n## Part\n\nThe part.\n'},
    {
      'note.schema.json': {
        schema: {type: 'object', required: ['title', 'type'], properties: {type: {enum: ['note', 'adr']}}},
        globs: ['meta/**/*.md'],
      },
    },
  )
  t.after(() => box.cleanup())

  const report = await splitByHeading(box.notesDir, {
    path: 'meta/big.md',
    plan: [{heading: 'Part', path: 'meta/part.md'}],
    source: 'keep',
  })

  assert.doesNotMatch(box.read('meta/part.md'), /^type:/m, 'no value was invented')
  assert.match(report.notes.join('\n'), /requires type, which meta\/big\.md does not have; no value was guessed/)
  assert.equal(report.code, FRONTMATTER_CODES.SCHEMA_VIOLATION)
})
