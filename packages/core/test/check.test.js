/**
 * `check` — the one call that answers "is this graph healthy?".
 *
 * The property under test is which findings are **errors** and which are not. A
 * placeholder is the backlog signal and must never fail a check; everything the
 * author cannot have meant must.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {buildWorkspace, check, parseNote} from '../index.js'
import {createParser} from '@agent-wiki-toolbox/syntax'

const parser = createParser()
const note = (path, source) => parseNote({path, source, parser})

const wiki = (notes) => buildWorkspace('/wiki', Object.entries(notes).map(([path, source]) => note(path, source)))
const rules = (notes) => check(wiki(notes)).problems.map((problem) => problem.rule)

test('a wiki with nothing wrong is healthy, and reports nothing', () => {
  const health = check(wiki({'a/one.md': '# One\n\nTo [[two]].\n', 'b/two.md': '# Two\n'}))
  assert.deepEqual(health.problems, [])
  assert.equal(health.healthy, true)
  assert.equal(health.notes, 2)
  assert.equal(health.links, 1)
})

test('a placeholder is the backlog, not a problem', () => {
  const health = check(wiki({'one.md': '# One\n\nTo [[unwritten]].\n'}))
  assert.deepEqual(health.problems, [])
  assert.equal(health.healthy, true)
  assert.deepEqual(health.placeholders.map((placeholder) => placeholder.target), ['unwritten'])
})

test('a stem matching two notes is an error rather than a guess', () => {
  const problems = check(
    wiki({'one.md': '# One\n\nTo [[thing]].\n', 'a/thing.md': '# T\n', 'b/thing.md': '# T\n'}),
  ).problems
  assert.deepEqual(problems.map((problem) => problem.rule), ['ambiguous-link'])
  assert.equal(problems[0].path, 'one.md')
  assert.match(problems[0].message, /a\/thing\.md, b\/thing\.md/)
})

test('a relative link to a file that is not there is broken, not a placeholder', () => {
  assert.deepEqual(rules({'a/one.md': '# One\n\nSee [it](../b/gone.md).\n'}), ['broken-link'])
})

test('an anchor the target does not have is an error', () => {
  assert.deepEqual(
    rules({'one.md': '# One\n\nTo [[two#nowhere]].\n', 'two.md': '# Two\n\n## Somewhere\n'}),
    ['missing-anchor'],
  )
})

test('an aliased link is an error: the label is the finding', () => {
  const problems = check(wiki({'one.md': '# One\n\nTo [[two|the other]].\n', 'two.md': '# Two\n'})).problems
  assert.deepEqual(problems.map((problem) => problem.rule), ['aliased-link'])
  assert.equal(problems[0].severity, 'error')
  // It resolves perfectly well. The objection is to needing the label at all.
  assert.equal(check(wiki({'one.md': '# One\n\nTo [[two]].\n', 'two.md': '# Two\n'})).problems.length, 0)
})

test('a "[[" that never closed is a warning: it yields no edge and no placeholder', () => {
  const health = check(wiki({'one.md': '# One\n\nAn open [[bracket and then nothing.\n'}))
  assert.deepEqual(health.problems.map((problem) => problem.rule), ['unclosed-wikilink'])
  assert.equal(health.problems[0].severity, 'warning')
  assert.equal(health.healthy, true, 'warnings do not fail a check')
})
