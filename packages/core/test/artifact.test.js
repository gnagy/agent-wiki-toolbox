/**
 * The index as the Quartz plugins read it.
 *
 * This is the artifact the shadow compares the rendered site against, so a link
 * missing here is a build failure on a wiki where nothing is wrong — which is why
 * the self-link cases below are tested one against the other rather than in
 * isolation.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {buildWorkspace, materialiseIndex, parseNote, ARTIFACT_VERSION} from '../index.js'
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
