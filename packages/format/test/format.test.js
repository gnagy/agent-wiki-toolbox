import assert from 'node:assert/strict'
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Writable} from 'node:stream'
import test from 'node:test'

import {getFrontmatter, setFrontmatter, wikiLinks} from '@agent-wiki-toolbox/syntax'

import {
  AMBIGUOUS_CONFIG,
  buildProcessor,
  detectIgnoreName,
  formatMarkdown,
  intellijTables,
  resolveProjectConfig,
  runFormat,
} from '../index.js'

const fixture = (name) => readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8')
const format = (markdown) => formatMarkdown(markdown)

/**
 * The expected fixture is not hand-written: it is the input after IntelliJ's own
 * formatter ran on it. If IntelliJ ever changes its table style this test is how we
 * find out — see `fixtures/README.md`, and do not edit the fixture to pass.
 */
test('output is byte-identical to IntelliJ for tables', () => {
  assert.equal(format(fixture('intellij.input.md')), fixture('intellij.expected.md'))
})

/**
 * IntelliJ does not apply remark's three-dash minimum: a one-character aligned column
 * stays one character wide. Also captured from the IDE, and a no-op is the assertion.
 */
test('narrow aligned columns are left at content width', () => {
  assert.equal(format(fixture('narrow.expected.md')), fixture('narrow.expected.md'))
})

test('formatting is idempotent', () => {
  const once = format(fixture('intellij.input.md'))
  assert.equal(format(once), once)
})

test('delimiter rows are filled, not padded', () => {
  const out = format('| a | b |\n|---|---|\n| 1 | 2 |\n')
  assert.match(out, /^\|---\|---\|$/m)
  assert.doesNotMatch(out, /\| --- \|/)
})

test('alignment colons survive and keep the column width', () => {
  const out = format('| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |\n')
  const [, delimiter] = out.split('\n')
  assert.equal(delimiter, '|:--|:-:|--:|')
})

test('fenced code is passed through even when it looks like a table', () => {
  const out = format('```mermaid\ngraph TD\n  A -->|"yes"| B\n```\n')
  assert.match(out, /A -->\|"yes"\| B/)
})

test('a lone tilde is not escaped, but strikethrough survives', () => {
  const out = format('About ~15 rows and ~~gone~~.\n')
  assert.match(out, /About ~15 rows/)
  assert.match(out, /~~gone~~/)
})

/**
 * Regression: unescaping `\~` used to run after column widths were computed, which
 * left the table one character short and made formatting non-idempotent. A backslash
 * inside an inline code span is literal text and must survive.
 */
test('an escaped tilde inside a code span survives and keeps the table aligned', () => {
  const once = format('| Rule | Effect |\n|---|---|\n| Lone tilde | Escaped to `\\~` |\n')
  assert.match(once, /Escaped to `\\~`/)
  assert.equal(format(once), once)

  const [header, delimiter, body] = once.split('\n')
  assert.equal(header.length, delimiter.length)
  assert.equal(body.length, delimiter.length)
})

test('wikilinks round-trip, including the alias form the estate bans', () => {
  const out = format('See [[a/b]] and [[c|the c note]].\n')
  assert.match(out, /\[\[a\/b\]\]/)
  assert.match(out, /\[\[c\|the c note\]\]/)
})

/**
 * `markdown-toolbox` needed a repair pass here: `remark-wiki-link` did not tokenise
 * the `!`-prefixed form, so the serialiser escaped its brackets and a regex put them
 * back. `syntax` tokenises embeds, so this is now round-tripping rather than repair.
 */
test('wiki embeds are emitted unescaped, with or without an alias', () => {
  const out = format('An ![[embed]] and an ![[note|alias]] here.\n')
  assert.match(out, /An !\[\[embed]] and an !\[\[note\|alias]] here\./)
  assert.equal(format(out), out)
})

/**
 * The case the old repair pass got wrong, and the reason it did not come across:
 * text that deliberately escapes the syntax to talk *about* it must stay escaped. A
 * regex un-escaping `!\[\[` turns a note explaining embeds into a note containing
 * one.
 */
test('a deliberately escaped embed in prose stays escaped', () => {
  const out = format('Escaping it as !\\[\\[note]] keeps it literal.\n')
  assert.match(out, /!\\\[\\\[note]]/)
  assert.equal(format(out), out)
  assert.deepEqual(wikiLinks(buildProcessor().parse(out)), [])
})

