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
import {chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'

import {
  COMMANDS,
  COMMON_OPTIONS,
  GROUPS,
  NAME_COLLISIONS,
  RENAMED_FLAGS,
  SECTIONS,
  SHORT_FLAGS,
  commandPath,
  optionsFor,
} from '../index.js'

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

/**
 * A grouped command is findable through its group, not by its own line — the
 * overview shows `site` once with its subcommands beside it, which is the whole
 * point of the group. So the assertion follows the path a reader would.
 */
test('--help lists every command, and every command is findable from it', () => {
  const {stdout} = awt(['--help'])
  for (const command of COMMANDS.filter((one) => !one.group)) {
    assert.ok(stdout.includes(command.name), `${command.name} is missing from --help`)
    assert.ok(stdout.includes(command.summary), `${command.name} has no summary in --help`)
  }
  for (const group of GROUPS) {
    assert.ok(stdout.includes(group.summary), `${group.name} has no summary in --help`)
    const listing = awt([group.name, '--help']).stdout
    for (const command of COMMANDS.filter((one) => one.group === group.name)) {
      assert.ok(listing.includes(command.name), `${group.name} ${command.name} is missing from its group`)
      assert.ok(listing.includes(command.summary), `${group.name} ${command.name} has no summary`)
    }
  }
})

/**
 * A command with no section, or one spelled differently, used to be silently
 * absent from `awt --help` — the overview walks the sections and lists what is in
 * each, so anything unclaimed appeared nowhere while running perfectly. The
 * renderer now files strays under `Unfiled`, which reads as the mistake it is;
 * this asserts the section names themselves, so the fallback stays a safety net
 * rather than somewhere commands quietly collect.
 */
test('every command is filed under a section the overview prints', () => {
  const known = new Set(SECTIONS)
  for (const command of COMMANDS) {
    assert.ok(known.has(command.section), `${commandPath(command).join(' ')}: section "${command.section}"`)
  }
  const {stdout} = awt(['--help'])
  for (const section of SECTIONS) {
    const used = COMMANDS.some((command) => command.section === section)
    assert.equal(stdout.includes(`  ${section}\n`), used, `section ${section} in --help`)
  }
  assert.ok(!stdout.includes('Unfiled'), 'a command reached the fallback heading')
  for (const command of COMMANDS) {
    assert.ok(stdout.includes(command.group ?? command.name), `${command.name} is nowhere in --help`)
  }
})

test('a group with no command lists what is under it and exits non-zero', () => {
  for (const group of GROUPS) {
    const {status, stdout} = awt([group.name])
    assert.equal(status, 1, `${group.name} alone`)
    assert.ok(stdout.includes(group.summary))
  }
})

/**
 * An inherited option comes after the full path. Accepting it before means
 * parsing options without knowing which option map to parse against.
 */
test('a group refuses an option written before its command, and says where it goes', () => {
  const {status, stderr} = awt(['site', '--wiki', 'x', 'publish'])
  assert.equal(status, 2)
  assert.match(stderr, /Options come after the command/)
})

test('every command carries a usage line and a summary worth reading', () => {
  for (const command of COMMANDS) {
    const path = commandPath(command)
    assert.ok(command.summary.length > 20, `${path.join(' ')}: summary too thin`)
    assert.ok(command.usage.includes(path.join(' ')), `${path.join(' ')}: usage does not show the command`)
    const {stdout} = awt([...path, '--help'])
    assert.ok(stdout.includes(command.usage.split('\n')[0].trim()), `${path.join(' ')} --help`)
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
    const declared = Object.keys(optionsFor(command))
    const {stdout} = awt([...commandPath(command), '--help'])
    for (const entry of COMMON_OPTIONS) {
      const shown = stdout.includes(entry.flags)
      assert.equal(shown, declared.includes(entry.name), `${command.name} --help vs --${entry.name}`)
    }
  }
})

test('no usage line names an option the parser would reject', () => {
  for (const command of COMMANDS) {
    const declared = new Set(Object.keys(optionsFor(command)))
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
  assert.match(stdout.split('\n')[0], /^1 problem\(s\);/)

  const healthy = awt(['check', '-w', wiki({'a.md': '# A\n\nSee [[b]].\n', 'b.md': '# B\n\nSee [[a]].\n'}).root])
  assert.equal(healthy.status, 0)
  assert.match(healthy.stdout.split('\n')[0], /^graph is healthy;/)
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
 * `awt fmt --dry-run` on this wiki was 76 lines of "no issues found" — the one output
 * on the binary long enough to need a `| head`, which is where an exit code dies.
 * Every comparable formatter reports the exceptions and summarises the rest.
 */
test('fmt reports what is wrong and counts the rest', (t) => {
  const box = wiki({'a.md': '# A\n\n- fine\n', 'b.md': '# B\n\n- also fine\n'})
  t.after(() => box.cleanup())

  const clean = awt(['fmt', '-w', box.root, '--dry-run'])
  assert.equal(clean.status, 0)
  assert.equal(clean.stdout, '2 files checked, all clean\n')

  writeFileSync(join(box.root, 'b.md'), '# B\n\n* not fine\n')
  const dirty = awt(['fmt', '-w', box.root, '--dry-run'])
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

  const quiet = awt(['fmt', '-w', box.root, '--dry-run'])
  assert.doesNotMatch(quiet.stdout + quiet.stderr, /a\.md/)

  const loud = awt(['fmt', '-w', box.root, '--dry-run', '--verbose'])
  assert.match(loud.stderr, /a\.md/)
  assert.match(loud.stderr, /b\.md/)
  assert.match(loud.stdout, /2 files checked, all clean/)
})

/**
 * The human renderer read `links` off the result before checking for an error, so
 * a note that is not there answered with a TypeError instead of the sentence
 * saying so. --json and the MCP tool had the error all along, which is the worst
 * way round: the surface a person uses was the broken one.
 */
test('connections names a miss instead of crashing on it', (t) => {
  const box = wiki({'meta/conventions.md': '# Conventions\n'})
  t.after(() => box.cleanup())

  const {status, stdout, stderr} = awt(['connections', 'conventions', '-w', box.root])
  assert.equal(status, 1)
  assert.match(stdout, /no note at conventions/)
  assert.doesNotMatch(stderr, /Cannot read properties/)
  // A bare stem is the mistake behind almost every miss here, so the message
  // names the command that does take one.
  assert.match(stdout, /resolve/)

  const found = awt(['connections', 'meta/conventions.md', '-w', box.root])
  assert.equal(found.status, 0)
  assert.match(found.stdout, /links:\s+none/)
})

test('--version answers what is installed', () => {
  const {stdout} = awt(['--version'])
  assert.match(stdout, /^awt \d+\.\d+\.\d+ \(.+\)$/m)
})

test('an unknown command exits 2 and shows the list', () => {
  const {status, stderr} = awt(['nope'])
  assert.equal(status, 2)
  assert.match(stderr, /no such command "nope"/)
  assert.match(stderr, /rename-tag/)
})

test('fmt formats a standalone file with no wiki anywhere near it', (t) => {
  const box = wiki({})
  t.after(() => box.cleanup())
  const file = join(box.dir, 'CLAUDE.md')
  writeFileSync(file, '# Rules\n\n* one\n* two\n')

  assert.equal(awt(['fmt', file]).status, 0)
  assert.equal(awt(['fmt', '--dry-run', file]).status, 0)
})

/**
 * `fmt` was the one command on this binary that did not take `-w`, so an agent
 * holding a note path — the form every other subcommand and the whole MCP surface
 * take — had to know where the wiki sat on disk before it could format it.
 */
test('fmt takes -w, and its paths are then the wiki\'s own', (t) => {
  const box = wiki({'meta/conventions.md': '# Conventions\n\n* one\n* two\n'})
  t.after(() => box.cleanup())

  assert.equal(awt(['fmt', '-w', box.root, '--dry-run', 'meta/conventions.md']).status, 1)
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
  const {status, stderr} = awt(['site', 'publish', '-w', 'docs/wiki'])
  assert.equal(status, 2)
  assert.match(stderr, /takes --wiki and --site, not -w\/--workspace/)
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
  assert.equal(awt(['site', 'index', '--wiki', box.root, '--out', out]).status, 0)
  const artifact = JSON.parse(readFileSync(out, 'utf8'))
  assert.deepEqual(artifact.pages['a/one'].links, ['a/two'])
})

test('--json is the same answer, for a program', (t) => {
  const box = wiki({'a/one.md': '# One\n'})
  t.after(() => box.cleanup())
  const parsed = JSON.parse(awt(['check', '-w', box.root, '--json']).stdout)
  assert.equal(parsed.notes, 1)
})

/**
 * The layout ([[toolbox-decisions]] 38): with no -w, a command finds the project's
 * awt.config.mjs by walking up and means `<rootDir>/notes` — so `awt check` from a
 * repo root reads the wiki rather than every markdown file in the repo, and from
 * `src/deep/` it reads the same wiki. A bare directory with no project around it
 * still means itself.
 */
test('with no -w, a command means the project layout\'s notes from anywhere inside the project', (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'awt-layout-')))
  t.after(() => rmSync(dir, {recursive: true, force: true}))
  writeFileSync(join(dir, 'awt.config.mjs'), 'export default {}\n')
  writeFileSync(join(dir, 'README.md'), '# Not a note\n\nSee [[nowhere]].\n')
  mkdirSync(join(dir, 'wiki/notes/meta'), {recursive: true})
  mkdirSync(join(dir, 'src/deep'), {recursive: true})
  writeFileSync(join(dir, 'wiki/notes/index.md'), '# W\n\nSee [[conventions]].\n')
  writeFileSync(join(dir, 'wiki/notes/meta/conventions.md'), '# Conventions\n\nBack to [[index]].\n')

  for (const cwd of [dir, join(dir, 'src/deep'), join(dir, 'wiki/notes/meta')]) {
    const parsed = JSON.parse(awt(['check', '--json'], {cwd}).stdout)
    assert.equal(parsed.notesDir, join(dir, 'wiki/notes'), `from ${cwd}`)
    assert.equal(parsed.notes, 2, `from ${cwd}: the README outside the notes is not a note`)
    assert.ok(!('root' in parsed), 'the field is notesDir, not root')
  }

  // rootDir moves it.
  writeFileSync(join(dir, 'awt.config.mjs'), "export default {rootDir: './kb'}\n")
  mkdirSync(join(dir, 'kb/notes'), {recursive: true})
  writeFileSync(join(dir, 'kb/notes/index.md'), '# K\n')
  assert.equal(JSON.parse(awt(['check', '--json'], {cwd: join(dir, 'src')}).stdout).notesDir, join(dir, 'kb/notes'))
})

test('the old docs/wiki + site layout still resolves, and says so once', (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'awt-legacy-')))
  t.after(() => rmSync(dir, {recursive: true, force: true}))
  writeFileSync(join(dir, 'awt.config.mjs'), 'export default {}\n')
  mkdirSync(join(dir, 'docs/wiki'), {recursive: true})
  writeFileSync(join(dir, 'docs/wiki/index.md'), '# W\n')

  const {stdout, stderr} = awt(['check', '--json'], {cwd: dir, env: {...process.env, AWT_QUIET_LEGACY: ''}})
  assert.equal(JSON.parse(stdout).notesDir, join(dir, 'docs/wiki'))
  assert.match(stderr, /laid out the old way/)
  // The notice states the facts and names no other project's files.
  assert.match(stderr, /rootDir in awt\.config\.mjs/)
  assert.doesNotMatch(stderr, /skill|adoption\.md/)
})

