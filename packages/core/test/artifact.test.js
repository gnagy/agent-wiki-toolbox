/**
 * The index as the Quartz plugins read it.
 *
 * This is the artifact the shadow compares the rendered site against, so a link
 * missing here is a build failure on a wiki where nothing is wrong — which is why
 * the self-link cases below are tested one against the other rather than in
 * isolation.
 */
import assert from 'node:assert/strict'
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import test from 'node:test'

import {
  buildWorkspace,
  check,
  loadWorkspace,
  materialiseIndex,
  parseNote,
  slugifyFilePath,
  ARTIFACT_VERSION,
} from '../index.js'
import {createParser} from '@agent-wiki-toolbox/syntax'

const parser = createParser()
const note = (path, source) => parseNote({path, source, parser})

const wiki = (notes) => buildWorkspace('/wiki', Object.entries(notes).map(([path, source]) => note(path, source)))

test('the artifact keys pages by slug and carries their headings', () => {
  const artifact = materialiseIndex(wiki({'a/one.md': '# One\n\n## A Section\n\nTo [[two]].\n', 'b/two.md': '# Two\n'}))

  assert.equal(artifact.version, ARTIFACT_VERSION)
  assert.deepEqual(artifact.slugs, ['a/one', 'b/two'])
  assert.deepEqual(artifact.pages['a/one'].links, ['b/two'])
  assert.deepEqual(artifact.pages['a/one'].headings, ['one', 'a-section'])
  assert.equal(artifact.pages['a/one'].path, 'a/one.md')
})

test('a note that links to itself by name keeps that link; an anchor-only one has none', () => {
  const artifact = materialiseIndex(
    wiki({'self.md': '# Self\n\nI link to [[self]].\n', 'anchored.md': '# Anchored\n\nUp to [[#anchored]].\n'}),
  )

  // The renderer draws the first and not the second, and the shadow fails a build
  // over either disagreement.
  assert.deepEqual(artifact.pages.self.links, ['self'])
  assert.deepEqual(artifact.pages.anchored.links, [])
})

test('a link to nothing is unresolved rather than absent, and an ambiguous one is neither', () => {
  const artifact = materialiseIndex(
    wiki({
      'one.md': '# One\n\nTo [[nowhere]] and to [[thing]].\n',
      'a/thing.md': '# Thing\n',
      'b/thing.md': '# Thing, again\n',
    }),
  )

  assert.deepEqual(artifact.pages.one.links, [])
  assert.deepEqual(artifact.pages.one.unresolved, ['nowhere'])
  assert.deepEqual(artifact.pages.one.ambiguous, ['thing'])
})

test('two runs over an unchanged wiki produce the same bytes', () => {
  const notes = {'b/two.md': '# Two\n\nTo [[one]].\n', 'a/one.md': '# One\n\nTo [[two]] and [[two]].\n'}
  assert.equal(JSON.stringify(materialiseIndex(wiki(notes))), JSON.stringify(materialiseIndex(wiki(notes))))
  // A link written twice is one edge in the artifact: the renderer draws one.
  assert.deepEqual(materialiseIndex(wiki(notes)).pages['a/one'].links, ['b/two'])
})

/**
 * Attachments: a relative link to a file that is not a note.
 *
 * Quartz publishes every file under the notes, not only the markdown, and links
 * `[the table](menu/sensys-menu.csv)` to that file's own slug. An index that left
 * these out failed the shadow on every page carrying one, with nothing wrong in
 * the wiki; an index that ignored them also let a link to a file that is not
 * there go unreported by `awt check` and rendered broken.
 */
const withFiles = (notes, attachments) =>
  buildWorkspace(
    '/wiki',
    Object.entries(notes).map(([path, source]) => note(path, source)),
    {},
    attachments,
  )

test("a file's slug is Quartz's: the extension kept, except .md and .html, and the folder collapse under it", () => {
  // Each right-hand side is what crawl-links reported as the page's data-slug on
  // the first real build to carry these links.
  assert.equal(slugifyFilePath('specs/2026-09-14-boiler-pipeline/error-codes.csv'), 'specs/2026-09-14-boiler-pipeline/error-codes.csv')
  assert.equal(slugifyFilePath('ariston/menu/menu.yaml'), 'ariston/menu/index.yaml')
  assert.equal(slugifyFilePath('specs/x/ebusd-wiki-message-definition.html'), 'specs/x/ebusd-wiki-message-definition')
  assert.equal(slugifyFilePath('ariston/Genus One.PNG'), 'ariston/genus-one.PNG')
  assert.equal(slugifyFilePath('a/b.md'), 'a/b')
})