/**
 * The neighbouring case: an image whose alt text opens with `[` is a real image
 * node, so remark escapes the brackets *inside* the alt text.
 */
test('an image whose alt text starts with a bracket keeps its escapes', () => {
  const out = format('![[bracketed] alt](img.png)\n')
  assert.match(out, /!\[\\\[bracketed\\] alt]\(img\.png\)/)
  assert.equal(format(out), out)
})

test('an escaped embed inside a code span survives', () => {
  const out = format('Escaped to `!\\[\\[note]]` in prose.\n')
  assert.match(out, /`!\\\[\\\[note]]`/)
  assert.equal(format(out), out)
})

test('front matter survives as front matter', () => {
  const out = format('---\ntitle: x\n---\n\n# H\n')
  assert.match(out, /^---\ntitle: x\n---/)
})

test('intellijTables leaves an already-correct document alone', () => {
  const document = fixture('intellij.expected.md')
  assert.equal(intellijTables(document), document)
})

test('the processor parses and serialises the shared dialect', () => {
  const processor = buildProcessor()
  const tree = processor.parse(fixture('intellij.input.md'))

  assert.deepEqual(getFrontmatter(tree), {title: 'probe', tags: ['test', 'fixture']})
  assert.deepEqual(
    wikiLinks(tree).map((node) => node.target),
    ['wikilink', 'other'],
  )

  setFrontmatter(tree, {title: 'renamed', status: 'draft'})
  const out = String(processor.stringify(tree))
  assert.match(out, /^---\ntitle: renamed\nstatus: draft\n---/)
  assert.match(out, /\|------------------\|/)
})

/**
 * Regression: unified-engine skips stringification when it has nothing to write, so
 * a compiler-wrapper implementation of the formatting check silently never fired on
 * this path. A string-level check does not catch it; only the engine does.
 */
test('--check detects an unformatted file in a directory', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'awt-format-'))
  t.after(() => rmSync(dir, {recursive: true, force: true}))
  const file = join(dir, 'note.md')
  const silent = new Writable({write: (_chunk, _encoding, done) => done()})

  writeFileSync(file, fixture('intellij.input.md'))
  assert.equal(await runFormat({files: [dir], mode: 'check', streamError: silent}), 1)

  writeFileSync(file, fixture('intellij.expected.md'))
  assert.equal(await runFormat({files: [dir], mode: 'check', streamError: silent}), 0)
})

/**
 * Both ignore names, because unified-engine takes one. A project carrying the old
 * `.mdfmtignore` is a project whose files we do not get to rename, so honouring
 * only the new name reformatted exactly the files it had excluded.
 */
for (const name of ['.awtignore', '.mdfmtignore']) {
  test(`--check honours a ${name}`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'awt-format-'))
    t.after(() => rmSync(dir, {recursive: true, force: true}))
    const silent = new Writable({write: (_chunk, _encoding, done) => done()})

    mkdirSync(join(dir, 'generated'))
    writeFileSync(join(dir, 'generated/gen.md'), fixture('intellij.input.md'))
    assert.equal(await runFormat({files: [dir], mode: 'check', streamError: silent}), 1)

    writeFileSync(join(dir, name), 'generated/\n')
    assert.equal(detectIgnoreName([dir]), name)
    assert.equal(await runFormat({files: [dir], mode: 'check', streamError: silent}), 0)
  })
}

test('the newer ignore name wins where a project carries both', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'awt-format-'))
  t.after(() => rmSync(dir, {recursive: true, force: true}))

  writeFileSync(join(dir, '.mdfmtignore'), 'generated/\n')
  writeFileSync(join(dir, '.awtignore'), 'generated/\n')
  assert.equal(detectIgnoreName([dir]), '.awtignore')
})

test('formatting a directory writes the formatted form back', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'awt-format-'))
  t.after(() => rmSync(dir, {recursive: true, force: true}))
  const file = join(dir, 'note.md')
  const silent = new Writable({write: (_chunk, _encoding, done) => done()})

  writeFileSync(file, fixture('intellij.input.md'))
  await runFormat({files: [dir], streamError: silent})
  assert.equal(readFileSync(file, 'utf8'), fixture('intellij.expected.md'))
})

/**
 * The constraint the layering check enforces, stated as a test as well: a document
 * with no wiki anywhere near it formats.
 */