/**
 * `awt fmt --dry-run` with nothing named, inside a project, means the wiki — as a
 * bare `awt check` does — rather than every markdown file under the cwd. The
 * README beside the config is not a note and must not be reported.
 */
test('with no path, fmt inside a project means the notes', (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'awt-fmt-layout-')))
  t.after(() => rmSync(dir, {recursive: true, force: true}))
  writeFileSync(join(dir, 'awt.config.mjs'), 'export default {}\n')
  writeFileSync(join(dir, 'README.md'), '# R\n\n* not a note, and unformatted\n')
  mkdirSync(join(dir, 'wiki/notes'), {recursive: true})
  writeFileSync(join(dir, 'wiki/notes/index.md'), '# W\n\n- fine\n')

  const {status, stdout} = awt(['fmt', '--dry-run'], {cwd: dir})
  assert.equal(status, 0, stdout)
  assert.match(stdout, /^1 file checked, all clean/)

  // A path still names what to format, project or not.
  assert.equal(awt(['fmt', '--dry-run', 'README.md'], {cwd: dir}).status, 1)
})

/**
 * A path is tried against the cwd first and against the notes directory second,
 * so `awt fmt meta/conventions.md` from the project root means the note, as the
 * MCP tool does. `--json` says which base was used.
 */
test('fmt resolves a path against the cwd, then against the notes, and says which', (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'awt-fmt-base-')))
  t.after(() => rmSync(dir, {recursive: true, force: true}))
  writeFileSync(join(dir, 'awt.config.mjs'), 'export default {}\n')
  mkdirSync(join(dir, 'wiki/notes/meta'), {recursive: true})
  writeFileSync(join(dir, 'wiki/notes/meta/conventions.md'), '# C\n\n* unformatted\n')
  writeFileSync(join(dir, 'README.md'), '# R\n\n- fine\n')

  const viaNotes = awt(['fmt', '--dry-run', '--json', 'meta/conventions.md'], {cwd: dir})
  assert.equal(viaNotes.status, 1, viaNotes.stderr)
  const notesReport = JSON.parse(viaNotes.stdout)
  assert.equal(notesReport.base, 'notes')
  assert.equal(notesReport.files, 1)
  assert.equal(notesReport.ok, false)

  const viaCwd = awt(['fmt', '--dry-run', '--json', 'README.md'], {cwd: dir})
  assert.equal(viaCwd.status, 0, viaCwd.stderr)
  assert.equal(JSON.parse(viaCwd.stdout).base, 'cwd')

  // A path that exists against neither is refused before anything runs. It used
  // to reach remark and come back as node's ENOENT, under a verdict line saying
  // the file had been formatted.
  const missing = awt(['fmt', '--dry-run', '--json', 'nowhere.md'], {cwd: dir})
  assert.equal(missing.status, 2)
  assert.match(missing.stderr, /no file at nowhere\.md/)
  assert.doesNotMatch(missing.stderr, /ENOENT|stat '/)
  assert.equal(missing.stdout, '', 'a refusal is not a --json document')

  // -w names the base outright.
  const explicit = awt(['fmt', '--dry-run', '--json', '-w', join(dir, 'wiki/notes'), 'meta/conventions.md'])
  assert.equal(JSON.parse(explicit.stdout).base, 'workspace')
})

