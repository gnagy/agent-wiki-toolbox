import assert from 'node:assert/strict'
import test from 'node:test'

import {buildWorkspace, checkAnchor, parseNote, slugifyPath} from '../index.js'
import {createParser} from '@agent-wiki-toolbox/syntax'

const parser = createParser()
const note = (path, source) => parseNote({path, source, parser})

const wiki = (notes) => buildWorkspace('/wiki', Object.entries(notes).map(([path, source]) => note(path, source)))

test('slugs follow Quartz, not the filesystem', () => {
  assert.equal(slugifyPath('design/A Note.md'), 'design/a-note')
  assert.equal(slugifyPath('design/R&D.md'), 'design/r-and-d')
  assert.equal(slugifyPath('design/50% done.md'), 'design/50-percent-done')
  assert.equal(slugifyPath('folder/_index.md'), 'folder/index')
})

test('a bare stem matches on basename anywhere in the tree', () => {
  const workspace = wiki({
    'a/one.md': 'links to [[two]]',
    'b/c/two.md': '# Two',
  })
  assert.deepEqual(workspace.edges.map((edge) => `${edge.from} -> ${edge.to}`), ['a/one.md -> b/c/two.md'])
})

test('a folder-qualified link is a suffix match', () => {
  const workspace = wiki({
    'a/one.md': 'links to [[c/two]]',
    'b/c/two.md': '# Two',
  })
  assert.equal(workspace.edges.length, 1)
})

test('only a link that names a folder gets that folder\'s index', () => {
  const notes = {'a/one.md': 'to [[topic]] and [[notes/topic/]]', 'notes/topic/index.md': '# Topic'}
  const workspace = wiki(notes)
  // `[[topic]]` is single-segment, so Quartz compares it against the basename
  // `index` and finds nothing. Resolving it here would beat the renderer.
  assert.deepEqual(workspace.placeholders().map((placeholder) => placeholder.target), ['topic'])
  assert.deepEqual(workspace.edges.map((edge) => edge.to), ['notes/topic/index.md'])
})

test('a note named after its own folder collapses to that folder\'s index', () => {
  assert.equal(slugifyPath('design/toolbox/toolbox.md'), 'design/toolbox/index')
})

test('two matches is an error, not a guess', () => {
  const workspace = wiki({
    'a/one.md': 'links to [[two]]',
    'b/two.md': '# Two',
    'c/two.md': '# Two, elsewhere',
  })
  assert.equal(workspace.edges.length, 0)
  assert.deepEqual(workspace.ambiguities[0].candidates, ['b/two.md', 'c/two.md'])
})

test('an ambiguous stem is disambiguated by a folder segment', () => {
  const workspace = wiki({
    'a/one.md': 'links to [[b/two]]',
    'b/two.md': '# Two',
    'c/two.md': '# Two, elsewhere',
  })
  assert.deepEqual(workspace.edges.map((edge) => edge.to), ['b/two.md'])
  assert.equal(workspace.ambiguities.length, 0)
})

test('an unresolved target is a placeholder, and placeholders carry their call sites', () => {
  const workspace = wiki({
    'a/one.md': 'links to [[nothing]]',
    'a/two.md': 'also [[nothing]]',
  })
  assert.deepEqual(workspace.placeholders(), [
    {
      target: 'nothing',
      sites: [
        {from: 'a/one.md', line: 1, target: 'nothing', kind: 'wiki'},
        {from: 'a/two.md', line: 1, target: 'nothing', kind: 'wiki'},
      ],
    },
  ])
})

test('an embed is an edge like any other link', () => {
  const workspace = wiki({'a/one.md': '![[two]]', 'a/two.md': '# Two'})
  assert.deepEqual(workspace.edges.map((edge) => edge.kind), ['embed'])
})

