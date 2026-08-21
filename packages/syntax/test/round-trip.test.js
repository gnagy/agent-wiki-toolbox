/**
 * The M1 acceptance test: one configuration parses every link form this estate
 * writes, and hands all of them back byte for byte.
 *
 * A formatter that quietly rewrites a link is worse than one that crashes, because
 * the document still renders. So this compares whole documents, not nodes.
 *
 * The table below is laid out the way plain `remark-stringify` lays one out, not the
 * way IntelliJ does. That difference is `format`'s to reconcile — this package fixes
 * what a document *means*, not what it looks like.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {createProcessor, wikiLinks, getFrontmatter} from '../index.js'

const processor = createProcessor()
const roundTrip = (markdown) => String(processor.stringify(processor.parse(markdown)))

const DOCUMENT = `---
title: Every link form
tags: [wikilinks, embeds]
---

# Every link form

A bare stem is [[stem]], a folder-qualified one is [[folder/stem]], and an anchored
one is [[stem#a-heading]].

![[embed]]

A cross-wiki reference is [conventions](handbook:meta/conventions.md), and an
anchored one is [a section](handbook:meta/conventions.md#naming).

An ordinary [relative link](../other/note.md) and a [URL](https://example.com) are
untouched, and so is literal \\[\\[text]] that only looks like a link.

| Link           | Kind       |
| -------------- | ---------- |
| [[stem]]       | wikilink   |
| ![[embed]]     | embed      |
| [x](wiki:a.md) | cross-wiki |
`

test('every link form round-trips unchanged', () => {
  assert.equal(roundTrip(DOCUMENT), DOCUMENT)
})

test('the document really does contain what it claims', () => {
  const tree = processor.parse(DOCUMENT)

  assert.deepEqual(
    wikiLinks(tree).map((node) => [node.embed, node.target, node.anchor]),
    [
      [false, 'stem', null],
      [false, 'folder/stem', null],
      [false, 'stem', 'a-heading'],
      [true, 'embed', null],
      [false, 'stem', null],
      [true, 'embed', null],
    ],
  )

  assert.equal(getFrontmatter(tree).title, 'Every link form')
})

test('a second pass changes nothing', () => {
  assert.equal(roundTrip(roundTrip(DOCUMENT)), roundTrip(DOCUMENT))
})