/**
 * Phase 1 of the invocation campaign: the three faults that produce confidently
 * wrong answers rather than inconvenient ones.
 */

/**
 * The table test half. A count that is declared is a count a test can read, and
 * the only thing left to check by hand is that an open-ended command says so
 * where a reader looks — `<query...>`, not `<query>`, which is what made it look
 * like `awt search two words` was a mistake rather than the deliberate join.
 */
test('every command declares how many arguments it takes, and an open-ended one says so', () => {
  const openEnded = /<[^>]*\.\.\.>|\[[a-z]+\.\.\.\]/
  for (const command of COMMANDS) {
    const path = commandPath(command).join(' ')
    const takes = command.positionals
    assert.ok(takes === 'any' || Number.isInteger(takes), `${path}: positionals is ${takes}`)
    assert.equal(openEnded.test(command.usage), takes === 'any', `${path}: usage vs positionals`)
  }
})

/**
 * The behaviour half, which the table cannot carry: four commands dropped an
 * argument they had no use for and answered as if it had not been there.
 * `awt check ../other-wiki` checked *this* wiki and reported its health under the
 * other one's name, which is the failure mode this campaign is about — a plausible
 * answer to a question nobody asked.
 */
test('a command refuses an argument it has no use for, and quotes it back', () => {
  for (const command of COMMANDS.filter((one) => one.positionals === 0)) {
    const path = commandPath(command)
    const {status, stderr} = awt([...path, 'stray-argument'])
    assert.equal(status, 2, `awt ${path.join(' ')} stray-argument`)
    assert.match(stderr, /takes no arguments/)
    assert.match(stderr, /"stray-argument"/)
  }
  // One over its count, not just any count: resolve takes a target and nothing else.
  const two = awt(['resolve', 'a', 'b'])
  assert.equal(two.status, 2)
  assert.match(two.stderr, /takes one argument, and does not know what to do with "b"/)
})

