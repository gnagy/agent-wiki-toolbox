/**
 * The M7 acceptance test: **`awt --help` alone is enough to find every operation**,
 * and `awt --version` answers what is installed.
 *
 * The first is checked against the command table rather than against a fixed list,
 * so a command added without a summary or a usage line fails here rather than
 * quietly being undiscoverable.
 */
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'

import {COMMANDS} from '../index.js'

const AWT = new URL('../bin/awt.mjs', import.meta.url).pathname

function awt(args, options = {}) {
  try {
    return {
      status: 0,
      stdout: execFileSync(process.execPath, [AWT, ...args], {encoding: 'utf8', ...options}),
    }
  } catch (error) {
    return {status: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? ''}
  }
}

function wiki(notes) {
  const dir = mkdtempSync(join(tmpdir(), 'awt-cli-'))
  const root = join(dir, 'wiki')
  mkdirSync(root, {recursive: true})
  for (const [path, source] of Object.entries(notes)) {
    mkdirSync(join(root, path, '..'), {recursive: true})
    writeFileSync(join(root, path), source)
  }
  return {dir, root, cleanup: () => rmSync(dir, {recursive: true, force: true})}
}

test('--help lists every command, and every command is findable from it', () => {
  const {stdout} = awt(['--help'])
  for (const command of COMMANDS) {
    assert.ok(stdout.includes(command.name), `${command.name} is missing from --help`)
    assert.ok(stdout.includes(command.summary), `${command.name} has no summary in --help`)
  }
})

test('every command carries a usage line and a summary worth reading', () => {
  for (const command of COMMANDS) {
    assert.ok(command.summary.length > 20, `${command.name}: summary too thin`)
    assert.ok(command.usage.includes(command.name), `${command.name}: usage does not show the command`)
    const {stdout} = awt([command.name, '--help'])
    assert.ok(stdout.includes(command.usage.split('\n')[0].trim()), `${command.name} --help`)
  }
})

test('--version answers what is installed', () => {
  const {stdout} = awt(['--version'])
  assert.match(stdout, /^awt \d+\.\d+\.\d+ \(.+\)$/m)
})

test('an unknown command exits 2 and shows the list', () => {
  const {status, stderr} = awt(['nope'])
  assert.equal(status, 2)
  assert.match(stderr, /no such command "nope"/)
  assert.match(stderr, /split-by-heading/)
})

test('fmt formats a standalone file with no wiki anywhere near it', (t) => {
  const box = wiki({})
  t.after(() => box.cleanup())
  const file = join(box.dir, 'CLAUDE.md')
  writeFileSync(file, '# Rules\n\n* one\n* two\n')

  assert.equal(awt(['fmt', file]).status, 0)
  assert.equal(awt(['fmt', '--check', file]).status, 0)
})

test('check exits non-zero on a broken graph and names the problem', (t) => {
  const box = wiki({
    'a/one.md': '# One\n\nSee [[thing]].\n',
    'b/thing.md': '# Thing\n',
    'c/thing.md': '# Thing, elsewhere\n',
  })
  t.after(() => box.cleanup())

  const {status, stdout} = awt(['check', '-w', box.root])
  assert.equal(status, 1)
  assert.match(stdout, /ambiguous-link/)
  assert.match(stdout, /b\/thing\.md, c\/thing\.md/)
})

test('a verb reports, exits non-zero when incomplete, and honours --dry-run', (t) => {
  const box = wiki({'a/one.md': '# One\n', 'b/two.md': '# Two\n\nSee [[one]].\n'})
  t.after(() => box.cleanup())

  const dry = awt(['move', '-w', box.root, 'a/one.md', 'a/three.md', '--dry-run'])
  assert.equal(dry.status, 0)
  assert.match(dry.stdout, /dry run/)
  assert.match(awt(['resolve', '-w', box.root, 'one']).stdout, /resolved/, 'nothing was written')

  const real = awt(['move', '-w', box.root, 'a/one.md', 'a/three.md'])
  assert.match(real.stdout, /created: a\/three\.md/)
  assert.match(real.stdout, /changed: b\/two\.md/)

  const refused = awt(['move', '-w', box.root, 'a/nowhere.md', 'a/four.md'])
  assert.equal(refused.status, 1)
  assert.match(refused.stdout, /no note at a\/nowhere\.md/)
})

test('index writes the artifact a Quartz build reads', (t) => {
  const box = wiki({'a/one.md': '# One\n\nSee [[two]].\n', 'a/two.md': '# Two\n'})
  t.after(() => box.cleanup())

  const out = join(box.dir, 'index.json')
  assert.equal(awt(['index', '-w', box.root, '--out', out]).status, 0)
  const artifact = JSON.parse(execFileSync('cat', [out], {encoding: 'utf8'}))
  assert.deepEqual(artifact.pages['a/one'].links, ['a/two'])
})

test('--json is the same answer, for a program', (t) => {
  const box = wiki({'a/one.md': '# One\n'})
  t.after(() => box.cleanup())
  const parsed = JSON.parse(awt(['check', '-w', box.root, '--json']).stdout)
  assert.equal(parsed.notes, 1)
})
