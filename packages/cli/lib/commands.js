/**
 * Every operation the toolbox has, as one subcommand of the one binary. Names are
 * `splitByHeading` in the library, `split_by_heading` on the MCP surface and
 * `split` here.
 *
 * A command is data: a name, one line of summary, a usage string, an option map for
 * `parseArgs`, and a `run`. `awt --help` is generated from that list, so every
 * command is listed. Two optional fields shape the surface rather than the call:
 * `group` puts a command under a `GROUPS` entry and it is then invoked as
 * `awt <group> <name>`, and `section` is the heading it is listed under.
 *
 * The CLI is not a mirror of the packages. `move` here is `moveNote` or
 * `renameNote` depending on its destination, `site index` is a `core` function
 * grouped by what consumes it, and the MCP surface stays flat with its own names.
 */
import {existsSync, readFileSync} from 'node:fs'
import {resolve as resolvePath} from 'node:path'
import process from 'node:process'

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
 * A bare directory with no project around it means itself.
 */
async function notesDirFor(values) {
  const explicit = values.workspace ?? process.env.AWT_WORKSPACE
  if (explicit) return resolvePath(explicit)
  const layout = await resolveLayout()
  return layout?.notesDir ?? process.cwd()
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
  if (!checking) return `${counted} formatted`
  return problems ? `${counted} checked, ${problems} with problems` : `${counted} checked, all clean`
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
  if (!report.ok) lines.push('  the verb can be re-run once the reason above is dealt with')
  return lines.join('\n')
}

/** A verb that refuses reports in the same shape as one that finished partially. */
async function runVerb(values, action) {
  try {
    const report = await action()
    emit(values, report, reportLines)
    return report.ok ? 0 : 1
  } catch (error) {
    if (!error.report) throw error
    emit(values, error.report, reportLines)
    return 1
  }
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
  if (layout === undefined) return 2
  const wiki = values.wiki ? resolvePath(values.wiki) : layout.notesDir
  const site = values.site ? resolvePath(values.site) : layout.siteDir
  const workspace = loadWorkspace(wiki)
  writeIndexArtifact(workspace, resolvePath(site, '.awt-index.json'))
  process.stdout.write(`index: ${workspace.resources.length} notes, ${workspace.edges.length} links\n`)
  return 0
}