/**
 * The finding the whole audit came from. `awt check` from a directory with no
 * project above it walks that directory — documented behaviour, and a real case
 * for a bare pile of notes — but the report is indistinguishable in shape from a
 * real one. From /tmp it once reported 62 problems, all of them fixtures in other
 * sessions' scratchpads, with nothing marking any of it as suspect.
 */
test('the workspace fallback says it is the fallback, on stderr, once, suppressibly', (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'awt-fallback-')))
  t.after(() => rmSync(dir, {recursive: true, force: true}))
  writeFileSync(join(dir, 'note.md'), '# Note\n\nNothing wrong here.\n')

  const {status, stdout, stderr} = awt(['check', '--json'], {cwd: dir})
  assert.equal(status, 0, stderr)
  assert.match(stderr, /is being read as a notes directory/)
  assert.match(stderr, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  // stdout stays a document: the warning must not reach a --json caller's parse.
  assert.equal(JSON.parse(stdout).notes, 1)

  const quiet = awt(['check', '--json'], {cwd: dir, env: {...process.env, AWT_QUIET_WORKSPACE: '1'}})
  assert.equal(quiet.stderr, '')

  // Named outright, there is nothing to warn about.
  const named = awt(['check', '--json', '-w', dir])
  assert.equal(named.stderr, '')
})

/**
 * A -w naming a file, or a directory that is not there, used to travel as far as
 * `readdir` and come back as node's `ENOTDIR: not a directory, scandir '...'` —
 * the caller's mistake described from inside the call it broke. -w is on every
 * command that works on a wiki, so it is worth answering in the tool's words.
 */
