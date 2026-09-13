/**
 * `measure` — the two things the `wc`/`grep -c` loop it replaces got wrong.
 *
 * Front matter is not prose, and a hit is not a line. Both failures are silent and
 * both produce a plausible number, which is why they are the tests rather than the
 * arithmetic.
 */
import assert from 'node:assert/strict'
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'

import {loadWorkspace, measure} from '../index.js'

const NOTES = {
  'one.md': `---
title: One
status: draft
tags: [alpha, beta]
---

# One

Decided 2026-09-11, revised 2026-09-12 and again 2026-09-13.
`,
  'design/two.md': `# Two

Three words here.
`,
  'design/three.md': `# Three

Nothing dated in this one.
`,
}

function box(t) {
  const dir = mkdtempSync(join(tmpdir(), 'awt-measure-'))
  process.env.XDG_CACHE_HOME = join(dir, 'cache')
  const root = join(dir, 'wiki')
  mkdirSync(root, {recursive: true})
  for (const [path, source] of Object.entries(NOTES)) {
    mkdirSync(join(root, path, '..'), {recursive: true})
    writeFileSync(join(root, path), source)
  }
  t.after(() => rmSync(dir, {recursive: true, force: true}))
  return loadWorkspace(root, {cache: false})
}

test('front matter is not prose, and three dates on one line are three', (t) => {
  const workspace = box(t)
  const [row] = measure(workspace, {paths: ['one.md']}).notes

  assert.equal(row.path, 'one.md')
  assert.equal(row.title, 'One')
  // `# One` plus the sentence, `wc -w`'s reading of a word; nothing at all from
  // the block above it, where five of the note's words and none of its prose sit.
  assert.equal(row.words, 9)
  assert.equal(row.dates, 3)
})

test('a pattern is counted by hit, and travels as a regex', (t) => {
  const workspace = box(t)

  assert.equal(measure(workspace, {paths: ['one.md'], pattern: 'revised|again'}).notes[0].matches, 2)
  assert.equal(measure(workspace, {paths: ['one.md'], pattern: '/DECIDED/i'}).notes[0].matches, 1)
  assert.equal(measure(workspace, {paths: ['one.md'], pattern: 'DECIDED'}).notes[0].matches, 0)
  // No pattern, no column: an absent count is not a zero one.
  assert.ok(!('matches' in measure(workspace, {paths: ['one.md']}).notes[0]))
})

test('a bad pattern is a refusal rather than a throw from inside the count', (t) => {
  const workspace = box(t)
  const bad = measure(workspace, {paths: ['one.md'], pattern: '('})
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'MEASURE_BAD_PATTERN')
})

test('one call, one row per note, and the totals beside them', (t) => {
  const workspace = box(t)
  const all = measure(workspace, {paths: ['one.md', 'design']})

  assert.equal(all.ok, true)
  assert.deepEqual(all.notes.map((row) => row.path), ['one.md', 'design/three.md', 'design/two.md'])
  assert.equal(all.totals.notes, 3)
  assert.equal(all.totals.dates, 3)
  assert.equal(all.totals.words, all.notes.reduce((sum, row) => sum + row.words, 0))

  // No paths is the whole wiki.
  assert.equal(measure(workspace, {}).totals.notes, 3)
})

test('a path that names nothing is reported, not dropped', (t) => {
  const workspace = box(t)
  const found = measure(workspace, {paths: ['one.md', 'nope.md']})
  assert.equal(found.ok, false)
  assert.deepEqual(found.missing, ['nope.md'])
  assert.equal(found.notes.length, 1)
})

test('a note named twice, or named by both its path and its folder, is measured once', (t) => {
  const workspace = box(t)
  const found = measure(workspace, {paths: ['design/two.md', 'design/', 'design/two.md']})
  assert.deepEqual(found.notes.map((row) => row.path), ['design/two.md', 'design/three.md'])
})