export const COMMANDS = [
  {
    name: 'fmt',
    section: 'Format',
    summary: "Format markdown in IntelliJ's style, inside a wiki or on a lone file",
    usage:
      'awt fmt [paths...] [--verbose]\n' +
      '       awt fmt --check [paths...]\n' +
      '       awt fmt --stdin',
    notes: [
      'With -w, paths are relative to the notes directory. Without it, a path is tried against the',
      'current directory first and the notes directory second; --json reports which as `base`.',
      'With no path, no -w and no `files` in the config, the whole wiki is formatted.',
    ],
    options: {
      ...WORKSPACE_OPTION,
      ...OUTPUT_OPTIONS,
      check: {type: 'boolean', short: 'c', default: false},
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
        if (values.check) return formatted === source ? 0 : 1
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
        mode: values.check ? 'check' : 'format',
        quiet: !values.verbose,
        streamError: report,
      })

      const text = report.text()
      if (values.json) {
        emit(values, {
          ok: result.code === 0,
          mode: values.check ? 'check' : 'format',
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
      if (result.code !== 2) process.stdout.write(`${verdict(result, values.check)}\n`)
      if (text) process.stderr.write(text)
      return result.code
    },
  },
  {
    name: 'check',
    section: 'Ask',
    summary: 'Everything wrong with the link graph, in one call. Placeholders are reported separately and do not affect the exit code',
    usage: 'awt check [--quiet]',
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
      'awt search <query> [--tag t] [--type t] [--area a] [--topic t]\n' +
      '             [--fields text,title,tags,properties] [--limit n]',
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
    section: 'Change',
    summary: 'Move or rename a note, rewriting every link into it',
    usage: 'awt move <from> <to>',
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
    section: 'Change',
    summary: 'Delete a note. Links into it are reported, not rewritten',
    usage: 'awt delete <path>',
    options: {...WORKSPACE_OPTION, ...OUTPUT_OPTIONS, 'dry-run': {type: 'boolean', default: false}},
    async run({values, positionals}) {
      return runVerb(values, async () =>
        deleteNote(await notesDirFor(values), {path: positionals[0], dryRun: values['dry-run']}),
      )
    },
  },
  {
    name: 'split',
    section: 'Change',
    summary: 'Split a note into several, one per heading named in the plan',
    usage:
      'awt split <path> --source delete|stub|keep \\\n' +
      '         --section "Heading=target/path.md" [--section ...]',
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
    section: 'Change',
    summary: 'Merge notes into one, each as a section under its own title, repointing every link into them',
    usage: 'awt merge <source...> --into <path> --source delete|keep [--depth n]',
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
    section: 'Change',
    summary: 'Rename a front-matter tag everywhere it appears',
    usage: 'awt rename-tag <from> <to>',
    options: {...WORKSPACE_OPTION, ...OUTPUT_OPTIONS, 'dry-run': {type: 'boolean', default: false}},
    async run({values, positionals}) {
      return runVerb(values, async () =>
        renameTag(await notesDirFor(values), {from: positionals[0], to: positionals[1], dryRun: values['dry-run']}),
      )
    },
  },
  {
    name: 'listing',
    section: 'Change',
    summary: 'Regenerate the notes listing between its markers in the wiki index. Text outside the markers is not touched',
    usage: 'awt listing [--path index.md] [--columns note,about]',
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
    notes: [
      "Runs from anywhere inside the project: the site is <rootDir>/site, with rootDir from the project's",
      'awt.config.mjs (default wiki/). --site names another one, resolved against the cwd.',
    ],
    options: {force: {type: 'boolean', default: false}},
    async run({values, positionals}) {
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
        ...positionals,
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
      out: {type: 'string'},
      offline: {type: 'boolean', default: false},
      diagrams: {type: 'string'},
      nginx: {type: 'boolean', default: false},
      'skip-index': {type: 'boolean', default: false},
    },
    async run({values}) {
      const {publish} = await import('@agent-wiki-toolbox/publish')

      if (!values.nginx && !values['skip-index']) {
        const code = await emitIndexForSite('publish', values)
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
      ])
    },
  },
  {
    name: 'serve',
    group: 'site',
    section: 'Publish',
    summary: "Emit the index and run Quartz's dev server over the wiki. Ports come from awt.config.mjs",
    usage: 'awt site serve [--out path] [--port N] [--wsPort N] [--skip-index]',
    notes: [
      "Emits the link-graph index, then runs Quartz's dev server over the wiki. The awt-links",
      'plugin compares the rendered pages against that index.',
      '',
      "Ports come from `serve` in the project's awt.config.mjs:",
      '',
      '    export default {serve: {port: 8101}}',
      '',
      '--wsPort defaults to the port plus 100. Runs from anywhere inside the project.',
    ],
    options: {
      out: {type: 'string'},
      port: {type: 'string'},
      wsPort: {type: 'string'},
      'skip-index': {type: 'boolean', default: false},
    },
    async run({values}) {
      const {serve} = await import('@agent-wiki-toolbox/publish')

      if (!values['skip-index']) {
        const code = await emitIndexForSite('serve', values)
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
        ...(values.wsPort ? ['--wsPort', values.wsPort] : []),
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
    notes: [
      'With no --out it writes <site>/.awt-index.json, which is where the build looks and what',
      'publish and serve emit before they run. It is grouped here because that file is read by the',
      'three Quartz plugins and by nothing else — it is not the graph offered as data.',
      '',
      '--out names another file and needs no site, for looking at the graph directly.',
    ],
    options: {out: {type: 'string'}},
    async run({values}) {
      if (!values.out) return emitIndexForSite('site index', values)
      // --out asks for the graph as a file, which no site has to exist for.
      const layout = await resolveLayout()
      const root = values.wiki ? resolvePath(values.wiki) : (layout?.notesDir ?? process.cwd())
      const workspace = loadWorkspace(root)
      const artifact = writeIndexArtifact(workspace, resolvePath(values.out))
      process.stdout.write(
        `${values.out}: ${Object.keys(artifact.pages).length} notes, ${workspace.edges.length} links, ` +
          `${workspace.placeholders().length} placeholders, ${workspace.ambiguities.length} ambiguous\n`,
      )
      return 0
    },
  },
  {
    name: 'mcp',
    section: 'Agents',
    summary: 'Run the MCP server over stdio, for an agent to talk to',
    usage: 'awt mcp [--allow-writes] [--name n]',
    notes: [
      "With no -w the notes are the project's rootDir/notes, rootDir defaulting to wiki/, so an",
      '.mcp.json entry is `awt mcp --allow-writes` with no path. Without --allow-writes the server',
      'serves the read tools and fmt with dryRun only.',
    ],
    options: {...WORKSPACE_OPTION, 'allow-writes': {type: 'boolean', default: false}, name: {type: 'string'}},
    async run({values}) {
      const {createServer, projectTarget} = await import('@agent-wiki-toolbox/mcp')
      const {StdioServerTransport} = await import('@modelcontextprotocol/sdk/server/stdio.js')
      const explicit = values.workspace ?? process.env.AWT_WORKSPACE
      const server = createServer({
        ...(explicit ? {notesDir: resolvePath(explicit)} : {resolveTarget: () => projectTarget()}),
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
