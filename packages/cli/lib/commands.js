/**
 * Every operation the toolbox has, as one subcommand each.
 *
 * [[toolbox-decisions]] 22: **one binary, and everything hangs off it.** The package
 * split is unaffected — the constraint is on the dependency graph, not on how many
 * things end up on `PATH`. Decision 16 fixes the casing: `splitByHeading` in the
 * library, `split_by_heading` on the MCP surface, `split-by-heading` here.
 *
 * A command is data: a name, one line of summary, a usage string, an option map for
 * `parseArgs`, and a `run`. `awt --help` is generated from that list, which is what
 * makes decision 26's acceptance test — *`awt --help` alone is enough to find every
 * operation* — hold by construction rather than by discipline.
 */
import {readFileSync} from 'node:fs'
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
 * project's own layout, else here.
 *
 * The third step is what lets `awt check` run from a repo root and mean the wiki
 * rather than every markdown file in the repo: the nearest `awt.config.mjs` names
 * the home and the notes are a fixed name inside it ([[toolbox-decisions]] 38). A
 * bare directory with no project around it still means itself, which is what every
 * test and every one-off run over a scratch wiki relies on.
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
    note: 'publish, serve and bootstrap-quartz name a wiki and a site separately',
  },
  {name: 'json', flags: '    --json', text: 'structured output, for a program rather than a person'},
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
  for (const entry of report.skipped ?? []) lines.push(`  SKIPPED ${entry.path} — ${entry.reason}`)
  for (const entry of report.unresolved ?? []) {
    lines.push(`  UNRESOLVED ${entry.from}:${entry.line} [[${entry.target}]] — ${entry.reason}`)
  }
  for (const note of report.notes ?? []) lines.push(`  note: ${note}`)
  if (!report.ok) lines.push('  re-run when the reason above is dealt with; every verb is re-runnable')
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
    summary: 'Format markdown the way IntelliJ formats it. Works on a lone file with no wiki in sight',
    usage:
      'awt fmt [paths...] [--verbose]\n' +
      '       awt fmt --check [paths...]\n' +
      '       awt fmt --stdin',
    options: {
      ...WORKSPACE_OPTION,
      check: {type: 'boolean', short: 'c', default: false},
      stdin: {type: 'boolean', default: false},
      verbose: {type: 'boolean', default: false},
    },
    /**
     * Two jobs, one command — decision 17, which put the standalone formatter and
     * the wiki's on the same binary so `mdfmt` is not a second thing to reach for.
     * `--workspace` is which of them you are doing:
     *
     * **With it**, paths are the wiki's own — `meta/conventions.md`, the form every
     * other subcommand and the whole MCP surface take — the config is the wiki's
     * whatever directory the shell is in, and no path means the whole wiki. It was
     * the one command on this binary that did not take `-w`, so an agent holding a
     * note path had to translate it and then got the wrong config for its trouble.
     *
     * **Without it**, this is still the lone-`CLAUDE.md` formatter with no wiki in
     * sight, and the config comes from the files named rather than from the cwd.
     */
    async run({values, positionals}) {
      const cwd = values.workspace ? await notesDirFor(values) : process.cwd()

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

      if (result.code !== 2) process.stdout.write(`${verdict(result, values.check)}\n`)
      const text = report.text()
      if (text) process.stderr.write(text)
      return result.code
    },
  },
  {
    name: 'check',
    summary: 'Everything wrong with the link graph, in one call. Placeholders are reported, not counted against you',
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
        return [`${verdict} — ${counts}`, ...problems].join('\n')
      })
      return health.healthy ? 0 : 1
    },
  },
  {
    name: 'index',
    summary: 'Write the index where a Quartz build can read it. Run this immediately before every build',
    usage: 'awt index --out path.json',
    options: {...WORKSPACE_OPTION, out: {type: 'string'}},
    async run({values}) {
      if (!values.out) {
        process.stderr.write('awt index needs --out\n')
        return 2
      }
      const root = await notesDirFor(values)
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
    name: 'search',
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
              `${value.path} — ${value.title}`,
              `  links:     ${value.links.map((e) => e.path).join(', ') || 'none'}`,
              `  backlinks: ${value.backlinks.map((e) => e.path).join(', ') || 'none'}`,
            ].join('\n'),
      )
      return result.error ? 1 : 0
    },
  },
  {
    name: 'resolve',
    summary: 'What a link points at — and, when it is ambiguous, what else matched',
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
    name: 'rename',
    summary: 'Rename a note within its folder, rewriting every link into it',
    usage: 'awt rename <path> <new-basename.md>',
    options: {...WORKSPACE_OPTION, ...OUTPUT_OPTIONS, 'dry-run': {type: 'boolean', default: false}},
    async run({values, positionals}) {
      return runVerb(values, async () =>
        renameNote(await notesDirFor(values), {
          path: positionals[0],
          name: positionals[1],
          dryRun: values['dry-run'],
        }),
      )
    },
  },
  {
    name: 'move',
    summary: 'Move a note, rewriting every link into it',
    usage: 'awt move <from> <to>',
    options: {...WORKSPACE_OPTION, ...OUTPUT_OPTIONS, 'dry-run': {type: 'boolean', default: false}},
    async run({values, positionals}) {
      return runVerb(values, async () =>
        moveNote(await notesDirFor(values), {from: positionals[0], to: positionals[1], dryRun: values['dry-run']}),
      )
    },
  },
  {
    name: 'delete',
    summary: 'Delete a note. Links into it are reported, not rewritten — an unresolved link is the backlog signal',
    usage: 'awt delete <path>',
    options: {...WORKSPACE_OPTION, ...OUTPUT_OPTIONS, 'dry-run': {type: 'boolean', default: false}},
    async run({values, positionals}) {
      return runVerb(values, async () =>
        deleteNote(await notesDirFor(values), {path: positionals[0], dryRun: values['dry-run']}),
      )
    },
  },
  {
    name: 'split-by-heading',
    summary: 'Split a note into several, one per named heading. You supply the plan; it invents no names',
    usage:
      'awt split-by-heading <path> --source delete|stub|keep \\\n' +
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
    name: 'merge-files',
    summary: 'Merge notes into one, each as a section under its own title, repointing every link into them',
    usage: 'awt merge-files <source...> --into <path> --source delete|keep [--depth n]',
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
    name: 'build-listing',
    summary: 'Regenerate the notes listing between its markers in the wiki index; everything outside is left alone',
    usage: 'awt build-listing [--path index.md] [--columns note,topic,about]',
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
    name: 'bootstrap-quartz',
    summary: 'Set up (or re-pin) the Quartz clone a site builds from, and link the toolbox plugins into it',
    usage: 'awt bootstrap-quartz [--site path] [--force]',
    notes: [
      "Runs from anywhere inside the project: the site is <rootDir>/site, with rootDir from the project's",
      'awt.config.mjs (default wiki/). --site names another one, resolved against the cwd.',
    ],
    options: {site: {type: 'string'}, force: {type: 'boolean', default: false}},
    async run({values, positionals}) {
      const {bootstrap} = await import('@agent-wiki-toolbox/publish')
      const layout = values.site ? null : await resolveLayout()
      const site = values.site ?? layout?.siteDir
      if (!site) {
        process.stderr.write(
          'awt bootstrap-quartz: no awt.config.mjs here or in any parent, and no site/quartz.config.yaml either.\n' +
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
    summary: 'Build the site into a release, or a handoff copy with --offline. Emits the index first',
    usage:
      'awt publish [--wiki path] [--site path] [--out path] [--offline]\n' +
      '            [--diagrams png|none] [--nginx] [--skip-index]',
    notes: [
      'Builds in publish mode — a build without --serve, which is what makes cross-wiki links',
      'resolve to published rather than localhost URLs — into a staging directory, then renames',
      'it into place. A failed build leaves the standing release untouched; the one it replaces',
      'is kept as .release-prev, so a rollback is a rename.',
      '',
      '--offline builds a handoff copy into site/handoff instead: browser-only plugins off, every',
      'link rewritten to a real .html file, every script removed. Zip it and send it — the reader',
      'opens index.html by double-clicking, with no server and no internet.',
      '',
      'Mermaid diagrams are pre-rendered to PNG for --offline, since Quartz draws them in the',
      "reader's browser from a CDN and neither is available from a folder. --diagrams none leaves",
      'them as source text. A served site never pre-renders: there the browser draws them, themed',
      'and searchable.',
      '',
      '--nginx prints a server block for the release and exits without building.',
    ],
    options: {
      wiki: {type: 'string'},
      site: {type: 'string'},
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
    summary: "Emit the index and run Quartz's dev server over the wiki. Ports come from awt.config.mjs",
    usage: 'awt serve [--wiki path] [--site path] [--out path] [--port N] [--wsPort N] [--skip-index]',
    notes: [
      "Emits the toolbox index, then runs Quartz's dev server over the wiki. The index is what the",
      'awt-links shadow compares the rendered pages against, and emitting it is the half a',
      'hand-typed build command leaves out.',
      '',
      "Ports come from `serve` in the project's awt.config.mjs, so a wiki keeps the same pair every",
      'run and `awt serve` on its own is the whole command:',
      '',
      '    export default {serve: {port: 8101}}',
      '',
      '--wsPort defaults to the port plus 100. Runs from anywhere inside the project.',
    ],
    options: {
      wiki: {type: 'string'},
      site: {type: 'string'},
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
      // walking up, so `awt serve` finds the same project the build does no
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
    name: 'mcp',
    summary: 'Run the MCP server over stdio, for an agent to talk to',
    usage: 'awt mcp [--allow-writes] [--name n]',
    notes: [
      "With no -w the notes come from the project's awt.config.mjs — rootDir/notes, rootDir",
      'defaulting to wiki/ — so an .mcp.json entry is `awt mcp --allow-writes` and names no path.',
    ],
    options: {...WORKSPACE_OPTION, 'allow-writes': {type: 'boolean', default: false}, name: {type: 'string'}},
    async run({values}) {
      const {createServer} = await import('@agent-wiki-toolbox/mcp')
      const {StdioServerTransport} = await import('@modelcontextprotocol/sdk/server/stdio.js')
      const explicit = values.workspace ?? process.env.AWT_WORKSPACE
      const layout = explicit ? null : await resolveLayout(process.cwd(), {quiet: true})
      const server = createServer({
        notesDir: explicit ? resolvePath(explicit) : (layout?.notesDir ?? process.cwd()),
        rootDir: layout?.rootDir ?? null,
        schemaGlobBase: layout && !layout.legacy ? layout.notesDir : null,
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