test('-w names a directory, and says so rather than handing back node ENOTDIR', (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'awt-badw-')))
  t.after(() => rmSync(dir, {recursive: true, force: true}))
  const file = join(dir, 'note.md')
  writeFileSync(file, '# Note\n')

  const missing = awt(['check', '-w', join(dir, 'nowhere')])
  assert.equal(missing.status, 2, missing.stderr)
  assert.match(missing.stderr, /-w names .*nowhere, which is not there/)
  assert.doesNotMatch(missing.stderr, /ENOENT|ENOTDIR|scandir/)

  const aFile = awt(['check', '-w', file])
  assert.equal(aFile.status, 2, aFile.stderr)
  assert.match(aFile.stderr, /which is a file\. It names the notes directory, not a note inside it\./)
  assert.doesNotMatch(aFile.stderr, /ENOENT|ENOTDIR|scandir/)

  // $AWT_WORKSPACE is the other way in, and naming the right one is the point.
  const viaEnv = awt(['check'], {env: {...process.env, AWT_WORKSPACE: file}})
  assert.equal(viaEnv.status, 2, viaEnv.stderr)
  assert.match(viaEnv.stderr, /\$AWT_WORKSPACE names/)
})


/**
 * Phase 2 of the invocation campaign: the rules of [[awt-argument-shape]] that can
 * be read off the command table, as tests rather than as prose in a note.
 *
 * **This is the deliverable, more than the fixes are.** A fixed deviation stays
 * fixed for as long as someone remembers it; an asserted one stays fixed. The
 * audit that found eight undocumented options has not needed repeating since it
 * became a test, and these are the same shape.
 *
 * Where a rule has an exception, the exception is a declared register with a
 * reason in it -- SHORT_FLAGS, NAME_COLLISIONS, and the `writes` and `server`
 * markers -- so that adding one is a visible act rather than a silent drift.
 */

test('every option is kebab-case', () => {
  for (const command of COMMANDS) {
    for (const name of Object.keys(optionsFor(command))) {
      assert.match(name, /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, `${commandPath(command).join(' ')}: --${name}`)
    }
  }
})

/**
 * A command that writes takes `--dry-run`, and a command that takes `--dry-run`
 * says it writes. The biconditional is the point: a one-way rule lets the marker
 * rot, and the marker is what the next command is checked against.
 *
 * `fmt` is the seventh writer and had only `--check`, which was the same flag under
 * a name that collided with the `check` command. It is `--dry-run` now.
 */
test('a command that writes takes --dry-run, and nothing else claims to', () => {
  for (const command of COMMANDS) {
    const takesIt = Object.keys(optionsFor(command)).includes('dry-run')
    assert.equal(takesIt, command.writes === true, `${commandPath(command).join(' ')}: writes vs --dry-run`)
  }
})

/**
 * Every read reports as data on request, so a hook or a script is not parsing
 * prose. The exception is a server, whose protocol is its output -- `mcp` speaks
 * MCP over stdio and `site serve` hands the terminal to Quartz's dev server and
 * never returns. Neither has an end at which to emit a document, which is a
 * different thing from having nothing to say.
 */
test('every command that answers a question takes --json, and a server does not', () => {
  for (const command of COMMANDS) {
    const declared = Object.keys(optionsFor(command))
    const path = commandPath(command).join(' ')
    assert.equal(declared.includes('json'), command.server !== true, `${path}: --json vs server`)
  }
  // The rule is worth stating as coverage too: -w means it works on notes.
  const readers = COMMANDS.filter((one) => Object.keys(optionsFor(one)).includes('workspace') && !one.server)
  for (const command of readers) {
    assert.ok(Object.keys(optionsFor(command)).includes('json'), `${command.name} takes -w but not --json`)
  }
})

/**
 * A flag and a command do not share a name. `awt check` and `awt fmt --check` were
 * unrelated operations, and a reader who knew one learned the wrong thing about
 * the other. The register is empty now, and kept: it is where the next exception
 * gets argued rather than smuggled, and it carries the reason.
 */
test('no flag shares a name with a command, except where the register says why', () => {
  const commands = new Set(COMMANDS.map((one) => one.name))
  for (const command of COMMANDS) {
    for (const name of Object.keys(optionsFor(command))) {
      if (!commands.has(name)) continue
      const key = `${commandPath(command).join(' ')} --${name}`
      assert.ok(NAME_COLLISIONS[key], `${key} collides with the ${name} command and is not in the register`)
      assert.ok(NAME_COLLISIONS[key].length > 20, `${key}: the register entry has to say why`)
    }
  }
  // And the register does not outlive what it excuses.
  for (const key of Object.keys(NAME_COLLISIONS)) {
    const [, flag] = key.split(' --')
    const command = COMMANDS.find((one) => commandPath(one).join(' ') === key.split(' --')[0])
    assert.ok(command, `${key}: no such command`)
    assert.ok(Object.keys(optionsFor(command)).includes(flag), `${key}: excuses a flag that is gone`)
  }
})

