/**
 * The M7 acceptance test: **`awt --help` alone is enough to find every operation**,
 * and `awt --version` answers what is installed.
 *
 * The first is checked against the command table rather than against a fixed list,
 * so a command added without a summary or a usage line fails here rather than
 * quietly being undiscoverable.
 */
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'

import {COMMANDS, COMMON_OPTIONS} from '../index.js'

const AWT = new URL('../bin/awt.mjs', import.meta.url).pathname

/**
 * Both streams, every time. `execFileSync` hands back stderr only when the command
 * fails, and `fmt` writes its verdict to stdout and its report to stderr on runs
 * that succeed — so a helper that drops one of them cannot see the split at all.
 */
function awt(args, options = {}) {
  const result = spawnSync(process.execPath, [AWT, ...args], {encoding: 'utf8', ...options})
  return {status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? ''}
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

/**
 * The audit that found eight undocumented options, as a test so it cannot happen
 * again: `search --limit` and `--fields`, `fmt --quiet`, `mcp --name`, three on
 * `publish` and two on `serve` were all accepted by the parser and named nowhere.
 * A help text you cannot read as complete is what sends someone to the source.
 */
test('every command-specific option is named in that command\'s usage line', () => {
  const common = new Set(COMMON_OPTIONS.map((entry) => entry.name))
  for (const command of COMMANDS) {
    const named = new Set([...command.usage.matchAll(/--([A-Za-z][A-Za-z-]*)/g)].map((m) => m[1]))
    for (const name of Object.keys(command.options ?? {})) {
      if (common.has(name)) continue
      assert.ok(named.has(name), `${command.name}: --${name} is accepted but not in its usage line`)
    }
  }
})

/**
 * The other half of the same rule. The common options are documented once, so a
 * usage line omitting them is deliberate — but then every command's help has to
 * show the ones it actually takes, or omission stays unreadable. It went three
 * ways at once before this, which is how `awt search --help` came to look like
 * evidence that search has no -w.
 */
test('every command names the common options it takes, and none it does not', () => {
  for (const command of COMMANDS) {
    const declared = Object.keys(command.options ?? {})
    const {stdout} = awt([command.name, '--help'])
    for (const entry of COMMON_OPTIONS) {
      const shown = stdout.includes(entry.flags)
      assert.equal(shown, declared.includes(entry.name), `${command.name} --help vs --${entry.name}`)
    }
  }
})

test('no usage line names an option the parser would reject', () => {
  for (const command of COMMANDS) {
    const declared = new Set(Object.keys(command.options ?? {}))
    for (const [, name] of command.usage.matchAll(/--([A-Za-z][A-Za-z-]*)/g)) {
      assert.ok(declared.has(name), `${command.name}: usage names --${name}, which it does not accept`)
    }
  }
})

/**
 * The search caps at 20 by default and the envelope has always recorded `total`
 * and `truncated` — the human renderer printed neither, so `awt search` listed 20
 * of 73 notes, said nothing, and exited 0. Every --json caller could see it and
 * every person and agent reading the text could not.
 */
test('search says when it has not shown you everything', (t) => {
  const notes = {}
  for (let i = 0; i < 25; i++) notes[`n${i}.md`] = `# Note ${i}\n\nthe word findme is here.\n`
  const box = wiki(notes)
  t.after(() => box.cleanup())

  const {status, stdout} = awt(['search', 'findme', '-w', box.root])
  assert.equal(status, 0)
  assert.match(stdout, /… 5 more not shown; --limit 25 for all of them/)

  // And when the limit covers everything, no footer claiming otherwise.
  const all = awt(['search', 'findme', '-w', box.root, '--limit', '25'])
  assert.doesNotMatch(all.stdout, /more not shown/)
})

test('search can be restricted to a field', (t) => {
  const box = wiki({
    'title-hit.md': '# Conventions\n\nnothing in the body.\n',
    'body-hit.md': '# Other\n\nThe word conventions, in prose.\n',
  })
  t.after(() => box.cleanup())

  const both = JSON.parse(awt(['search', 'conventions', '-w', box.root, '--json']).stdout)
  assert.equal(both.total, 2)

  const titles = JSON.parse(awt(['search', 'conventions', '-w', box.root, '--fields', 'title', '--json']).stdout)
  assert.equal(titles.total, 1)
  assert.equal(titles.results[0].path, 'title-hit.md')
})

/**
 * The verdict was the LAST line, under a first line of counts that says nothing
 * about health -- so `awt check | head -1` printed the counts for a wiki with two
 * errors in it, and the pipeline threw the non-zero exit away on top.
 */
test('check leads with the verdict, so truncating it cannot hide one', (t) => {
  const box = wiki({
    'one.md': '# One\n\nSee [[thing]].\n',
    'a/thing.md': '# Thing\n',
    'b/thing.md': '# Thing, elsewhere\n',
  })
  t.after(() => box.cleanup())

  const {status, stdout} = awt(['check', '-w', box.root])
  assert.equal(status, 1)
  assert.match(stdout.split('\n')[0], /^1 problem\(s\) —/)

  const healthy = awt(['check', '-w', wiki({'a.md': '# A\n\nSee [[b]].\n', 'b.md': '# B\n\nSee [[a]].\n'}).root])
  assert.equal(healthy.status, 0)
  assert.match(healthy.stdout.split('\n')[0], /^graph is healthy —/)
})

test('check --quiet prints the problems and nothing else', (t) => {
  const box = wiki({
    'one.md': '# One\n\nSee [[thing]].\n',
    'a/thing.md': '# Thing\n',
    'b/thing.md': '# Thing, elsewhere\n',
  })
  t.after(() => box.cleanup())

  const {status, stdout} = awt(['check', '-w', box.root, '--quiet'])
  assert.equal(status, 1)
  assert.match(stdout, /ambiguous-link/)
  assert.doesNotMatch(stdout, /notes,/)

  // Silence means healthy -- not a blank line for a script to strip.
  const clean = awt(['check', '-q', '-w', wiki({'a.md': '# A\n\nSee [[b]].\n', 'b.md': '# B\n\nSee [[a]].\n'}).root])
  assert.equal(clean.status, 0)
  assert.equal(clean.stdout, '')
})

/**
 * `awt fmt --check` on this wiki was 76 lines of "no issues found" — the one output
 * on the binary long enough to need a `| head`, which is where an exit code dies.
 * Every comparable formatter reports the exceptions and summarises the rest.
 */
test('fmt reports what is wrong and counts the rest', (t) => {
  const box = wiki({'a.md': '# A\n\n- fine\n', 'b.md': '# B\n\n- also fine\n'})
  t.after(() => box.cleanup())

  const clean = awt(['fmt', '-w', box.root, '--check'])
  assert.equal(clean.status, 0)
  assert.equal(clean.stdout, '2 files checked, all clean\n')

  writeFileSync(join(box.root, 'b.md'), '# B\n\n* not fine\n')
  const dirty = awt(['fmt', '-w', box.root, '--check'])
  assert.equal(dirty.status, 1)
  // The verdict is the first line, not the last — the end is what a pipe drops.
  assert.equal(dirty.stdout.split('\n')[0], '2 files checked, 1 with problems')

  const written = awt(['fmt', '-w', box.root])
  assert.equal(written.status, 0)
  assert.equal(written.stdout, '2 files formatted\n')
})

test('fmt --verbose brings back the file-by-file listing', (t) => {
  const box = wiki({'a.md': '# A\n\n- fine\n', 'b.md': '# B\n\n- also fine\n'})
  t.after(() => box.cleanup())

  const quiet = awt(['fmt', '-w', box.root, '--check'])
  assert.doesNotMatch(quiet.stdout + quiet.stderr, /a\.md/)

  const loud = awt(['fmt', '-w', box.root, '--check', '--verbose'])
  assert.match(loud.stderr, /a\.md/)
  assert.match(loud.stderr, /b\.md/)
  assert.match(loud.stdout, /2 files checked, all clean/)
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

/**
 * `fmt` was the one command on this binary that did not take `-w`, so an agent
 * holding a note path — the form every other subcommand and the whole MCP surface
 * take — had to know where the wiki sat on disk before it could format it.
 */
test('fmt takes -w, and its paths are then the wiki\'s own', (t) => {
  const box = wiki({'meta/conventions.md': '# Conventions\n\n* one\n* two\n'})
  t.after(() => box.cleanup())

  assert.equal(awt(['fmt', '-w', box.root, '--check', 'meta/conventions.md']).status, 1)
  assert.equal(awt(['fmt', '-w', box.root, 'meta/conventions.md']).status, 0)
  assert.equal(readFileSync(join(box.root, 'meta/conventions.md'), 'utf8'), '# Conventions\n\n- one\n- two\n')

  // And with no path at all, the whole wiki — the same rule as every other command,
  // whose default target is the workspace rather than the directory you stood in.
  writeFileSync(join(box.root, 'meta/conventions.md'), '# Conventions\n\n* one\n')
  assert.equal(awt(['fmt', '-w', box.root]).status, 0)
  assert.match(readFileSync(join(box.root, 'meta/conventions.md'), 'utf8'), /^- one$/m)
})

/**
 * The config was found by walking up from the cwd, so the same note formatted
 * differently depending on where the shell was standing, silently. Run from a
 * directory whose config disagrees with the wiki's: the wiki's has to win.
 */
test('fmt uses the config that governs the note, not the one above the cwd', (t) => {
  const box = wiki({'note.md': '# T\n\n- a\n'})
  t.after(() => box.cleanup())
  writeFileSync(join(box.dir, 'awt.config.mjs'), "export default {settings: {bullet: '*'}}\n")
  writeFileSync(join(box.root, 'awt.config.mjs'), "export default {settings: {bullet: '+'}}\n")

  assert.equal(awt(['fmt', 'wiki/note.md'], {cwd: box.dir}).status, 0)
  assert.match(readFileSync(join(box.root, 'note.md'), 'utf8'), /^\+ a$/m)
})

test('fmt refuses paths that two different configs govern', (t) => {
  const box = wiki({})
  t.after(() => box.cleanup())
  for (const [name, bullet] of [['one', '*'], ['two', '+']]) {
    mkdirSync(join(box.root, name), {recursive: true})
    writeFileSync(join(box.root, name, 'awt.config.mjs'), `export default {settings: {bullet: '${bullet}'}}\n`)
    writeFileSync(join(box.root, name, 'note.md'), '# T\n\n- a\n')
  }

  const {status, stderr} = awt(['fmt', join(box.root, 'one/note.md'), join(box.root, 'two/note.md')])
  assert.equal(status, 2)
  assert.match(stderr, /different project configs/)
  assert.match(stderr, /--workspace/)
})

/**
 * Node's own text for an unknown option ends in advice about `--`, which is for a
 * positional starting with a dash: following it looks for a *file* called `-w`.
 * It is the one message someone who typed `-w` meaning the workspace is shown.
 */
test('a command without -w says which flag it has instead', () => {
  const {status, stderr} = awt(['publish', '-w', 'docs/wiki'])
  assert.equal(status, 2)
  assert.match(stderr, /takes --wiki, not -w\/--workspace/)
  assert.doesNotMatch(stderr, /place it at the end/)
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
  const artifact = JSON.parse(readFileSync(out, 'utf8'))
  assert.deepEqual(artifact.pages['a/one'].links, ['a/two'])
})

test('--json is the same answer, for a program', (t) => {
  const box = wiki({'a/one.md': '# One\n'})
  t.after(() => box.cleanup())
  const parsed = JSON.parse(awt(['check', '-w', box.root, '--json']).stdout)
  assert.equal(parsed.notes, 1)
})