test('a standalone document with no wiki formats', () => {
  const out = format('# CLAUDE.md\n\n* one\n* two\n')
  assert.equal(out, '# CLAUDE.md\n\n- one\n- two\n')
})

/**
 * `extensions` governs a directory search; a file named on the command line
 * bypasses it and is parsed as markdown whatever it is. `awt fmt awt.config.mjs`
 * rewrote a JavaScript file as a markdown document — `/**` escaped to `/\*\*`,
 * every ` * ` continuation line turned into a list item — and reported success.
 */
test('a named file that is not markdown is refused, not rewritten', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'awt-format-'))
  t.after(() => rmSync(dir, {recursive: true, force: true}))
  const silent = new Writable({write: (_chunk, _encoding, done) => done()})

  const source = '/**\n * A doc comment.\n */\nexport default {serve: {port: 8101}}\n'
  const config = join(dir, 'awt.config.mjs')
  writeFileSync(config, source)

  assert.equal(await runFormat({files: [config], streamError: silent}), 2)
  assert.equal(readFileSync(config, 'utf8'), source, 'untouched, which is the whole point')

  // A directory holding one is still formatted, and still leaves it alone.
  writeFileSync(join(dir, 'note.md'), fixture('intellij.input.md'))
  assert.equal(await runFormat({files: [dir], streamError: silent}), 0)
  assert.equal(readFileSync(config, 'utf8'), source)
  assert.equal(readFileSync(join(dir, 'note.md'), 'utf8'), fixture('intellij.expected.md'))
})

/**
 * The config used to be found by walking up from the **cwd**, so the same note
 * formatted differently depending on where the shell was standing — a repo config
 * when run from the root, the wiki's own when run from inside it, and nothing said
 * which had happened. Every other formatter in this family resolves from the file.
 */
test('the config comes from the path being formatted, not from the cwd', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'awt-config-'))
  t.after(() => rmSync(dir, {recursive: true, force: true}))
  const nested = join(dir, 'wiki')
  mkdirSync(nested, {recursive: true})

  writeFileSync(join(dir, 'awt.config.mjs'), "export default {settings: {bullet: '*'}}\n")
  writeFileSync(join(nested, 'awt.config.mjs'), "export default {settings: {bullet: '+'}}\n")
  const note = join(nested, 'note.md')
  writeFileSync(note, '# t\n\n- a\n')

  const {config, filepath} = await resolveProjectConfig([note], dir)
  assert.equal(filepath, join(nested, 'awt.config.mjs'), "the note's own config, not the one above it")

  const silent = new Writable({write: (_chunk, _encoding, done) => done()})
  await runFormat({files: [note], config, cwd: dir, streamError: silent})
  assert.match(readFileSync(note, 'utf8'), /^\+ a$/m)
})

/**
 * unified-engine takes one processor, so a run has one config. Picking the first
 * of several is the silent wrong answer the function above exists to remove, so
 * disagreement is refused rather than resolved by argument order.
 */
test('paths under different configs are refused rather than resolved by order', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'awt-config-'))
  t.after(() => rmSync(dir, {recursive: true, force: true}))

  for (const [name, bullet] of [['one', '*'], ['two', '+']]) {
    mkdirSync(join(dir, name), {recursive: true})
    writeFileSync(join(dir, name, 'awt.config.mjs'), `export default {settings: {bullet: '${bullet}'}}\n`)
    writeFileSync(join(dir, name, 'note.md'), '# t\n\n- a\n')
  }

  await assert.rejects(
    () => resolveProjectConfig([join(dir, 'one/note.md'), join(dir, 'two/note.md')], dir),
    (error) => error.code === AMBIGUOUS_CONFIG && /different project configs/.test(error.message),
  )
})

/**
 * `cwd` is what makes `--workspace` and the MCP tool able to speak in the
 * workspace-relative paths the rest of the surface takes.
 */
test('a run is rooted at cwd, so its paths can be workspace-relative', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'awt-format-'))
  t.after(() => rmSync(dir, {recursive: true, force: true}))
  mkdirSync(join(dir, 'meta'), {recursive: true})
  writeFileSync(join(dir, 'meta', 'note.md'), fixture('intellij.input.md'))
  const silent = new Writable({write: (_chunk, _encoding, done) => done()})

  assert.equal(await runFormat({files: ['meta/note.md'], cwd: dir, streamError: silent}), 0)
  assert.equal(readFileSync(join(dir, 'meta', 'note.md'), 'utf8'), fixture('intellij.expected.md'))
})
