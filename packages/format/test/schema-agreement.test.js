/**
 * **`resolveSchemaFor` against the plugin it copies.**
 *
 * The matching rule exists twice — `remark-lint-frontmatter-schema` matches inside
 * its rule function and exports no API for it — and a copy that drifts is the
 * worst kind: `--schema` names one file, the check uses another, and nothing
 * fails. So these do not test the copy against anyone's reading of the rule. They
 * test it against **what the checker actually selected**, which is recoverable at
 * runtime because the plugin names the schema it used inside every violation
 * message:
 *
 *     Must have required property 'topic' • /abs/path/note.schema.json • #/required
 *
 * **Every fixture is invalid on purpose.** A clean note emits no message, and a
 * note with no message says nothing about which schema passed it — so a fixture
 * "fixed" to be valid silently stops testing anything. Leave them broken.
 *
 * No wiki is needed: `frontmatterViolations` takes the note as a string, so only
 * the schema files and the config have to exist on disk.
 */
import assert from 'node:assert/strict'
import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, relative, resolve} from 'node:path'
import process from 'node:process'
import test from 'node:test'

import {frontmatterViolations, resolveSchemaFor} from '../index.js'

/** A schema that rejects everything, so any note handed to it produces a message. */
const rejects = (marker) => ({
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  required: [marker],
  properties: {[marker]: {type: 'string'}},
})

function project(schemas, associations) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'awt-schema-')))
  const notes = join(dir, 'wiki', 'notes')
  mkdirSync(join(dir, 'wiki', 'schemas'), {recursive: true})
  mkdirSync(notes, {recursive: true})

  for (const [name, schema] of Object.entries(schemas)) {
    writeFileSync(join(dir, 'wiki', 'schemas', name), JSON.stringify(schema))
  }
  const configPath = join(dir, 'awt.config.mjs')
  writeFileSync(configPath, 'export default {}\n')

  return {
    dir,
    notes,
    // The shape `runFormat` builds and `frontmatterViolations` takes, so both
    // halves are asked with exactly the coordinates the real run uses.
    coordinates: {
      config: {schemas: associations},
      configPath,
      globBase: notes,
      cwd: notes,
    },
    cleanup: () => rmSync(dir, {recursive: true, force: true}),
  }
}

/**
 * The schema the checker actually used for this note, pulled out of its own
 * message and made absolute. Null when it produced none, which for these fixtures
 * means no schema claimed the path.
 *
 * **Absolute because the plugin's own spelling varies**: a glob association comes
 * back as an absolute path, while a local `$schema` comes back relative, exactly
 * as each was built. Comparing the spellings would be testing the message format;
 * comparing the files is the question.
 */
async function schemaTheCheckerUsed(source, path, coordinates) {
  const violations = await frontmatterViolations(source, {path, ...coordinates})
  if (violations.length === 0) return null
  const [, used] = /• (\S+\.json) •/.exec(violations[0]) ?? []
  assert.ok(used, `no schema path in the message: ${violations[0]}`)
  return resolve(process.cwd(), used)
}

// Front matter that satisfies nothing, so every schema below has something to say.
const BROKEN = '---\ntitle: Broken\n---\n\n# Broken\n'

test('the resolver and the checker pick the same schema for an ordinary path', async (t) => {
  const box = project(
    {'note.schema.json': rejects('topic')},
    {'./wiki/schemas/note.schema.json': ['meta/**/*.md']},
  )
  t.after(() => box.cleanup())

  const used = await schemaTheCheckerUsed(BROKEN, 'meta/a.md', box.coordinates)
  assert.equal(resolveSchemaFor('meta/a.md', box.coordinates), used)
  assert.match(used, /note\.schema\.json$/)
})

test('where two globs both match, both agree on which one wins', async (t) => {
  // Two entries that both claim the path. The plugin loops and overwrites, so the
  // last one wins — and this is the case where a copy that breaks on the first
  // match would pass a casual reading and be wrong.
  const box = project(
    {'first.schema.json': rejects('alpha'), 'second.schema.json': rejects('beta')},
    {
      './wiki/schemas/first.schema.json': ['meta/**/*.md'],
      './wiki/schemas/second.schema.json': ['**/*.md'],
    },
  )
  t.after(() => box.cleanup())

  const used = await schemaTheCheckerUsed(BROKEN, 'meta/a.md', box.coordinates)
  assert.match(used, /second\.schema\.json$/, 'last match wins')
  assert.equal(resolveSchemaFor('meta/a.md', box.coordinates), used)
})

test('a path no glob matches is claimed by nothing, and both say so', async (t) => {
  const box = project(
    {'note.schema.json': rejects('topic')},
    {'./wiki/schemas/note.schema.json': ['projects/*/*/*.md']},
  )
  t.after(() => box.cleanup())

  // One level deeper than the glob reaches — the real case this came from.
  const path = 'projects/demo/design/schemas/deeper.md'
  assert.equal(await schemaTheCheckerUsed(BROKEN, path, box.coordinates), null)
  assert.equal(resolveSchemaFor(path, box.coordinates), null)

  // And the sibling one level up is claimed, so the fixture is testing the depth
  // rather than a glob that matches nothing at all.
  const claimed = 'projects/demo/design/right-here.md'
  assert.ok(await schemaTheCheckerUsed(BROKEN, claimed, box.coordinates))
  assert.ok(resolveSchemaFor(claimed, box.coordinates))
})

/**
 * The local form is **resolved from `process.cwd()`**, not from the notes
 * directory: the plugin joins the note's own directory onto the process's cwd, so
 * where the run was started decides what `$schema: ./x.json` means. That is a
 * property of the plugin rather than a choice, and it is the reason this wiki does
 * not use the local form at all — its `note.schema.json` sets
 * `additionalProperties: false` and never declares `$schema`, so a note carrying
 * one would violate the schema it had just selected.
 *
 * So the fixture writes a `$schema` that resolves from wherever the test process
 * happens to be, which is the only way to exercise the rule honestly.
 */
test("a note's own $schema beats the globs, for both", async (t) => {
  const box = project(
    {'note.schema.json': rejects('topic'), 'special.schema.json': rejects('gamma')},
    {'./wiki/schemas/note.schema.json': ['*.md']},
  )
  t.after(() => box.cleanup())

  const special = relative(process.cwd(), join(box.dir, 'wiki', 'schemas', 'special.schema.json'))
  // A note at the top of the wiki, so the note's own directory is `.` and the
  // path below is joined onto the cwd unchanged.
  const source = `---\n$schema: ${special}\ntitle: Broken\n---\n\n# Broken\n`

  const used = await schemaTheCheckerUsed(source, 'a.md', box.coordinates)
  assert.match(used, /special\.schema\.json$/, 'the local association wins')
  assert.equal(resolveSchemaFor('a.md', {...box.coordinates, source}), used)

  // Without the note's bytes the resolver can only see the globs — which is right
  // for a path that does not exist yet, and is why `source` is passed for one that
  // does.
  assert.match(resolveSchemaFor('a.md', box.coordinates), /note\.schema\.json$/)
})

test('a project that maps no schemas claims nothing', async (t) => {
  const box = project({}, {})
  t.after(() => box.cleanup())

  assert.equal(resolveSchemaFor('meta/a.md', {...box.coordinates, config: {}}), null)
  assert.deepEqual(await frontmatterViolations(BROKEN, {path: 'meta/a.md', ...box.coordinates, config: {}}), [])
})
