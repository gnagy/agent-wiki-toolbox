import assert from 'node:assert/strict'
import test from 'node:test'

import {parse, stringify, wikiLinks} from '../index.js'

/** The single wikilink in a one-line document. */
function link(markdown) {
  const found = wikiLinks(parse(markdown))
  assert.equal(found.length, 1, `expected one wikilink in ${JSON.stringify(markdown)}`)
  const {embed, target, anchor, alias} = found[0]
  return {embed, target, anchor, alias}
}

test('a bare stem', () => {
  assert.deepEqual(link('See [[stem]].'), {
    embed: false,
    target: 'stem',
    anchor: null,
    alias: null,
  })
})

test('a folder-qualified stem', () => {
  assert.deepEqual(link('See [[folder/stem]].'), {
    embed: false,
    target: 'folder/stem',
    anchor: null,
    alias: null,
  })
})

test('an anchor is parsed out of the target', () => {
  assert.deepEqual(link('See [[stem#a-heading]].'), {
    embed: false,
    target: 'stem',
    anchor: 'a-heading',
    alias: null,
  })
})

test('an embed is a node, not escaped prose', () => {
  assert.deepEqual(link('![[embed]]'), {
    embed: true,
    target: 'embed',
    anchor: null,
    alias: null,
  })
})

test('an alias is parsed although the estate bans it', () => {
  assert.deepEqual(link('See [[stem|some text]].'), {
    embed: false,
    target: 'stem',
    anchor: null,
    alias: 'some text',
  })
})

test('an anchor-only link targets the current note', () => {
  assert.deepEqual(link('See [[#a-heading]].'), {
    embed: false,
    target: '',
    anchor: 'a-heading',
    alias: null,
  })
})

test('a block reference parses as an anchor for core to classify', () => {
  assert.deepEqual(link('See [[note#^blockid]].'), {
    embed: false,
    target: 'note',
    anchor: '^blockid',
    alias: null,
  })
})

test('every part is trimmed', () => {
  assert.deepEqual(link('See [[ stem # anchor | text ]].'), {
    embed: false,
    target: 'stem',
    anchor: 'anchor',
    alias: 'text',
  })
})

test('links are found in headings, tables and list items', () => {
  const markdown = [
    '# A [[heading-link]]',
    '',
    '- a [[list-link]]',
    '',
    '| a             |',
    '|---------------|',
    '| a [[cell-link]] |',
    '',
  ].join('\n')
  assert.deepEqual(
    wikiLinks(parse(markdown)).map((node) => node.target),
    ['heading-link', 'list-link', 'cell-link'],
  )
})

test('fenced code and code spans are opaque', () => {
  const markdown = ['`[[not-a-link]]`', '', '```', '[[nor-this]]', '```', ''].join('\n')
  assert.deepEqual(wikiLinks(parse(markdown)), [])
})

for (const markdown of [
  'text [[]] text',
  'text [[   ]] text',
  'text [[a]text',
  'text [[a\nb]] text',
  'text [[a#]] text',
  'text [[a|]] text',
  'text [[|a]] text',
  'text [[#]] text',
  'text [ [a]] text',
]) {
  test(`not a wikilink: ${JSON.stringify(markdown)}`, () => {
    assert.deepEqual(wikiLinks(parse(markdown)), [])
  })
}

test('an unmatched `!` still parses as an image', () => {
  const tree = parse('![alt](image.png)')
  assert.equal(tree.children[0].children[0].type, 'image')
  assert.deepEqual(wikiLinks(tree), [])
})

test('an image whose alt text is a wikilink stays an image', () => {
  const tree = parse('![[[stem]]](image.png)')
  const [node] = tree.children[0].children
  assert.equal(node.type, 'image')
  assert.equal(node.url, 'image.png')
})

test('serialising composes from the parts, so a rewritten target lands', () => {
  const tree = parse('See [[old-name#section]].')
  wikiLinks(tree)[0].target = 'new-name'
  assert.equal(stringify(tree), 'See [[new-name#section]].\n')
})

test('literal bracket text is escaped, and does not become a link', () => {
  const escaped = stringify(parse('literal \\[\\[stem]] text'))
  assert.equal(escaped, 'literal \\[\\[stem]] text\n')
  assert.deepEqual(wikiLinks(parse(escaped)), [])
})

test('literal escaped embed text survives a round trip', () => {
  const escaped = stringify(parse('literal !\\[\\[stem]] text'))
  assert.deepEqual(wikiLinks(parse(escaped)), [])
})
