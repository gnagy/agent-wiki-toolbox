/**
 * The one grammar, asserted in the two places it is written.
 *
 * `syntax` decides what `core` excludes from the link graph; the Quartz
 * transformer decides what the rendered site resolves. They are separate code
 * because a symlinked plugin cannot import a bare specifier — and they drifted:
 * a prefix carrying an uppercase letter, a `.` or a `+` was a cross-wiki
 * reference to one and an ordinary relative link to the other. That link is
 * excluded from the graph *and* left as written in the site, so neither the check
 * nor the shadow can see it. This is the agreement, tested.
 *
 * Add a case here when you change either.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {parseCrossWikiTarget} from '@agent-wiki-toolbox/syntax'

const {parseReference} = await import(new URL('../../../quartz-plugins/awt/index.js', import.meta.url).pathname)

const CROSS_WIKI = [
  'vsf:meta/scope.md',
  'vsf:meta/scope.md#a-heading',
  'handbook:foo.md',
  'a-b-c:x.md',
  // The cases that used to part company: the toolbox called all three cross-wiki
  // and the renderer called none of them that.
  'Vsf:meta/scope.md',
  'my.wiki:x.md',
  'my+wiki:x.md',
]

const NOT_CROSS_WIKI = [
  './relative.md',
  '../up/one.md',
  'plain.md',
  '#just-an-anchor',
  '',
  'https://example.com/x',
  'http://example.com/x',
  // Slash-less URL schemes: legal, still URLs, and never registry keys.
  'mailto:someone@example.com',
  'tel:+1234',
  'data:text/plain,x',
  'javascript:void(0)',
  'file:/etc/hosts',
  'http:example.com',
  // A prefix with nothing after it names no page.
  'vsf:',
  'vsf:#anchor',
  // A digit cannot start a scheme, and a space ends the destination.
  '1wiki:x.md',
  'vsf:a b.md',
]

test('both implementations agree on what is a cross-wiki reference', () => {
  for (const url of CROSS_WIKI) {
    assert.ok(parseCrossWikiTarget(url), `syntax should accept ${JSON.stringify(url)}`)
    assert.ok(parseReference(url), `the renderer should accept ${JSON.stringify(url)}`)
  }
  for (const url of NOT_CROSS_WIKI) {
    assert.equal(parseCrossWikiTarget(url), null, `syntax should reject ${JSON.stringify(url)}`)
    assert.equal(parseReference(url), null, `the renderer should reject ${JSON.stringify(url)}`)
  }
})

test('and on how they split one into prefix, path and anchor', () => {
  for (const url of CROSS_WIKI) {
    const ours = parseCrossWikiTarget(url)
    const theirs = parseReference(url)
    assert.equal(theirs.prefix, ours.prefix, url)
    assert.equal(theirs.target, ours.path, url)
    // The renderer keeps the `#` because all it does with it is append it.
    assert.equal(theirs.anchor, ours.anchor ? `#${ours.anchor}` : '', url)
  }
})

/**
 * Open-questions 17 asked for a cross-wiki anchor that is *checkable*. M8
 * published the data as `awtHeadings.json` and nothing read it, so
 * `vsf:meta/scope.md#not-a-heading` resolved to the page and warned about
 * nothing. This is the consumer.
 */
test('an anchor the target wiki does not publish warns, and never fails', async (t) => {
  const {mkdirSync, mkdtempSync, rmSync, writeFileSync} = await import('node:fs')
  const {tmpdir} = await import('node:os')
  const {join} = await import('node:path')
  const crossWikiLinks = (await import(new URL('../../../quartz-plugins/awt/index.js', import.meta.url).pathname)).default

  const dir = mkdtempSync(join(tmpdir(), 'awt-xwiki-'))
  t.after(() => rmSync(dir, {recursive: true, force: true}))
  const target = join(dir, 'target')
  mkdirSync(target, {recursive: true})
  writeFileSync(
    join(target, 'contentIndex.json'),
    JSON.stringify({'meta/scope': {filePath: 'meta/scope.md', slug: 'meta/scope'}}),
  )
  writeFileSync(
    join(target, 'awtHeadings.json'),
    JSON.stringify({'meta/scope': {filePath: 'meta/scope.md', headings: ['scope', 'what-belongs']}}),
  )

  // One policy for the index: the transformer reads it too, so a test hands one over.
  const index = join(dir, '.awt-index.json')
  writeFileSync(index, JSON.stringify({version: 1, notesDir: dir, slugs: [], pages: {}}))
  const plugin = crossWikiLinks({
    index,
    registry: {vsf: {buildIndex: join(target, 'contentIndex.json'), dev: 'http://localhost:8081'}},
  })
  const [transform] = plugin.markdownPlugins({argv: {serve: true}})

  const warnings = []
  const real = console.warn
  console.warn = (message) => warnings.push(message)
  t.after(() => {
    console.warn = real
  })

  const link = (url) => ({type: 'link', url, children: []})
  const known = link('vsf:meta/scope.md#what-belongs')
  const unknown = link('vsf:meta/scope.md#not-a-heading')
  transform()({type: 'root', children: [known, unknown]}, {data: {filePath: 'one.md'}})

  // Both still resolve to the page: rule 2 says a cross-wiki miss is a warning,
  // because a wiki has to build before the wikis it depends on ever have.
  assert.equal(known.url, 'http://localhost:8081/meta/scope#what-belongs')
  assert.equal(unknown.url, 'http://localhost:8081/meta/scope#not-a-heading')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /has no heading "#not-a-heading"/)
})