/**
 * A short flag is earned by frequency across the whole tool, not by one command's
 * convenience. `-c` and `-q` were not, and are kept anyway -- removing them breaks
 * muscle memory to enforce a rule nobody is hurt by. Declaring the set is what
 * makes the rule about the *next* one enforceable.
 */
test('every short flag is declared, and a letter means one thing', () => {
  for (const command of COMMANDS) {
    for (const [name, spec] of Object.entries(optionsFor(command))) {
      if (!spec.short) continue
      const path = commandPath(command).join(' ')
      assert.ok(SHORT_FLAGS[spec.short], `${path}: -${spec.short} is not in SHORT_FLAGS`)
      assert.equal(SHORT_FLAGS[spec.short], name, `${path}: -${spec.short} means ${name} here`)
    }
  }
  const used = new Set(COMMANDS.flatMap((one) => Object.values(optionsFor(one)).map((spec) => spec.short)))
  for (const letter of Object.keys(SHORT_FLAGS)) {
    assert.ok(used.has(letter), `-${letter} is declared but nothing takes it`)
  }
})

/**
 * `--check` is gone, and the person who types it is told what to type instead.
 *
 * Not deprecation -- it does not work -- but node's text for an unknown option
 * ends in advice about `--` that is right for someone with a file called
 * `--check` and wrong for everyone else. RENAMED_FLAGS is read for exactly the
 * hands and hooks that learned the old spelling during this campaign.
 */
test('a flag this campaign renamed is answered by name, not by node', () => {
  for (const [key, now] of Object.entries(RENAMED_FLAGS)) {
    const args = key.split(' ')
    const flag = args.at(-1)
    const {status, stderr} = awt(args)
    assert.equal(status, 2, key)
    // The sentence itself, not `now` appearing somewhere in the usage block below.
    assert.ok(stderr.includes(`${flag} is now ${now}.`), `${key}: stderr was\n${stderr}`)
    assert.doesNotMatch(stderr, /place it at the end/, `${key} fell through to node's advice`)
  }
  // And the register does not outlive what it answers for: a flag that is back
  // would make this a lie.
  for (const key of Object.keys(RENAMED_FLAGS)) {
    const args = key.split(' ')
    assert.doesNotMatch(awt([...args.slice(0, -1), '--help']).stdout, new RegExp(`\\${args.at(-1)}\\b`), key)
  }
})

/**
 * And the flag it became does what it did: reports, writes nothing.
 */
test('fmt --dry-run reports without writing', (t) => {
  const box = wiki({'messy.md': '# Messy\n\n* a bullet\n'})
  t.after(() => box.cleanup())
  const before = readFileSync(join(box.root, 'messy.md'), 'utf8')

  const {status, stdout} = awt(['fmt', '--dry-run', '-w', box.root])
  assert.equal(status, 1)
  assert.match(stdout, /1 file checked, 1 with problems/)
  assert.equal(readFileSync(join(box.root, 'messy.md'), 'utf8'), before, 'fmt --dry-run wrote')

  const formatted = awt(['fmt', '-w', box.root])
  assert.equal(formatted.status, 0, formatted.stderr)
  assert.notEqual(readFileSync(join(box.root, 'messy.md'), 'utf8'), before)
})

/**
 * §5 of the argument shape, as a test per command rather than as a table in a
 * note: **0 means it ran and found nothing to report, 1 means it ran and did not
 * succeed or found what it looks for, 2 means the invocation was wrong and
 * nothing ran.**
 *
 * The half that breaks is `a command that cannot do its job must not exit 0`, and
 * it breaks the same way every time: a verb that cannot tell a re-run from a typo
 * calls the typo a re-run and reports success. `delete` did it about a note that
 * never existed; `merge` did it about sources it had never held, under the words
 * *already merged*; `rename-tag` did it about a tag no note carries. All three
 * came from the same guard, `namesANote`, which only tests that a path is inside
 * the notes directory. This is the assertion that keeps the fourth one from
 * shipping.
 */
