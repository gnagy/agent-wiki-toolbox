/**
 * Every operation the toolbox has, as one subcommand of the one binary. Names are
 * `splitByHeading` in the library, `split_by_heading` on the MCP surface and
 * `split` here.
 *
 * A command is data: a name, one line of summary, a usage string, how many
 * arguments it takes, an option map for `parseArgs`, and a `run`. `awt --help` is
 * generated from that list, so every command is listed. Two optional fields shape
 * the surface rather than the call: `group` puts a command under a `GROUPS` entry
 * and it is then invoked as `awt <group> <name>`, and `section` is the heading it
 * is listed under.
 *
 * `positionals` is a count, or `'any'` for the three that are open-ended. It is
 * declared rather than inferred because an unexpected argument was silently
 * dropped by four commands — `awt check ../other-wiki` checked this one and said
 * nothing — and a count a command states is also a count a test can read.
 *
 * The CLI is not a mirror of the packages. `move` here is `moveNote` or
 * `renameNote` depending on its destination, `site index` is a `core` function
 * grouped by what consumes it, and the MCP surface stays flat with its own names.
 */
import {existsSync, readFileSync, statSync} from 'node:fs'
import {dirname, resolve as resolvePath} from 'node:path'
import process from 'node:process'

import {parse as parseYaml, stringify as stringifyYaml} from 'yaml'

import {check, loadWorkspace, writeIndexArtifact} from '@agent-wiki-toolbox/core'
import {
  AMBIGUOUS_CONFIG,
  collectStream,
  layoutFrom,
  loadProjectConfig,
  resolveLayout,
  resolveProjectConfig,
  runFormat,
} from '@agent-wiki-toolbox/format'
import {connections, resolve as resolveLink, search} from '@agent-wiki-toolbox/mcp'
import {
  buildListing,
  deleteNote,
  frontmatter,
  mergeFiles,
  moveNote,
  renameNote,
  renameTag,
  splitByHeading,
} from '@agent-wiki-toolbox/verbs'

/**
 * The notes a command works on: `--workspace`, else `$AWT_WORKSPACE`, else the
 * project's own layout, else the cwd.
 *
 * The third step lets `awt check` run from a repo root and mean the wiki: the
 * nearest `awt.config.mjs` names the home and the notes are a fixed name inside it.
 *
 * The fourth is the one that can be confidently wrong, and it announces itself.
 */
async function notesDirFor(values) {
  const explicit = values.workspace ?? process.env.AWT_WORKSPACE
  if (explicit) return namedWorkspace(explicit, values.workspace ? '-w' : '$AWT_WORKSPACE')
  const layout = await resolveLayout()
  if (layout) return layout.notesDir
  announceFallback()
  return process.cwd()
}

/**
 * A workspace someone named, or a refusal in the tool's own words.
 *
 * Unchecked, a `-w` naming a file or a directory that is not there travelled as
 * far as `readdir` and came back as node's `ENOTDIR: not a directory, scandir
 * '...'` through the generic catch in `awt.mjs` — the caller's mistake described
 * from inside the call it broke, with nothing in it naming the flag that caused
 * it. `parseErrorMessage` is the precedent and the reason: `-w` is on every
 * command that works on a wiki, so getting it wrong is a real question about the
 * tool rather than a typo, and it is worth answering as one.
 */
function namedWorkspace(path, source) {
  const dir = resolvePath(path)
  const refuse = (problem, sentence) => {
    const error = new Error(`${source} names ${dir}, which ${problem}. ${sentence}`)
    error.exitCode = 2
    throw error
  }
  if (!existsSync(dir)) refuse('is not there', 'It names the notes directory to work on.')
  if (!statSync(dir).isDirectory()) refuse('is a file', 'It names the notes directory, not a note inside it.')
  return dir
}

/**
 * Say that the notes are the current directory because nothing else said so.
 *
 * This is the finding the argument-surface audit came from. `awt check` run from
 * `/tmp`, with no project anywhere above it, reported *197 notes, 835 links, 62
 * problems* — every one of them a fixture left in half a dozen sessions'
 * scratchpads, and the report indistinguishable in shape from a real one. An
 * agent that runs a command from the wrong place gets no signal that it did.
 *
 * Once per process, on stderr, so `--json` on stdout stays a clean document, and
 * suppressible the way `warnLegacy` is.
 */
let announcedFallback = false
function announceFallback() {
  if (announcedFallback || process.env.AWT_QUIET_WORKSPACE) return
  announcedFallback = true
  process.stderr.write(
    `awt: no awt.config.mjs here or in any parent, so ${process.cwd()} is being read as a notes directory.\n` +
      '  Whatever markdown is under it is the wiki, and the answer will look exactly like a real one.\n' +
      '  Pass -w <notes>, or run this from inside the project. AWT_QUIET_WORKSPACE=1 silences this.\n',
  )
}

/** The whole layout, for the commands that need the site as well as the notes. */
async function layoutFor(command, values) {
  const layout = await resolveLayout()
  if (layout) return layout
  if (values.wiki && values.site) return null
  process.stderr.write(
    `awt ${command}: no awt.config.mjs here or in any parent, and no site/quartz.config.yaml either.\n` +
      '  Run this from inside the project, or pass --wiki and --site.\n',
  )
  return undefined
}

/**
 * **The short flags that exist, and nothing else may add one.**
 *
 * A short flag is earned by frequency across the whole tool, not by one command's
 * convenience — `-w` is on every command that works on a wiki and qualifies twice
 * over. `-q` is on one command and does not, but it is kept: removing it breaks
 * muscle memory to enforce a rule nobody is hurt by, and the rule it offends is
 * about *adding* the next one. Declaring the set is what makes that distinction
 * enforceable instead of a sentence in a note.
 *
 * `-c` went with `--check`, which it shortened. It was not removed on the short
 * flag's own account.
 *
 * A letter means the same thing everywhere, which is the other half of the test.
 */