test('a link to an attachment lands in the index on the slug the renderer links it to', () => {
  const workspace = withFiles(
    {
      'index.md': '# Home\n\n[img](ariston/display.png) and [page](specs/x/defs.html)\n',
      'ariston/menu-notes.md': '# Menu\n\n[csv](menu/menu.yaml) and [same folder](display.png)\n',
      'ha/errors.md': '# Errors\n\n[codes](../specs/x/codes.csv#row-3)\n',
    },
    ['ariston/display.png', 'ariston/menu/menu.yaml', 'specs/x/defs.html', 'specs/x/codes.csv'],
  )
  const artifact = materialiseIndex(workspace)

  assert.deepEqual(artifact.pages.index.links, ['ariston/display.png', 'specs/x/defs'])
  assert.deepEqual(artifact.pages['ariston/menu-notes'].links, ['ariston/display.png', 'ariston/menu/index.yaml'])
  assert.deepEqual(artifact.pages['ha/errors'].links, ['specs/x/codes.csv'])

  // Not notes, so not nodes: no edge, no backlink, and nothing about them is a problem.
  const health = check(workspace)
  assert.equal(health.links, 0)
  assert.deepEqual(health.problems, [])
  assert.deepEqual(artifact.slugs, ['ariston/menu-notes', 'ha/errors', 'index'])
})

test('a link to an attachment that is not there is broken to check and unresolved in the index', () => {
  const workspace = withFiles(
    {
      'ha/errors.md': '# Errors\n\n[codes](../specs/x/codes.csv) and [gone](../specs/x/gone.csv)\n',
      'ha/note.md': '# Note\n\n[missing note](../nowhere/else.md)\n',
    },
    ['specs/x/codes.csv'],
  )
  const artifact = materialiseIndex(workspace)

  assert.deepEqual(artifact.pages['ha/errors'].links, ['specs/x/codes.csv'])
  // Where crawl-links lands a relative link it cannot resolve, and marks broken:
  // the `..` hoisted and dropped, the rest from the site root.
  assert.deepEqual(artifact.pages['ha/errors'].unresolved, ['specs/x/gone.csv'])
  // The same goes for a relative `.md` path that names no note; the index used to
  // leave that out, and the shadow would have failed on the broken link Quartz drew.
  assert.deepEqual(artifact.pages['ha/note'].unresolved, ['nowhere/else'])

  const problems = check(workspace).problems
  assert.deepEqual(
    problems.map((problem) => [problem.rule, problem.path, problem.message]),
    [
      ['broken-link', 'ha/errors.md', 'no file at ../specs/x/gone.csv'],
      ['broken-link', 'ha/note.md', 'no file at ../nowhere/else.md'],
    ],
  )
})

test('a link that climbs out of the wiki is a warning to check and broken on the page', () => {
  // A note linking to source code beside the wiki: it works on disk, which the
  // index cannot see, and it cannot work on the site, which publishes only notes.
  const workspace = withFiles({'one.md': '# One\n\n[code](../src/main.py)\n'}, ['src/main.py'])
  const health = check(workspace)
  assert.deepEqual(health.problems.map((problem) => [problem.severity, problem.rule]), [['warning', 'link-outside-wiki']])
  assert.equal(health.healthy, true)
  assert.deepEqual(materialiseIndex(workspace).pages.one.unresolved, ['src/main.py'])
})

test('a percent-encoded path is decoded before it is looked up, as the renderer decodes it', () => {
  const workspace = withFiles({'one.md': '# One\n\n[sheet](data/My%20Sheet.ods)\n'}, ['data/My Sheet.ods'])
  assert.deepEqual(check(workspace).problems, [])
  assert.deepEqual(materialiseIndex(workspace).pages.one.links, ['data/my-sheet.ods'])
})

test('loading a wiki from disk finds the attachments beside the notes', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'awt-attachments-'))
  t.after(() => rmSync(root, {recursive: true, force: true}))
  const files = {
    'index.md': '# Home\n\n[img](ariston/display.png), [gone](ariston/gone.png)\n',
    'ariston/display.png': 'png',
    '.hidden/secret.png': 'skipped, as the renderer skips it',
  }
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), {recursive: true})
    writeFileSync(join(root, path), body)
  }

  const workspace = loadWorkspace(root, {cache: false})
  assert.deepEqual(materialiseIndex(workspace).pages.index.links, ['ariston/display.png'])
  assert.deepEqual(check(workspace).problems.map((problem) => problem.message), ['no file at ariston/gone.png'])
})
