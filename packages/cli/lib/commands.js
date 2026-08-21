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
import {loadProjectConfig, runFormat} from '@agent-wiki-toolbox/format'
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

/** The wiki a command works on: `--workspace`, else `$AWT_WORKSPACE`, else here. */
function workspaceRoot(values) {
  return resolvePath(values.workspace ?? process.env.AWT_WORKSPACE ?? process.cwd())
}

const WORKSPACE_OPTION = {workspace: {type: 'string', short: 'w'}}
const OUTPUT_OPTIONS = {json: {type: 'boolean', default: false}}

function emit(values, value, human) {
  if (values.json) {
    process.stdout.write(`${JSON.stringify(value, null, 1)}\n`)
    return
  }
  process.stdout.write(`${human(value)}\n`)
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
function runVerb(values, action) {
  try {
    const report = action()
    emit(values, report, reportLines)
    return report.ok ? 0 : 1
  } catch (error) {
    if (!error.report) throw error
    emit(values, error.report, reportLines)
    return 1
  }
}

export const COMMANDS = [
  {
    name: 'fmt',
    summary: 'Format markdown the way IntelliJ formats it. Works on a lone file with no wiki in sight',
    usage: 'awt fmt [paths...]\n       awt fmt --check [paths...]\n       awt fmt --stdin',
    options: {
      check: {type: 'boolean', short: 'c', default: false},
      stdin: {type: 'boolean', default: false},
      quiet: {type: 'boolean', default: false},
    },
    async run({values, positionals}) {
      const {config} = await loadProjectConfig()
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
      return runFormat({files: positionals, config, mode: values.check ? 'check' : 'format', quiet: values.quiet})
    },
  },
  {
    name: 'check',
    summary: 'Everything wrong with the link graph, in one call. Placeholders are reported, not counted against you',
    usage: 'awt check [--workspace dir] [--json]',
    options: {...WORKSPACE_OPTION, ...OUTPUT_OPTIONS},
    async run({values}) {
      const health = check(loadWorkspace(workspaceRoot(values)))
      emit(values, health, (value) => {
        const lines = [
          `${value.notes} notes, ${value.links} links, ${value.placeholders.length} placeholders, ` +
            `${value.orphans.length} orphans, ${value.deadends.length} dead ends`,
        ]
        for (const problem of value.problems) {
          lines.push(`  ${problem.severity} ${problem.path}:${problem.line} [${problem.rule}] ${problem.message}`)
        }
        lines.push(value.healthy ? 'graph is healthy' : `${value.problems.length} problem(s)`)
        return lines.join('\n')
      })
      return health.healthy ? 0 : 1
    },
  },
  {
    name: 'index',
    summary: 'Write the index where a Quartz build can read it. Run this immediately before every build',
    usage: 'awt index [--workspace dir] --out path.json',
    options: {...WORKSPACE_OPTION, out: {type: 'string'}},
    async run({values}) {
      if (!values.out) {
        process.stderr.write('awt index needs --out\n')
        return 2
      }
      const root = workspaceRoot(values)
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
    usage: 'awt search <query> [--tag t] [--type t] [--area a] [--topic t] [--json]',
    options: {
      ...WORKSPACE_OPTION,
      ...OUTPUT_OPTIONS,
      tag: {type: 'string'},
      type: {type: 'string'},
      area: {type: 'string'},
      topic: {type: 'string'},
      limit: {type: 'string'},
    },
    async run({values, positionals}) {
      const found = search(loadWorkspace(workspaceRoot(values)), {
        query: positionals.join(' ') || undefined,
        tag: values.tag,
        type: values.type,
        area: values.area,
        topic: values.topic,
        limit: values.limit ? Number(values.limit) : undefined,
      })
      emit(values, found, (value) =>
        value.results
          .map((entry) => [`${entry.path}`, ...entry.matches.map((m) => `  ${m.line}: ${m.text}`)].join('\n'))
          .join('\n') || 'no matches',
      )
      return found.total > 0 ? 0 : 1
    },
  },
  {
    name: 'connections',
    summary: 'Links out of and into a note, optionally several hops out',
    usage: 'awt connections <path> [--depth n] [--direction in|out|both] [--json]',
    options: {...WORKSPACE_OPTION, ...OUTPUT_OPTIONS, depth: {type: 'string'}, direction: {type: 'string'}},
    async run({values, positionals}) {
      const result = connections(loadWorkspace(workspaceRoot(values)), {
        path: positionals[0],
        depth: values.depth ? Number(values.depth) : undefined,
        direction: values.direction,
      })
      emit(values, result, (value) =>
        [
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
    usage: 'awt resolve <target> [--from note.md] [--json]',
    options: {...WORKSPACE_OPTION, ...OUTPUT_OPTIONS, from: {type: 'string'}},
    async run({values, positionals}) {
      const outcome = resolveLink(loadWorkspace(workspaceRoot(values)), {
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
      return runVerb(values, () =>
        renameNote(workspaceRoot(values), {
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
      return runVerb(values, () =>
        moveNote(workspaceRoot(values), {from: positionals[0], to: positionals[1], dryRun: values['dry-run']}),
      )
    },
  },
  {
    name: 'delete',
    summary: 'Delete a note. Links into it are reported, not rewritten — an unresolved link is the backlog signal',
    usage: 'awt delete <path>',
    options: {...WORKSPACE_OPTION, ...OUTPUT_OPTIONS, 'dry-run': {type: 'boolean', default: false}},
    async run({values, positionals}) {
      return runVerb(values, () =>
        deleteNote(workspaceRoot(values), {path: positionals[0], dryRun: values['dry-run']}),
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
      return runVerb(values, () =>
        splitByHeading(workspaceRoot(values), {
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
      return runVerb(values, () =>
        mergeFiles(workspaceRoot(values), {
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
      return runVerb(values, () =>
        renameTag(workspaceRoot(values), {from: positionals[0], to: positionals[1], dryRun: values['dry-run']}),
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
      return runVerb(values, () =>
        buildListing(workspaceRoot(values), {
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
    options: {site: {type: 'string'}, force: {type: 'boolean', default: false}},
    async run({values, positionals}) {
      const {bootstrap} = await import('@agent-wiki-toolbox/publish')
      return bootstrap([
        ...(values.site ? ['--site', values.site] : []),
        ...(values.force ? ['--force'] : []),
        ...positionals,
      ])
    },
  },
  {
    name: 'publish',
    summary: 'Build the site into a release, or a handoff copy with --offline. Emits the index first',
    usage: 'awt publish [--wiki docs/wiki] [--site site] [--offline] [--nginx]',
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

      // The index is emitted here rather than left to whoever runs the build,
      // because the shadow compares against it: an artifact one edit out of date
      // reports a disagreement that is not real, or an agreement that is not
      // either. Same resolution rule the build uses, so both find the same
      // project from anywhere inside it.
      if (!values.nginx && !values['skip-index']) {
        const {findProjectRoot} = await import('@agent-wiki-toolbox/publish/project-root')
        const root = values.wiki && values.site ? null : findProjectRoot()
        if (!root && !(values.wiki && values.site)) {
          process.stderr.write('awt publish: no site/quartz.config.yaml here or in any parent\n')
          return 2
        }
        const wiki = values.wiki ? resolvePath(values.wiki) : resolvePath(root, 'docs/wiki')
        const site = values.site ? resolvePath(values.site) : resolvePath(root, 'site')
        const workspace = loadWorkspace(wiki)
        writeIndexArtifact(workspace, resolvePath(site, '.awt-index.json'))
        process.stdout.write(`index: ${workspace.resources.length} notes, ${workspace.edges.length} links\n`)
      }

      return publish([
        ...(values.wiki ? ['--wiki', values.wiki] : []),
        ...(values.site ? ['--site', values.site] : []),
        ...(values.out ? ['--out', values.out] : []),
        ...(values.offline ? ['--offline'] : []),
        ...(values.diagrams ? ['--diagrams', values.diagrams] : []),
        ...(values.nginx ? ['--nginx'] : []),
      ])
    },
  },
  {
    name: 'mcp',
    summary: 'Run the MCP server over stdio, for an agent to talk to',
    usage: 'awt mcp [--workspace dir] [--allow-writes]',
    options: {...WORKSPACE_OPTION, 'allow-writes': {type: 'boolean', default: false}, name: {type: 'string'}},
    async run({values}) {
      const {createServer} = await import('@agent-wiki-toolbox/mcp')
      const {StdioServerTransport} = await import('@modelcontextprotocol/sdk/server/stdio.js')
      const server = createServer({
        root: workspaceRoot(values),
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