export const SHORT_FLAGS = {w: 'workspace', q: 'quiet'}

/**
 * **Flags allowed to share a name with a command, and why. Currently none.**
 *
 * The rule is that they do not: `awt check` and `awt fmt --check` were unrelated
 * operations, and a reader who knew one learned the wrong thing about the other.
 * `--check` lived here for one release, while a `Stop` hook installed before the
 * rename still typed it; the install of 2026-09-11 replaced that hook and the flag
 * went. An empty register is the honest state, and it is kept rather than deleted
 * because it is where the next exception gets argued instead of smuggled.
 */
export const NAME_COLLISIONS = {}

/**
 * **Flags this campaign renamed, and what they are now.**
 *
 * Not deprecation — neither spelling still works — but an answer for the one
 * person or hook that types the old one. `parseErrorMessage` is the precedent:
 * node's text for an unknown option ends in advice about `--` that is right for
 * someone with a file called `--check` and wrong for everyone else. Entries come
 * out when nothing types them, the way `--check` itself came out of the register
 * above.
 */
export const RENAMED_FLAGS = {
  'fmt --check': '--dry-run',
  'site serve --wsPort': '--ws-port',
}

const WORKSPACE_OPTION = {workspace: {type: 'string', short: 'w'}}
const OUTPUT_OPTIONS = {json: {type: 'boolean', default: false}}
const SITE_OPTIONS = {wiki: {type: 'string'}, site: {type: 'string'}}

/**
 * The one group. A group is a namespace, not an alias — `awt serve` is gone, not
 * deprecated — and **its options are the definition of what it is**: `site`
 * inherits a flag family nothing else has, which is why the graph reads were left
 * flat. A group whose options are the tool's defaults would define nothing.
 *
 * `declines` is not academic: `site setup` acts on the site alone, and inheriting
 * a `--wiki` it would ignore breaks the rule that a command does not accept what
 * it cannot act on.
 */
export const GROUPS = [
  {
    name: 'site',
    summary: 'The rendered site: set it up, build it, serve it, feed it the index',
    options: SITE_OPTIONS,
    text: {
      wiki: "the notes to render (default: the project's rootDir/notes)",
      site: 'the Quartz clone to build in (default: rootDir/site)',
    },
  },
]

/** How a command is typed. The only place that knows groups nest. */
export function commandPath(command) {
  return command.group ? [command.group, command.name] : [command.name]
}

/** A command's own options, plus whatever its group hands down and it did not decline. */
export function optionsFor(command) {
  const group = GROUPS.find((entry) => entry.name === command.group)
  if (!group) return command.options ?? {}
  const inherited = Object.fromEntries(
    Object.entries(group.options).filter(([name]) => !command.declines?.includes(name)),
  )
  return {...inherited, ...(command.options ?? {})}
}

/** The order the sections are printed in, which is roughly the order of a day's work. */
export const SECTIONS = ['Ask', 'Change', 'Format', 'Publish', 'Agents']

/**
 * The options more than one command shares, described once.
 *
 * **A usage line names only what is particular to its command**, and the help
 * renderer appends whichever of these that command actually declares. Written by
 * hand into each usage string, they went three ways at once: `--workspace` shown by
 * four commands and omitted by the ten others that take it, `--json` by four of the
 * eleven, `--dry-run` by none of the seven. A usage line you cannot read as
 * complete is worse than a short one — it is what made `awt search --help` look
 * like evidence that `search` has no `-w`.
 */
export const COMMON_OPTIONS = [
  {
    name: 'workspace',
    flags: '-w, --workspace DIR',
    text: "the notes to work on (default: $AWT_WORKSPACE, else the project's rootDir/notes, else here)",
  },
  {name: 'json', flags: '    --json', text: 'JSON output'},
  {name: 'dry-run', flags: '    --dry-run', text: 'report what it would do, write nothing'},
]

function emit(values, value, human) {
  if (values.json) {
    process.stdout.write(`${JSON.stringify(value, null, 1)}\n`)
    return
  }
  // Nothing to say is said with nothing: `check --quiet` on a healthy wiki should
  // be silent, not a blank line for a script to strip.
  const text = human(value)
  if (text) process.stdout.write(`${text}\n`)
}

/**
 * What a formatting run came to, in one line.
 *
 * `fmt` is quiet by default, so a clean run prints nothing at all — and silence
 * reads as *it did nothing* rather than *there was nothing to do*. The counts are
 * what tell those apart, and they go **above** the report for the same reason
 * `check`'s verdict does: nothing else on this binary makes you read to the end to
 * find out whether it worked, and the end is what a `| head` throws away.
 */
function verdict({files, problems}, checking) {
  const counted = `${files} file${files === 1 ? '' : 's'}`
  // **Format mode used to drop `problems` on the floor**, so `awt fmt a.md
  // nowhere.md` answered "2 files formatted" with one of them not there — and
  // this line is deliberately above the report, so `| head -1` saw exactly the
  // sentence that was false. `--json` had `ok: false` and `problems: 1` all
  // along, which is the worst way round: the script could see it and the person
  // could not. The word is `processed` rather than `formatted` because a file
  // with a problem is one this did not format.
  if (problems) return `${counted} ${checking ? 'checked' : 'processed'}, ${problems} with problems`
  return checking ? `${counted} checked, all clean` : `${counted} formatted`
}

