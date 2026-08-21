import assert from 'node:assert/strict'
import test from 'node:test'

import {isCrossWikiTarget, parseCrossWikiTarget} from '../index.js'

test('a prefixed path names another wiki', () => {
  assert.deepEqual(parseCrossWikiTarget('handbook:meta/conventions.md'), {
    prefix: 'handbook',
    path: 'meta/conventions.md',
    anchor: null,
  })
})

test('an anchor comes back separately', () => {
  assert.deepEqual(parseCrossWikiTarget('vsf:design/skill-manager/decisions.md#naming'), {
    prefix: 'vsf',
    path: 'design/skill-manager/decisions.md',
    anchor: 'naming',
  })
})

for (const url of [
  'https://example.com',
  'http://example.com',
  'mailto:greg@example.com',
  'tel:+3612345678',
  'data:text/plain,hello',
  'file:/etc/hosts',
  '../other/note.md',
  'note.md',
  'note.md#anchor',
  '#anchor',
  '',
]) {
  test(`not a cross-wiki reference: ${JSON.stringify(url)}`, () => {
    assert.equal(parseCrossWikiTarget(url), null)
    assert.equal(isCrossWikiTarget(url), false)
  })
}

test('a prefix with no path is not a reference', () => {
  assert.equal(parseCrossWikiTarget('handbook:'), null)
  assert.equal(parseCrossWikiTarget('handbook:#anchor'), null)
})
