import assert from 'node:assert/strict'
import test from 'node:test'

import {createProcessor, getFrontmatter, setFrontmatter} from '../index.js'

const processor = createProcessor()

test('front matter is data, not prose', () => {
  const tree = processor.parse('---\ntitle: A note\nstatus: draft\n---\n\n# A note\n')
  assert.deepEqual(getFrontmatter(tree), {title: 'A note', status: 'draft'})
})

test('a note without front matter has none', () => {
  assert.equal(getFrontmatter(processor.parse('# A note\n')), undefined)
})

test('setting front matter inserts it when the note has none', () => {
  const tree = setFrontmatter(processor.parse('# A note\n'), {title: 'A note'})
  assert.equal(String(processor.stringify(tree)), '---\ntitle: A note\n---\n\n# A note\n')
})

test('setting front matter replaces what is there', () => {
  const tree = processor.parse('---\ntitle: Old\n---\n\n# A note\n')
  setFrontmatter(tree, {...getFrontmatter(tree), title: 'New'})
  assert.equal(getFrontmatter(processor.parse(String(processor.stringify(tree)))).title, 'New')
})