/** A verb's report, rendered for a person. The structured form is `--json`. */
function reportLines(report) {
  const lines = [`${report.verb}: ${report.ok ? 'ok' : 'incomplete'}${report.dryRun ? ' (dry run)' : ''}`]
  const list = (label, values) => {
    if (values?.length) lines.push(`  ${label}: ${values.join(', ')}`)
  }
  list('created', report.created)
  list('changed', report.changed)
  list('deleted', report.deleted)
  for (const entry of report.skipped ?? []) lines.push(`  SKIPPED ${entry.path}: ${entry.reason}`)
  for (const entry of report.unresolved ?? []) {
    lines.push(`  UNRESOLVED ${entry.from}:${entry.line} [[${entry.target}]]: ${entry.reason}`)
  }
  for (const note of report.notes ?? []) lines.push(`  note: ${note}`)
  // The code, where the verb gave one. A person scanning a refusal wants the
  // sentence; a person who then has to ask about it wants the name to ask under,
  // and `--json` is not the only place it should exist.
  if (report.code) lines.push(`  code: ${report.code}`)
  if (!report.ok) lines.push('  the verb can be re-run once the reason above is dealt with')
  return lines.join('\n')
}

/** A verb that refuses reports in the same shape as one that finished partially. */
async function runVerb(values, action) {
  // `human` is the one command whose report is not only a list of what changed:
  // `frontmatter` answers with a value. Every other verb leaves it unset and gets
  // the shape they all share.
  const human = values.human ?? reportLines
  try {
    const report = await action()
    emit(values, report, human)
    return report.ok ? 0 : 1
  } catch (error) {
    if (!error.report) throw error
    emit(values, error.report, reportLines)
    return 1
  }
}

/**
 * A `key=value` pair as typed, with the value read as YAML.
 *
 * `status=stable` is a string, `depth=2` a number, `tags=[a, b]` a list — the same
 * reading the note itself would get, which is the one a person typing into a
 * front-matter command expects. Anything YAML cannot parse is taken as the literal
 * string, so a value with a stray colon in it lands as what was typed rather than
 * as a refusal about YAML syntax.
 */
function pair(entry, flag) {
  const at = entry.indexOf('=')
  if (at < 1) {
    const error = new Error(`--${flag} takes key=value, and "${entry}" has no "=".`)
    error.exitCode = 2
    throw error
  }
  return {key: entry.slice(0, at), value: scalar(entry.slice(at + 1))}
}

function scalar(text) {
  try {
    const value = parseYaml(text)
    return value === null && text.trim() !== 'null' && text.trim() !== '~' && text.trim() !== '' ? text : value
  } catch {
    return text
  }
}

/**
 * A front-matter read, for a person: the value as YAML, which is what the note
 * itself says. `--json` hands back the whole report, `frontmatter` and all.
 *
 * A write is rendered by `reportLines` like every other verb's, so the two halves
 * of the one command do not print in two shapes.
 */
function frontmatterLines(report) {
  // `--validate` is a question, and its answer is the violations rather than a
  // list of what changed. A clean note says so in one line, because silence here
  // reads as "it did not run".
  if (report.violations && !('frontmatter' in report) && report.changed?.length === 0) {
    if (report.violations.length === 0) return 'valid'
    return ['invalid', ...report.violations.map((one) => `  ${one}`)].join('\n')
  }
  if (!('frontmatter' in report) || report.frontmatter === null) return reportLines(report)
  const value = report.frontmatter
  const text = typeof value === 'string' ? value : stringifyYaml(value).replace(/\n$/, '')
  return report.notes?.length ? [text, ...report.notes.map((note) => `  note: ${note}`)].join('\n') : text
}

/**
 * Write the toolbox index into the site, for a build that is about to run.
 *
 * It is emitted here rather than left to whoever runs the build, because the
 * shadow compares the rendered pages against it: an artifact one edit out of date
 * reports a disagreement that is not real, or an agreement that is not either.
 * Every command that starts a build goes through this, which is what stops the
 * two coming apart — the serve command people used to type by hand did not.
 *
 * Same resolution rule the build uses, so both find the same project from
 * anywhere inside it. Returns an exit code.
 */
async function emitIndexForSite(command, values) {
  const layout = await layoutFor(command, values)
  if (layout === undefined) return {code: 2}
  const wiki = values.wiki ? resolvePath(values.wiki) : layout.notesDir
  const site = values.site ? resolvePath(values.site) : layout.siteDir
  const workspace = loadWorkspace(wiki)
  const out = resolvePath(site, '.awt-index.json')
  writeIndexArtifact(workspace, out)
  const summary = indexSummary(workspace, out)
  // Publish and serve emit the index before they run, so this line is a step in
  // someone else's report. Under --json it would be a second document above the
  // first, which is the one thing a --json caller cannot be handed.
  if (!values.json) process.stdout.write(`index: ${summary.notes} notes, ${summary.links} links\n`)
  return {code: 0, ...summary}
}

/** What was written, the same four numbers whichever command asked for it. */
function indexSummary(workspace, out) {
  return {
    out,
    notes: workspace.resources.length,
    links: workspace.edges.length,
    placeholders: workspace.placeholders().length,
    ambiguous: workspace.ambiguities.length,
  }
}