test('a command that cannot do its job does not exit 0', (t) => {
  const box = wiki({
    // An ambiguous link, not a placeholder: `[[nowhere]]` is reported separately
    // and deliberately does not affect check's exit code, so a fixture built on
    // one asserts nothing here.
    'a.md': '---\ntags: [real]\n---\n\n# A\n\nLinks to [[b]] and to [[dup]].\n',
    'b.md': '# B\n',
    'x/dup.md': '# Dup\n',
    'y/dup.md': '# Dup\n',
    'messy.md': '# Messy\n\n* a bullet\n',
  })
  t.after(() => box.cleanup())
  const w = ['-w', box.root]

  const cannot = [
    ['check', ['check', ...w], 'a wiki with an ambiguous link'],
    ['search', ['search', 'zzzznomatch', ...w], 'no match'],
    ['resolve', ['resolve', 'nowhere', ...w], 'a target that resolves to nothing'],
    ['connections', ['connections', 'missing.md', ...w], 'a note that is not there'],
    ['delete', ['delete', 'missing.md', ...w], 'a note that is not there'],
    ['move', ['move', 'missing.md', 'x.md', ...w], 'a source that is not there'],
    ['rename-tag', ['rename-tag', 'nosuchtag', 'other', ...w], 'a tag no note carries'],
    ['merge', ['merge', 'missing.md', '--into', 'a.md', '--source', 'keep', ...w], 'a source that is not there'],
    ['split', ['split', 'a.md', '--source', 'keep', '--section', 'Nosuch=out.md', ...w], 'a heading that is not there'],
    ['listing', ['listing', ...w], 'a wiki with no listing file'],
    ['fmt', ['fmt', '--dry-run', ...w], 'a note that is not formatted'],
  ]

  for (const [name, args, what] of cannot) {
    const {status, stdout, stderr} = awt(args)
    assert.equal(status, 1, `awt ${name} on ${what}: exit ${status}\n${stdout}${stderr}`)
    // And it does not call the failure a success in the text either, which is
    // what a person reads and what every one of these got wrong first.
    assert.doesNotMatch(stdout, /^\w+: ok$/m, `awt ${name} on ${what} reported ok`)
  }
})

/**
 * The other end of the same rule. An option a command does not take is a wrong
 * invocation, and nothing runs — including for the two servers, which are refused
 * by the dispatcher before they bind anything.
 */
test('every command exits 2 on an option it does not take', () => {
  for (const command of COMMANDS) {
    const path = commandPath(command)
    const {status} = awt([...path, '--definitely-not-a-flag'])
    assert.equal(status, 2, `awt ${path.join(' ')} --definitely-not-a-flag`)
  }
})

/**
 * §6, swept rather than fixed where the audit happened to look. Two places still
 * let a syscall error through, and the `fmt` one carried a worse fault on top.
 *
 * **`awt fmt a.md nowhere.md` answered "2 files formatted".** The format-mode
 * verdict dropped `problems` entirely, and that line is deliberately printed
 * above the report so `| head -1` catches it — so the one sentence a truncating
 * reader sees was the false one. `--json` had `ok: false` and `problems: 1` the
 * whole time, which is the same wrong-way-round that the search footer was.
 */
