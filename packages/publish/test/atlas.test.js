/**
 * What the atlas gives a mount, and everything it can fail to.
 *
 * `atlas here <path>` answers with a header line, then a tab-separated table of the placements around
 * the path, outermost first. The atlas is optional, so every way it can be absent is the same answer.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {atlasProject} from '../lib/atlas.js'

const table = (...rows) => ({status: 0, stdout: ['atlas: environment maci, catalog /x', 'type\tname\tproject\tentry', ...rows].join('\n') + '\n'})
const run = (result) => (cmd, args) => {
  assert.equal(cmd, 'atlas')
  assert.deepEqual(args.slice(0, 1), ['here'])
  return result
}

test('the project is the outermost workspace\'s that names one, so a wiki inherits its enclosing project', () => {
  const answer = table(
    'workspace\tShelton\tshelton\t/e/shelton.md',
    'workspace\tShelton checkouts\t-\t/e/checkouts.md',
    'workspace\tshelton-dios\t-\t/e/dios.md',
    'project\tShelton\t-\t/p/shelton.md',
  )
  assert.equal(atlasProject('/p/shelton-dios', {run: run(answer)}), 'shelton')
})

test('a workspace that names its own project gives it, and one that names none gives nothing', () => {
  assert.equal(atlasProject('/p/a', {run: run(table('workspace\tAiSandbox\taisandbox\t/e/a.md', 'project\tAiSandbox\t-\t/p/a.md'))}), 'aisandbox')
  assert.equal(atlasProject('/p/atlas', {run: run(table('environment\tmaci\t-\t/e/maci.md', 'workspace\tAtlas\t-\t/e/atlas.md'))}), null)
})

test('no atlas, no catalog, nothing cataloged there and a project that is not a path segment are all null', () => {
  assert.equal(atlasProject('/p', {run: run({error: new Error('spawn atlas ENOENT'), status: null, stdout: ''})}), null)
  assert.equal(atlasProject('/p', {run: run({status: 3, stdout: ''})}), null)
  assert.equal(atlasProject('/p', {run: run({status: 0, stdout: 'atlas: environment maci, catalog /x\n'})}), null)
  assert.equal(atlasProject('/p', {run: run(table('workspace\tWeird\tNot A Segment\t/e/w.md'))}), null)
})