test('a cross-wiki reference is not an edge and not a placeholder', () => {
  const workspace = wiki({'a/one.md': 'see [conventions](handbook:meta/conventions.md)'})
  assert.deepEqual(workspace.edges, [])
  assert.deepEqual(workspace.placeholders(), [])
  assert.equal(workspace.crossWikiLinks.length, 1)
  assert.equal(workspace.crossWikiLinks[0].prefix, 'handbook')
})

test('an ordinary relative markdown link to a note is an edge', () => {
  const workspace = wiki({'a/one.md': 'see [two](../b/two.md)', 'b/two.md': '# Two'})
  assert.deepEqual(workspace.edges.map((edge) => edge.kind), ['markdown'])
})

test('a URL is not an edge', () => {
  const workspace = wiki({'a/one.md': 'see [x](https://example.com) and [y](#local)'})
  assert.deepEqual(workspace.edges, [])
  assert.deepEqual(workspace.placeholders(), [])
})

test('anchors are checked against the target note\'s headings', () => {
  const target = note('b/two.md', '# Two\n\n## A heading\n')
  assert.equal(checkAnchor(target, 'a-heading'), 'ok')
  assert.equal(checkAnchor(target, 'no-such-heading'), 'missing')
  assert.equal(checkAnchor(target, '^blockid'), 'blockReference')
  assert.equal(checkAnchor(target, null), 'none')
})

test('a broken anchor is reported but the link still resolves', () => {
  const workspace = wiki({'a/one.md': 'see [[two#gone]]', 'b/two.md': '# Two\n\n## Here\n'})
  assert.equal(workspace.edges.length, 1)
  assert.equal(workspace.brokenAnchors.length, 1)
  assert.equal(workspace.brokenAnchors[0].to, 'b/two.md')
})

test('repeated headings get the ids a rendered page would give them', () => {
  const resource = note('a/one.md', '## Same\n\n## Same\n')
  assert.deepEqual(resource.headings.map((heading) => heading.anchor), ['same', 'same-1'])
})

test('a link into the note it is written in resolves to that note', () => {
  const workspace = wiki({'a/one.md': '# One\n\n## Here\n\nsee [[#here]]\n'})
  assert.deepEqual(workspace.edges.map((edge) => edge.to), ['a/one.md'])
  assert.deepEqual(workspace.backlinks('a/one.md'), [])
})

test('backlinks, orphans and deadends', () => {
  const workspace = wiki({
    'hub.md': 'to [[leaf]] and [[leaf]] again',
    'leaf.md': '# Leaf',
    'alone.md': '# Alone',
  })
  assert.deepEqual(workspace.backlinks('leaf.md'), ['hub.md'])
  assert.deepEqual(workspace.outbound('hub.md'), ['leaf.md'])
  assert.deepEqual(workspace.orphans(), ['alone.md'])
  assert.deepEqual(workspace.deadends().sort(), ['alone.md', 'leaf.md'])
  assert.deepEqual(workspace.unreferenced().sort(), ['alone.md', 'hub.md'])
})

test('front matter tags become the tag index', () => {
  const workspace = wiki({
    'a.md': '---\ntags: [one, two]\n---\n\n# A\n',
    'b.md': '---\ntags: [two]\n---\n\n# B\n',
  })
  assert.deepEqual([...workspace.tags.keys()].sort(), ['one', 'two'])
  assert.deepEqual(workspace.tags.get('two'), ['a.md', 'b.md'])
})

test('`[[index]]` is the wiki root, which Quartz reaches by falling through', () => {
  const workspace = wiki({'index.md': '# Wiki', 'a/one.md': 'back to [[index]]'})
  assert.deepEqual(workspace.edges.map((edge) => edge.to), ['index.md'])
  assert.deepEqual(workspace.placeholders(), [])
})

test('a relative segment in a wikilink is kept, and matches nothing', () => {
  const workspace = wiki({'a/one.md': 'to [[../two]]', 'two.md': '# Two'})
  assert.deepEqual(workspace.placeholders().map((placeholder) => placeholder.target), ['../two'])
})
