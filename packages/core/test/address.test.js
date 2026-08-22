/**
 * Address versus name: where a note is served, against what a link calls it.
 *
 * The pair only comes apart for a note sitting beside a folder of its own name,
 * and the rule that moves it must not move the other half — resolution matches on
 * the last segment of a slug, so a note addressed `x/index` would stop answering
 * to `[[x]]` exactly as it does under Quartz's own `x/x.md` layout.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {buildWorkspace, check, materialiseIndex, parseNote} from '../index.js'
import {createParser} from '@agent-wiki-toolbox/syntax'

const parser = createParser()
const note = (path, source) => parseNote({path, source, parser})

const wiki = (notes) => buildWorkspace('/wiki', Object.entries(notes).map(([path, source]) => note(path, source)))

test('a note beside a folder of its own name is served as that folder', () => {
  const workspace = wiki({
    'campaigns/cosites-v2.md': '# Cosites v2\n',
    'campaigns/cosites-v2/design/one.md': '# One\n',
    'campaigns/other.md': '# Other\n',
  })

  assert.equal(workspace.addressOf('campaigns/cosites-v2.md'), 'campaigns/cosites-v2/index')
  // Nothing else moves: `other.md` has no folder beside it.
  assert.equal(workspace.addressOf('campaigns/other.md'), 'campaigns/other')
  assert.equal(workspace.addressOf('campaigns/cosites-v2/design/one.md'), 'campaigns/cosites-v2/design/one')
})

test('the name does not move with the address', () => {
  const workspace = wiki({
    'campaigns/cosites-v2.md': '# Cosites v2\n',
    'campaigns/cosites-v2/design/one.md': '# One\n\nBack to [[cosites-v2]].\n',
  })

  // The whole reason the two are separate fields: moving the slug would make the
  // bare stem match nothing, which is what happens under Quartz's own layout.
  assert.equal(workspace.resolve('cosites-v2').status, 'resolved')
  assert.deepEqual(workspace.edges.map((edge) => edge.to), ['campaigns/cosites-v2.md'])
  assert.deepEqual(workspace.placeholders(), [])
})

test('a folder holding no notes claims nothing', () => {
  // Only markdown makes a folder worth claiming: Quartz generates no listing for
  // a folder of images, so there is nothing for the note to collide with.
  const workspace = wiki({'assets.md': '# Assets\n', 'other.md': '# Other\n'})
  assert.equal(workspace.addressOf('assets.md'), 'assets')
})

test('a note already written as its folder\'s landing page is left alone', () => {
  const workspace = wiki({
    'campaigns/cosites-v2/index.md': '# Cosites v2\n',
    'campaigns/cosites-v2/design/one.md': '# One\n',
    'toolbox/toolbox.md': '# Toolbox\n',
    'toolbox/deep/two.md': '# Two\n',
  })

  assert.equal(workspace.addressOf('campaigns/cosites-v2/index.md'), 'campaigns/cosites-v2/index')
  // Quartz's own `x/x.md` rule already produced this one, in `slugifyPath`.
  assert.equal(workspace.addressOf('toolbox/toolbox.md'), 'toolbox/index')
})

test('two notes claiming one landing page is an error, and neither is moved', () => {
  const workspace = wiki({
    'campaigns/cosites-v2.md': '# Outside\n',
    'campaigns/cosites-v2/index.md': '# Inside\n',
    'campaigns/cosites-v2/design/one.md': '# One\n',
  })

  // Resolving it silently would put two source files on one address, which is
  // Quartz's own collision: one is emitted and the other vanishes.
  assert.equal(workspace.addressOf('campaigns/cosites-v2.md'), 'campaigns/cosites-v2')
  const problems = check(workspace).problems
  assert.deepEqual(problems.map((problem) => problem.rule), ['shadowed-folder-note'])
  assert.equal(problems[0].path, 'campaigns/cosites-v2.md')
  assert.match(problems[0].message, /campaigns\/cosites-v2\/index\.md already is/)
})

test('the artifact publishes the address beside the slug', () => {
  const artifact = materialiseIndex(
    wiki({'campaigns/cosites-v2.md': '# Cosites v2\n', 'campaigns/cosites-v2/design/one.md': '# One\n'}),
  )

  // Keyed by slug, because that is what a link resolves by; carrying the address,
  // because that is what the renderer serves it at and must be told rather than
  // work out.
  assert.equal(artifact.pages['campaigns/cosites-v2'].address, 'campaigns/cosites-v2/index')
  assert.equal(artifact.pages['campaigns/cosites-v2/design/one'].address, 'campaigns/cosites-v2/design/one')
})