export const COMMANDS = [
  {
    name: 'fmt',
    writes: true,
    section: 'Format',
    summary: "Format markdown in IntelliJ's style, inside a wiki or on a lone file",
    usage:
      'awt fmt [paths...] [--verbose]\n' +
      '       awt fmt --dry-run [paths...]\n' +
      '       awt fmt --stdin',
    positionals: 'any',
    notes: [
      'With -w, paths are relative to the notes directory. Without it, a path is tried against the',
      'current directory first and the notes directory second; --json reports which as `base`.',
      'With no path, no -w and no `files` in the config, the whole wiki is formatted.',
    ],
    options: {
      ...WORKSPACE_OPTION,
      ...OUTPUT_OPTIONS,
      'dry-run': {type: 'boolean', default: false},
      stdin: {type: 'boolean', default: false},
      verbose: {type: 'boolean', default: false},
    },
    /**
     * One command for both the standalone formatter and the wiki's, so `mdfmt` is
     * not a second binary. `--workspace` picks the wiki reading outright. Without
     * it a path is resolved against the cwd, then against the project's notes
     * directory; the config comes from the files named rather than from the cwd.
     */
    async run({values, positionals}) {
      const checking = values['dry-run']
      let cwd = process.cwd()
      let base = 'cwd'
      if (values.workspace) {
        cwd = await notesDirFor(values)
        base = 'workspace'
      } else if (positionals.length && !positionals.every((entry) => existsSync(resolvePath(cwd, entry)))) {
        const layout = await resolveLayout(cwd, {quiet: true})
        if (layout && positionals.every((entry) => existsSync(resolvePath(layout.notesDir, entry)))) {
          cwd = layout.notesDir
          base = 'notes'
        }
      }

      // A path that is not there is a typo, and it used to travel all the way to
      // remark and come back as `No such file or folder` wrapping node's
      // `ENOENT ... stat '<absolute path>'` — a syscall and a resolved path,
      // neither of which is what the person got wrong. Refused here instead, and
      // the whole call is refused rather than the rest formatted around it.
      //
      // **Only literal paths.** A glob and a directory are both legal inputs that
      // expand to files, and `existsSync` says no to a glob — so checking every
      // positional would refuse `awt fmt 'notes/*.md'`, which works today.
      if (!values.stdin) {
        const missing = positionals.filter(
          (entry) => !/[*?[\]{}]/.test(entry) && !existsSync(resolvePath(cwd, entry)),
        )
        if (missing.length > 0) {
          const error = new Error(
            `no file at ${missing.join(', ')}. Paths are relative to ${base === 'notes' ? 'the notes directory' : 'the current directory'}.`,
          )
          error.exitCode = 2
          throw error
        }
      }

      let config
      let configPath
      try {
        ;({config, filepath: configPath} = await resolveProjectConfig(
          values.workspace ? [] : positionals,
          cwd,
        ))
      } catch (error) {
        if (error.code !== AMBIGUOUS_CONFIG) throw error
        process.stderr.write(`awt fmt: ${error.message}\n`)
        return 2
      }

      // No path, no -w, no `files` in the config: inside a project, that means the
      // notes, as a bare `check` does.
      if (!positionals.length && !values.workspace && !config.files) {
        const layout = await resolveLayout(cwd, {quiet: true})
        if (layout) {
          cwd = layout.notesDir
          base = 'notes'
        }
      }

      if (values.stdin) {
        const {formatMarkdown} = await import('@agent-wiki-toolbox/format')
        const chunks = []
        for await (const chunk of process.stdin) chunks.push(chunk)
        const source = Buffer.concat(chunks).toString('utf8')
        const formatted = formatMarkdown(source, config)
        if (checking) return formatted === source ? 0 : 1
        process.stdout.write(formatted)
        return 0
      }
      // The report is collected rather than streamed so the verdict can go above
      // it, the way `check`'s does. Nothing else on this binary makes you read to
      // the end to find out whether it worked.
      // Under a rootDir layout the schema globs are read from the notes directory
      // (they say `meta/**`, not the layout again); a legacy or bare config keeps
      // its own directory as the base, which is what its globs were written for.
      const layout = configPath ? layoutFrom(config, configPath) : null
      const report = collectStream()
      const result = await runFormat({
        files: positionals,
        config,
        configPath,
        globBase: layout && !layout.legacy ? layout.notesDir : undefined,
        cwd,
        mode: checking ? 'check' : 'format',
        quiet: !values.verbose,
        streamError: report,
      })

      const text = report.text()
      if (values.json) {
        emit(values, {
          ok: result.code === 0,
          mode: checking ? 'check' : 'format',
          files: result.files,
          problems: result.problems,
          paths: positionals.length ? positionals : ['.'],
          base,
          baseDir: cwd,
          config: configPath ?? null,
          report: text.trimEnd() || null,
        })
        return result.code
      }
      if (result.code !== 2) process.stdout.write(`${verdict(result, checking)}\n`)
      if (text) process.stderr.write(text)
      return result.code
    },
  },
  {
    name: 'check',
    section: 'Ask',
    summary: 'Everything wrong with the link graph, in one call. Placeholders are reported separately and do not affect the exit code',
    usage: 'awt check [--quiet]',
    positionals: 0,
    options: {...WORKSPACE_OPTION, ...OUTPUT_OPTIONS, quiet: {type: 'boolean', short: 'q', default: false}},
    /**
     * **The verdict goes first.** It used to be the last line, under a first line
     * of counts that says nothing about health — so `awt check | head -1` printed
     * *"5 notes, 0 links, 0 placeholders, 5 orphans, 5 dead ends"* for a wiki with
     * two errors in it, and the pipeline threw the non-zero exit away on top. A
     * truncated report that reads as a clean one is the failure this command
     * exists to prevent, and truncating it is one keystroke away at all times.
     *
     * `--quiet` prints the problems and nothing else, so silence means healthy and
     * the exit code carries the answer.
     */
    async run({values}) {
      const health = check(loadWorkspace(await notesDirFor(values)))
      emit(values, health, (value) => {
        const problems = value.problems.map(
          (problem) => `  ${problem.severity} ${problem.path}:${problem.line} [${problem.rule}] ${problem.message}`,
        )
        if (values.quiet) return problems.join('\n')

        const verdict = value.healthy ? 'graph is healthy' : `${value.problems.length} problem(s)`
        const counts =
          `${value.notes} notes, ${value.links} links, ${value.placeholders.length} placeholders, ` +
          `${value.orphans.length} orphans, ${value.deadends.length} dead ends`
        return [`${verdict}; ${counts}`, ...problems].join('\n')
      })
      return health.healthy ? 0 : 1
    },
  },
  {
    name: 'search',
    section: 'Ask',
    summary: 'Search note bodies, titles, front matter and tags in one pass',
    usage:
      'awt search <query...> [--tag t] [--type t] [--area a] [--topic t]\n' +
      '             [--fields text,title,tags,properties] [--limit n]',
    positionals: 'any',
    options: {
      ...WORKSPACE_OPTION,
      ...OUTPUT_OPTIONS,
      tag: {type: 'string'},
      type: {type: 'string'},
      area: {type: 'string'},
      topic: {type: 'string'},
      fields: {type: 'string'},
      limit: {type: 'string'},
    },
    /**
     * **The footer is not decoration.** The search caps at 20 by default, the
     * envelope has recorded `total` and `truncated` from the start, and this
     * renderer printed neither — so `awt search the` listed 20 of 73 notes, said
     * nothing, and exited 0. Every `--json` caller could see it and every person
     * and agent reading the text could not, which is the worst way round.
     */
    async run({values, positionals}) {
      const found = search(loadWorkspace(await notesDirFor(values)), {
        query: positionals.join(' ') || undefined,
        tag: values.tag,
        type: values.type,
        area: values.area,
        topic: values.topic,
        fields: values.fields?.split(','),
        limit: values.limit ? Number(values.limit) : undefined,
      })
      emit(values, found, (value) => {
        if (!value.results.length) return 'no matches'
        const lines = value.results.map((entry) =>
          [`${entry.path}`, ...entry.matches.map((m) => `  ${m.line}: ${m.text}`)].join('\n'),
        )
        if (value.truncated) {
          lines.push(`… ${value.total - value.results.length} more not shown; --limit ${value.total} for all of them`)
        }
        return lines.join('\n')
      })
      return found.total > 0 ? 0 : 1
    },
  },
  {
    name: 'connections',
    section: 'Ask',
    summary: 'Links out of and into a note, optionally several hops out',
    usage: 'awt connections <path> [--depth n] [--direction in|out|both]',
    positionals: 1,
    options: {...WORKSPACE_OPTION, ...OUTPUT_OPTIONS, depth: {type: 'string'}, direction: {type: 'string'}},
    async run({values, positionals}) {
      const result = connections(loadWorkspace(await notesDirFor(values)), {
        path: positionals[0],
        depth: values.depth ? Number(values.depth) : undefined,
        direction: values.direction,
      })
      // The miss is reported before anything is read off the hit. Destructuring
      // `links` first turned "no note at conventions" — the sentence that says
      // what went wrong — into a TypeError, on the human surface only: `--json`
      // and the MCP tool were handing back the error all along.
      emit(values, result, (value) =>
        value.error
          ? value.error
          : [
              `${value.path}: ${value.title}`,
              `  links:     ${value.links.map((e) => e.path).join(', ') || 'none'}`,
              `  backlinks: ${value.backlinks.map((e) => e.path).join(', ') || 'none'}`,
            ].join('\n'),
      )
      return result.error ? 1 : 0
    },
  },
  {
    name: 'resolve',
    section: 'Ask',
    summary: 'What a link points at, and what else matched when it is ambiguous',
    usage: 'awt resolve <target> [--from note.md]',
    positionals: 1,
    options: {...WORKSPACE_OPTION, ...OUTPUT_OPTIONS, from: {type: 'string'}},
    async run({values, positionals}) {
      const outcome = resolveLink(loadWorkspace(await notesDirFor(values)), {
        target: positionals[0],
        from: values.from,
      })
      emit(values, outcome, (value) =>
        [
          `${value.target} → ${value.status}${value.path ? ` ${value.path}` : ''}`,
          value.candidates?.length ? `  candidates: ${value.candidates.join(', ')}` : '',
          value.anchor ? `  anchor #${value.anchor.name}: ${value.anchor.status}` : '',
          value.note ? `  ${value.note}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      )
      return outcome.status === 'resolved' || outcome.status === 'crossWiki' ? 0 : 1
    },
  },
  {
    name: 'move',
    writes: true,
    section: 'Change',
    summary: 'Move or rename a note, rewriting every link into it',
    usage: 'awt move <from> <to>',
    positionals: 2,
    notes: [
      'A destination with no folder in it stays in the source\'s own, so <to> is either a new name',
      'or a new path. There was a separate `rename` for the first of those; move.js calls the two',
      '"the same operation, named for the two intents", so the CLI shows one and the library keeps',
      'both. The MCP surface, which does not nest, keeps rename as its own tool.',
    ],
    options: {...WORKSPACE_OPTION, ...OUTPUT_OPTIONS, 'dry-run': {type: 'boolean', default: false}},
    async run({values, positionals}) {
      const [from, to] = positionals
      return runVerb(values, async () => {
        const notesDir = await notesDirFor(values)
        return to && !to.includes('/')
          ? renameNote(notesDir, {path: from, name: to, dryRun: values['dry-run']})
          : moveNote(notesDir, {from, to, dryRun: values['dry-run']})
      })
    },
  },
  {
    name: 'delete',
    writes: true,
    section: 'Change',
    summary: 'Delete a note. Links into it are reported, not rewritten',
    usage: 'awt delete <path>',
    positionals: 1,
    options: {...WORKSPACE_OPTION, ...OUTPUT_OPTIONS, 'dry-run': {type: 'boolean', default: false}},
    async run({values, positionals}) {
      return runVerb(values, async () =>
        deleteNote(await notesDirFor(values), {path: positionals[0], dryRun: values['dry-run']}),
      )
    },
  },
  {
    name: 'split',
    writes: true,
    section: 'Change',
    summary: 'Split a note into several, one per heading named in the plan',
    usage:
      'awt split <path> --source delete|stub|keep \\\n' +
      '         --section "Heading=target/path.md" [--section ...]',
    positionals: 1,
    options: {
      ...WORKSPACE_OPTION,
      ...OUTPUT_OPTIONS,
      section: {type: 'string', multiple: true},
      source: {type: 'string'},
      'dry-run': {type: 'boolean', default: false},
    },
    async run({values, positionals}) {
      const plan = (values.section ?? []).map((entry) => {
        const at = entry.indexOf('=')
        return {heading: entry.slice(0, at), path: entry.slice(at + 1)}
      })
      return runVerb(values, async () =>
        splitByHeading(await notesDirFor(values), {
          path: positionals[0],
          plan,
          source: values.source,
          dryRun: values['dry-run'],
        }),
      )
    },
  },
  {
    name: 'merge',
    writes: true,
    section: 'Change',
    summary: 'Merge notes into one, each as a section under its own title, repointing every link into them',
    usage: 'awt merge <source...> --into <path> --source delete|keep [--depth n]',
    positionals: 'any',
    options: {
      ...WORKSPACE_OPTION,
      ...OUTPUT_OPTIONS,
      into: {type: 'string'},
      source: {type: 'string'},
      depth: {type: 'string'},
      'dry-run': {type: 'boolean', default: false},
    },
    async run({values, positionals}) {
      return runVerb(values, async () =>
        mergeFiles(await notesDirFor(values), {
          sources: positionals,
          into: values.into,
          source: values.source,
          depth: values.depth ? Number(values.depth) : undefined,
          dryRun: values['dry-run'],
        }),
      )
    },
  },
  {
    name: 'rename-tag',
    writes: true,
    section: 'Change',
    summary: 'Rename a front-matter tag everywhere it appears',
    usage: 'awt rename-tag <from> <to>',
    positionals: 2,
    options: {...WORKSPACE_OPTION, ...OUTPUT_OPTIONS, 'dry-run': {type: 'boolean', default: false}},
    async run({values, positionals}) {
      return runVerb(values, async () =>
        renameTag(await notesDirFor(values), {from: positionals[0], to: positionals[1], dryRun: values['dry-run']}),
      )
    },
  },
  {
    name: 'frontmatter',
    writes: true,
    section: 'Change',
    summary: "Read or write a note's front matter: the whole block, or one key",
    usage:
      'awt frontmatter <path>\n' +
      '       awt frontmatter <path> --validate\n' +
      '       awt frontmatter <path> --get KEY | --set KEY=VALUE | --unset KEY\n' +
      '       awt frontmatter <path> --rename OLD=NEW | --append KEY=VALUE | --prepend KEY=VALUE\n' +
      '       awt frontmatter <path> --replace-block --derived < block.yaml',
    positionals: 1,
    notes: [
      'With no operation flag it prints the whole block. Exactly one operation per call.',
      'A value is read as YAML, so --set depth=2 is a number and --set tags=[a, b] is a list.',
      '--append and --prepend take a sequence-valued key: tags, sources. A key that is not there is',
      'created holding the one item; a key holding a scalar is refused, because that is a typo.',
      "--unset drops a key. It is not spelled --delete because `awt delete` deletes a note, and one",
      'word meaning two things a command apart is how a flag gets typed at the wrong thing.',
      '--rename moves a key and leaves its value where it is.',
      '',
      'Every write is checked against the schema for that path, and a violation is reported beside the',
      'write rather than refusing it: one write is not the unit a schema applies to, and a migration',
      'passes through states no schema accepts on its way to one it does. --validate asks the same',
      'question on its own and exits non-zero when the note does not satisfy its schema.',
      '--replace-block reserialises the whole block, losing comments, quoting and flow sequences, so',
      'it is for front matter the toolbox owns and --derived is how you say so. It reads the object',
      'from stdin rather than argv, which is where markdown and YAML belong.',
      '',
      'The markdown body is a separate domain and is not reachable from this command.',
    ],
    options: {
      ...WORKSPACE_OPTION,
      ...OUTPUT_OPTIONS,
      validate: {type: 'boolean', default: false},
      get: {type: 'string'},
      set: {type: 'string'},
      unset: {type: 'string'},
      rename: {type: 'string'},
      append: {type: 'string'},
      prepend: {type: 'string'},
      'replace-block': {type: 'boolean', default: false},
      derived: {type: 'boolean', default: false},
      'dry-run': {type: 'boolean', default: false},
    },
    /**
     * One flag per operation, rather than `--operation replace --scope content`.
     * The axes are the library's and the MCP surface's, where a caller is a
     * program; a person types the pair, and `--set status=stable` is the pair.
     */
    async run({values, positionals}) {
      // Two operations in one call is a typo with two plausible readings, and
      // picking either silently is the failure this whole tool exists to remove.
      const asked = ['validate', 'get', 'set', 'unset', 'rename', 'append', 'prepend', 'replace-block'].filter(
        (flag) => values[flag] !== undefined && values[flag] !== false,
      )
      if (asked.length > 1) {
        const error = new Error(`one operation per call, and this asks for ${asked.map((flag) => `--${flag}`).join(' and ')}.`)
        error.exitCode = 2
        throw error
      }

      const call = {path: positionals[0], dryRun: values['dry-run']}
      const [flag] = asked

      if (flag === 'validate') Object.assign(call, {operation: 'validate', scope: 'block'})
      else if (flag === 'get') Object.assign(call, {operation: 'read', scope: 'content', key: values.get})
      else if (flag === 'unset') Object.assign(call, {operation: 'delete', scope: 'content', key: values.unset})
      else if (flag === 'set') Object.assign(call, {operation: 'replace', scope: 'content', ...pair(values.set, 'set')})
      else if (flag === 'append') Object.assign(call, {operation: 'append', scope: 'content', ...pair(values.append, 'append')})
      else if (flag === 'prepend') Object.assign(call, {operation: 'prepend', scope: 'content', ...pair(values.prepend, 'prepend')})
      else if (flag === 'rename') {
        const {key, value} = pair(values.rename, 'rename')
        Object.assign(call, {operation: 'replace', scope: 'marker', key, value: String(value)})
      } else if (flag === 'replace-block') {
        const chunks = []
        for await (const chunk of process.stdin) chunks.push(chunk)
        const text = Buffer.concat(chunks).toString('utf8')
        let block
        try {
          block = parseYaml(text)
        } catch (error) {
          const refusal = new Error(`stdin is not YAML: ${error.message}`)
          refusal.exitCode = 2
          throw refusal
        }
        Object.assign(call, {operation: 'replace', scope: 'block', value: block, derived: values.derived})
      } else Object.assign(call, {operation: 'read', scope: 'block'})

      return runVerb({...values, human: frontmatterLines}, async () =>
        frontmatter(await notesDirFor(values), call),
      )
    },
  },
  {
    name: 'listing',
    writes: true,
    section: 'Change',
    summary: 'Regenerate the notes listing between its markers in the wiki index. Text outside the markers is not touched',
    usage: 'awt listing [--path index.md] [--columns note,about]',
    positionals: 0,
    notes: ['--columns defaults to note,about; topic and area are the other columns.'],
    options: {
      ...WORKSPACE_OPTION,
      ...OUTPUT_OPTIONS,
      path: {type: 'string'},
      columns: {type: 'string'},
      'dry-run': {type: 'boolean', default: false},
    },
    async run({values}) {
      return runVerb(values, async () =>
        buildListing(await notesDirFor(values), {
          path: values.path,
          columns: values.columns?.split(','),
          dryRun: values['dry-run'],
        }),
      )
    },
  },
  {
    name: 'setup',
    group: 'site',
    section: 'Publish',
    declines: ['wiki'],
    summary: 'Set up (or re-pin) the Quartz clone a site builds from, and link the toolbox plugins into it',
    usage: 'awt site setup [--site path] [--force]',
    positionals: 0,
    notes: [
      "Runs from anywhere inside the project: the site is <rootDir>/site, with rootDir from the project's",
      'awt.config.mjs (default wiki/). --site names another one, resolved against the cwd.',
    ],
    options: {...OUTPUT_OPTIONS, force: {type: 'boolean', default: false}},
    async run({values}) {
      const {bootstrap} = await import('@agent-wiki-toolbox/publish')
      const layout = values.site ? null : await resolveLayout()
      const site = values.site ?? layout?.siteDir
      if (!site) {
        process.stderr.write(
          'awt site setup: no awt.config.mjs here or in any parent, and no site/quartz.config.yaml either.\n' +
            '  Run this from inside the project, or pass --site.\n',
        )
        return 2
      }
      return bootstrap([
        '--site',
        site,
        ...(values.force ? ['--force'] : []),
        ...(values.json ? ['--json'] : []),
      ])
    },
  },
  {
    name: 'publish',
    group: 'site',
    section: 'Publish',
    summary: 'Build the site into a release, or a handoff copy with --offline. Emits the index first',
    usage:
      'awt site publish [--out path] [--offline] [--diagrams png|none]\n' +
      '                 [--nginx] [--skip-index]',
    positionals: 0,
    notes: [
      'Builds without --serve, so cross-wiki links resolve to published URLs, into a staging',
      'directory, then renames it into place. A failed build leaves the standing release untouched.',
      'The release it replaces is kept as .release-prev; a rollback is a rename.',
      '',
      '--offline builds a handoff copy into site/handoff instead: browser-only plugins off, every',
      'link rewritten to a .html file, every script removed. It opens from index.html with no server.',
      '',
      'Mermaid diagrams are pre-rendered to PNG for --offline; --diagrams none leaves them as source',
      'text. A served site draws them in the browser.',
      '',
      '--nginx prints a server block for the release and exits without building.',
    ],
    options: {
      ...OUTPUT_OPTIONS,
      out: {type: 'string'},
      offline: {type: 'boolean', default: false},
      diagrams: {type: 'string'},
      nginx: {type: 'boolean', default: false},
      'skip-index': {type: 'boolean', default: false},
    },
    async run({values}) {
      const {publish} = await import('@agent-wiki-toolbox/publish')

      if (!values.nginx && !values['skip-index']) {
        const {code} = await emitIndexForSite('publish', values)
        if (code !== 0) return code
      }

      // Both paths always handed over, resolved here: `publish` may not reach
      // `format`, which owns the layout, so its own walk is the legacy one.
      const layout = await layoutFor('publish', values)
      if (layout === undefined) return 2
      return publish([
        '--wiki',
        values.wiki ?? layout.notesDir,
        '--site',
        values.site ?? layout.siteDir,
        ...(values.out ? ['--out', values.out] : []),
        ...(values.offline ? ['--offline'] : []),
        ...(values.diagrams ? ['--diagrams', values.diagrams] : []),
        ...(values.nginx ? ['--nginx'] : []),
        ...(values.json ? ['--json'] : []),
      ])
    },
  },
  {
    name: 'serve',
    server: true,
    group: 'site',
    section: 'Publish',
    summary: "Emit the index and run Quartz's dev server over the wiki. Ports come from awt.config.mjs",
    usage: 'awt site serve [--out path] [--port N] [--ws-port N] [--skip-index]',
    positionals: 0,
    notes: [
      "Emits the link-graph index, then runs Quartz's dev server over the wiki. The awt-links",
      'plugin compares the rendered pages against that index.',
      '',
      "Ports come from `serve` in the project's awt.config.mjs:",
      '',
      '    export default {serve: {port: 8101}}',
      '',
      '--ws-port defaults to the port plus 100. Runs from anywhere inside the project.',
      'The config key stays `serve: {wsPort}` — that is a JS object, where camelCase is right.',
    ],
    options: {
      out: {type: 'string'},
      port: {type: 'string'},
      'ws-port': {type: 'string'},
      'skip-index': {type: 'boolean', default: false},
    },
    async run({values}) {
      const {serve} = await import('@agent-wiki-toolbox/publish')

      if (!values['skip-index']) {
        const {code} = await emitIndexForSite('serve', values)
        if (code !== 0) return code
      }

      // Config discovery belongs to `format`, and `publish` may not reach it — so
      // the layout and the ports are read here, where both are in scope, and
      // handed over as explicit paths. The config is the project's, found by
      // walking up, so `awt site serve` finds the same project the build does no
      // matter where in it you are standing.
      const layout = await layoutFor('serve', values)
      if (layout === undefined) return 2
      const {config} = await loadProjectConfig(layout?.projectDir ?? process.cwd())
      const ports = config.serve ?? {}

      return serve([
        '--wiki',
        values.wiki ?? layout.notesDir,
        '--site',
        values.site ?? layout.siteDir,
        ...(values.out ? ['--out', values.out] : []),
        ...(values.port ? ['--port', values.port] : []),
        ...(values['ws-port'] ? ['--ws-port', values['ws-port']] : []),
        ...(ports.port === undefined ? [] : ['--configPort', String(ports.port)]),
        ...(ports.wsPort === undefined ? [] : ['--configWsPort', String(ports.wsPort)]),
      ])
    },
  },
  {
    name: 'index',
    group: 'site',
    section: 'Publish',
    summary: 'Write the link-graph index the Quartz plugins read, into the site or to --out',
    usage: 'awt site index [--out path.json]',
    positionals: 0,
    notes: [
      'With no --out it writes <site>/.awt-index.json, which is where the build looks and what',
      'publish and serve emit before they run. It is grouped here because that file is read by the',
      'three Quartz plugins and by nothing else — it is not the graph offered as data.',
      '',
      '--out names another file and needs no site, for looking at the graph directly.',
    ],
    options: {...OUTPUT_OPTIONS, out: {type: 'string'}},
    async run({values}) {
      if (!values.out) {
        const {code, ...summary} = await emitIndexForSite('site index', values)
        if (code === 0 && values.json) emit(values, {ok: true, ...summary})
        return code
      }
      // --out asks for the graph as a file, which no site has to exist for.
      const layout = await resolveLayout()
      const root = values.wiki ? resolvePath(values.wiki) : (layout?.notesDir ?? process.cwd())
      const workspace = loadWorkspace(root)
      const out = resolvePath(values.out)
      // mkdir's own ENOENT names the parent and not the flag that chose it, and
      // an --out whose directory is not there is a typo rather than a request to
      // build a tree.
      if (!existsSync(dirname(out))) {
        const error = new Error(`--out names ${out}, and ${dirname(out)} is not there.`)
        error.exitCode = 2
        throw error
      }
      writeIndexArtifact(workspace, out)
      const summary = indexSummary(workspace, out)
      emit(values, {ok: true, ...summary}, (value) =>
        `${values.out}: ${value.notes} notes, ${value.links} links, ` +
          `${value.placeholders} placeholders, ${value.ambiguous} ambiguous`,
      )
      return 0
    },
  },
  {
    name: 'mcp',
    server: true,
    section: 'Agents',
    summary: 'Run the MCP server over stdio, for an agent to talk to',
    usage: 'awt mcp [--allow-writes] [--name n]',
    positionals: 0,
    notes: [
      "With no -w the notes are the project's rootDir/notes, rootDir defaulting to wiki/, so an",
      '.mcp.json entry is `awt mcp --allow-writes` with no path. Without --allow-writes the server',
      'serves the read tools and fmt with dryRun only.',
    ],
    options: {...WORKSPACE_OPTION, 'allow-writes': {type: 'boolean', default: false}, name: {type: 'string'}},
    async run({values}) {
      const {createServer, projectTarget} = await import('@agent-wiki-toolbox/mcp')
      const {StdioServerTransport} = await import('@modelcontextprotocol/sdk/server/stdio.js')
      // The same refusal every other command gets: a server started over a path
      // that is not a directory would otherwise fail on its first tool call,
      // where the agent reads it as the wiki being broken.
      const named = values.workspace ?? process.env.AWT_WORKSPACE
      const explicit = named ? namedWorkspace(named, values.workspace ? '-w' : '$AWT_WORKSPACE') : null
      const server = createServer({
        ...(explicit ? {notesDir: explicit} : {resolveTarget: () => projectTarget()}),
        allowWrites: values['allow-writes'],
        name: values.name,
      })
      await server.connect(new StdioServerTransport())
      return null // stays up until the transport closes
    },
  },
]

export function version() {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  let stamp = ''
  try {
    stamp = readFileSync(new URL('../../../INSTALLED_FROM', import.meta.url), 'utf8').trim()
  } catch {
    stamp = 'working copy'
  }
  return `awt ${manifest.version} (${stamp})`
}
