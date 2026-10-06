/**
 * The Stop hook that keeps a published wiki current, run as Claude Code runs it: a script, the
 * project directory in the environment, an exit code and nothing else.
 *
 * What matters about it is what it does not do. It must return at once and successfully wherever
 * there is no wiki to publish, and it must not make a first release. The decision about staleness
 * belongs to `awt site publish --if-stale`, which stale.test.js covers.
 */
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import test, {after} from 'node:test'

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'hooks', 'wiki-docs-publish.sh')

const made = []
function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'awt-hook-'))
  made.push(dir)
  return dir
}
after(() => {
  for (const dir of made) rmSync(dir, {recursive: true, force: true})
})

/** The hook's log is named for the project directory, so the test finds it the way the hook makes it. */
function logFor(scratch, project) {
  const sum = spawnSync('sh', ['-c', `printf '%s' "$1" | cksum | cut -d' ' -f1`, 'sh', project], {encoding: 'utf8'}).stdout.trim()
  return join(scratch, `awt-publish-${sum}.log`)
}

function run(project, scratch) {
  const env = {...process.env, TMPDIR: scratch, AWT_CONFIG_DIR: join(scratch, 'config'), AWT_TARGET: ''}
  delete env.CLAUDE_PROJECT_DIR
  if (project !== undefined) env.CLAUDE_PROJECT_DIR = project
  const started = Date.now()
  const r = spawnSync('bash', [HOOK], {encoding: 'utf8', env, input: '{}'})
  return {status: r.status, out: `${r.stdout}${r.stderr}`, ms: Date.now() - started}
}

async function waitFor(file, ms = 10000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (existsSync(file) && readFileSync(file, 'utf8').length) return readFileSync(file, 'utf8')
    await new Promise((r) => setTimeout(r, 50))
  }
  return null
}

test('with no project directory the hook does nothing', () => {
  const r = run(undefined, tmp())
  assert.equal(r.status, 0)
  assert.equal(r.out, '')
})

test('a project with no awt.config.mjs is not a wiki, and no process is started for it', () => {
  const scratch = tmp()
  const project = tmp()
  const r = run(project, scratch)
  assert.equal(r.status, 0)
  assert.equal(r.out, '')
  assert.ok(!existsSync(logFor(scratch, project)), 'no build was started, so there is no log')
})

test('a wiki that was never published is left alone, and the hook returns at once', async () => {
  const scratch = tmp()
  const project = tmp()
  writeFileSync(join(project, 'awt.config.mjs'), "export default {site: {title: 'T', self: 't'}}\n")
  mkdirSync(join(project, 'wiki/notes'), {recursive: true})
  mkdirSync(join(project, 'wiki/site'), {recursive: true})
  writeFileSync(join(project, 'wiki/notes/a.md'), '---\ntitle: A\ntype: note\n---\n\n# A\n')
  const r = run(project, scratch)
  assert.equal(r.status, 0)
  assert.equal(r.out, '', 'the hook itself prints nothing; the build writes to its log')
  assert.ok(r.ms < 2000, `returned in ${r.ms} ms`)
  const log = await waitFor(logFor(scratch, project))
  assert.ok(log, 'the background run wrote its log')
  assert.match(log, /no release yet/)
  assert.ok(!existsSync(join(project, 'wiki/site/build')), 'nothing was built, not even the index')
})