test('fmt refuses a path that is not there, and never says it formatted it', (t) => {
  const box = wiki({'good.md': '# Good\n\nfine.\n', 'messy.md': '# Messy\n\n* a bullet\n'})
  t.after(() => box.cleanup())
  const w = ['-w', box.root]

  const one = awt(['fmt', 'nowhere.md', ...w])
  assert.equal(one.status, 2)
  assert.match(one.stderr, /no file at nowhere\.md/)
  assert.doesNotMatch(one.stderr, /ENOENT|No such file or folder|stat '/)
  assert.doesNotMatch(one.stdout, /formatted/, 'it said it formatted a file that is not there')

  // One missing among real ones refuses the batch, and formats none of it.
  const before = readFileSync(join(box.root, 'messy.md'), 'utf8')
  const mixed = awt(['fmt', 'messy.md', 'nowhere.md', ...w])
  assert.equal(mixed.status, 2)
  assert.match(mixed.stderr, /no file at nowhere\.md/)
  assert.equal(readFileSync(join(box.root, 'messy.md'), 'utf8'), before, 'a refused batch formatted one')
})

/**
 * The check is on literal paths only. A glob and a directory are legal inputs
 * that expand to files, and `existsSync` says no to a glob — so a naive check
 * would refuse an invocation that works today. This is the test that says so.
 */
test('fmt still takes a glob and a directory, which do not exist as paths', (t) => {
  const box = wiki({'sub/one.md': '# One\n\n* bullet\n', 'sub/two.md': '# Two\n\nfine.\n'})
  t.after(() => box.cleanup())
  const w = ['-w', box.root]

  for (const path of ['sub/*.md', 'sub']) {
    const {status, stdout, stderr} = awt(['fmt', '--dry-run', path, ...w])
    assert.notEqual(status, 2, `awt fmt ${path} was refused: ${stderr}`)
    assert.match(stdout, /2 files checked/, `awt fmt ${path}`)
  }
})

/**
 * `site index --out` into a directory that is not there reported mkdir's own
 * ENOENT, which names the parent and not the flag that chose it.
 */
test('site index refuses an --out whose directory is not there', (t) => {
  const box = wiki({'a.md': '# A\n'})
  t.after(() => box.cleanup())

  const {status, stderr} = awt(['site', 'index', '--wiki', box.root, '--out', join(box.dir, 'nope/x.json')])
  assert.equal(status, 2)
  assert.match(stderr, /--out names .*nope\/x\.json, and .*nope is not there/)
  assert.doesNotMatch(stderr, /ENOENT|mkdir/)
})

/**
 * The verdict line in format mode, which used to drop `problems` on the floor.
 *
 * **Format mode is purely mechanical** — `buildProcessor` adds the lint plugins
 * and the schemas only for `check`, which is deliberate — so the only problem a
 * formatting run can have is one it could not read or write. That is rare, and it
 * is exactly when a line saying every file was formatted misleads most: the line
 * is printed above the report on purpose, so `| head -1` is what a truncating
 * reader sees, and `awt fmt a.md nowhere.md` used to answer "2 files formatted".
 */
test('format mode says how many had problems, and does not call them formatted', (t) => {
  // chmod does not stop root, and the assertion is about a write that fails.
  if (process.getuid?.() === 0) return t.skip('run as root: a read-only file is still writable')

  const box = wiki({'good.md': '# Good\n\n- fine\n', 'locked.md': '# Locked\n\n* a bullet\n'})
  t.after(() => {
    chmodSync(join(box.root, 'locked.md'), 0o644)
    box.cleanup()
  })
  chmodSync(join(box.root, 'locked.md'), 0o444)

  const {stdout} = awt(['fmt', '-w', box.root])
  const first = stdout.split('\n')[0]
  assert.match(first, /2 files processed, 1 with problems/, `the verdict line was "${first}"`)
  assert.doesNotMatch(first, /formatted/, 'a run that could not write called itself formatted')

  // A clean run still reads as one, and still leads with the count.
  chmodSync(join(box.root, 'locked.md'), 0o644)
  assert.match(awt(['fmt', '-w', box.root]).stdout.split('\n')[0], /2 files formatted/)
})

/**
 * `--json` on the site commands, which had none: they are the commands with the
 * most to report, and `index` reported what it wrote as prose while taking the
 * group's paths like every command around it.
 *
 * The thing worth asserting is not the fields but that **stdout is one document**.
 * These commands narrate — a release build says what it is doing for minutes
 * before it says what it did — so `--json` moves the commentary to stderr rather
 * than turning it off. A second line above the document is the one thing a --json
 * caller cannot be handed.
 */
test('site index reports as data, and says nothing else on stdout', (t) => {
  const box = wiki({'a.md': '# A\n\nlinks to [[b]].\n', 'b.md': '# B\n\nand [[nowhere]].\n'})
  t.after(() => box.cleanup())
  const out = join(box.dir, 'graph.json')

  const {status, stdout} = awt(['site', 'index', '--wiki', box.root, '--out', out, '--json'])
  assert.equal(status, 0)
  const report = JSON.parse(stdout)
  assert.equal(report.ok, true)
  assert.equal(report.notes, 2)
  assert.equal(report.placeholders, 1)
  assert.equal(report.out, out)

  // The same run without --json still answers a person.
  const human = awt(['site', 'index', '--wiki', box.root, '--out', out])
  assert.match(human.stdout, /2 notes, .* 1 placeholders/)
})

/**
 * `site setup` clones Quartz and runs npm install, so the full run is not a test.
 * What is testable, and what would actually break, is that the flag reaches
 * `bootstrap`'s own parser: it is a separate `parseArgs` in the publish package,
 * and an option the CLI accepts and it does not fails there, under a command name
 * that has nothing to do with the mistake.
 */
test('site setup passes --json through to its own parser', (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'awt-setup-')))
  t.after(() => rmSync(dir, {recursive: true, force: true}))

  const {status, stderr} = awt(['site', 'setup', '--json', '--site', dir])
  assert.equal(status, 2)
  assert.match(stderr, /a site directory needs its Quartz config/)
  assert.doesNotMatch(stderr, /Unknown option/)
})
