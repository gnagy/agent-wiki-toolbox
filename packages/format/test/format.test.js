import assert from 'node:assert/strict'
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Writable} from 'node:stream'
import test from 'node:test'

import {getFrontmatter, setFrontmatter, wikiLinks} from '@agent-wiki-toolbox/syntax'

import {buildProcessor, formatMarkdown, intellijTables, runFormat} from '../index.js'

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
