/**
 * The agent-facing surface: thirteen tools, shaped for this estate rather than
 * ported from Foam's twenty-five ([[toolbox-decisions]] 24).
 *
 * The rule that decided the list: **a tool earns its place only if it answers
 * something that cannot be answered by opening a file.** Reading a note, listing its
 * headings and writing prose into it are all things the agent's own `Read`, `Write`
 * and `Edit` do better, so none of them is here.
 *
 * The server is ordinary — decision 9's whole point. It is the same `core` the CLI
 * calls, with an in-process memo in front of the on-disk cache, so there is one code
 * path rather than two skins that drift. Nothing is watched: the index is a pure
 * function of the tree, so an agent's own `Write` between two calls is picked up by
 * the second one.
 */
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js'
import {z} from 'zod'

import {check, loadWorkspace} from '@agent-wiki-toolbox/core'
import {
  buildListing,
  deleteNote,
  mergeFiles,
  moveNote,
  renameNote,
  renameTag,
  splitByHeading,
} from '@agent-wiki-toolbox/verbs'

import {connections} from './connections.js'
import {fmt} from './fmt-tool.js'
import {resolve} from './resolve-tool.js'
import {search} from './search.js'

/** JSON as an MCP tool result. Structured, because the caller is a program. */
function reply(value) {
  return {content: [{type: 'text', text: JSON.stringify(value, null, 1)}]}
}

/**
 * `notesDir` is the wiki this server answers for — the notes, never the home around
 * them. `rootDir` is that home when the project has one ([[toolbox-decisions]]
 * 38), reported so an agent sees both directories under distinct names rather than
 * inferring one from the other; null on a legacy layout or a bare directory.
 * `schemaGlobBase` is where `fmt` reads the schema globs from — the notes
 * directory under a `rootDir` layout — and is null when the config's own
 * directory is the base.
 */
export function createServer({
  notesDir,
  rootDir = null,
  schemaGlobBase = null,
  allowWrites = false,
  name = 'agent-wiki-toolbox',
} = {}) {
  const server = new McpServer({name, version: '0.0.0'})

  // One in-process memo in front of the on-disk cache. Reloaded on every call, so
  // an edit made by anything else — the agent, the IDE, `git checkout` — is seen.
  const index = () => loadWorkspace(notesDir)

  const readOnly = [
    [
      'search',
      'Search the wiki over note bodies, titles, front matter and tags in one call. ' +
        'Use a plain string for case-insensitive text, or /regex/flags. Filter by tag, type, area or topic.',
      {
        query: z.string().optional().describe('text, or /regex/flags'),
        fields: z.array(z.enum(['text', 'title', 'tags', 'properties'])).optional(),
        tag: z.string().optional(),
        type: z.string().optional(),
        area: z.string().optional(),
        topic: z.string().optional(),
        limit: z.number().int().positive().optional(),
      },
      (args) => search(index(), args),
    ],
    [
      'connections',
      'Links out of and into a note, optionally to a depth. Answers "what cites this" and "what would break if it moved".',
      {
        path: z.string().describe('workspace-relative path, e.g. design/foo.md'),
        depth: z.number().int().positive().max(6).optional(),
        direction: z.enum(['in', 'out', 'both']).optional(),
      },
      (args) => connections(index(), args),
    ],
    [
      'check',
      'Everything wrong with the link graph in one call: ambiguous stems, two files served as one ' +
        'page, a link that misses a note which exists, a note shadowed by a folder of its own name, ' +
        'labelled wikilinks, broken section anchors, broken relative links and unclosed wikilinks. ' +
        'Placeholders, orphans and dead ends are listed separately and are not problems.',
      {},
      () => check(index()),
    ],
    [
      'resolve',
      'What a [[stem]], a folder-qualified link or a prefix:path.md reference points at, and what else matched when it is ambiguous.',
      {
        target: z.string().describe('the link as written, e.g. stem, folder/stem#anchor, vsf:meta/scope.md'),
        from: z.string().optional().describe('the note it is written in, for a bare #anchor'),
      },
      (args) => resolve(index(), args),
    ],
    [
      'workspace_info',
      'Which wiki this server is talking to (notesDir, and the rootDir home around it when there is one), how big it is, whether it may be written to, and its whole tag vocabulary.',
      {},
      () => {
        const workspace = index()
        const health = check(workspace)
        return {
          notesDir,
          rootDir,
          allowWrites,
          notes: workspace.resources.length,
          links: workspace.edges.length,
          placeholders: health.placeholders.length,
          problems: health.problems.length,
          crossWikiLinks: workspace.crossWikiLinks.length,
          // The vocabulary, not just its size: the reason to look at tags before
          // coining one is to see the near-duplicate you were about to create, and
          // a count answers nothing.
          tags: [...workspace.tags.entries()]
            .map(([tag, paths]) => ({tag, count: paths.length}))
            .sort((a, b) => b.count - a.count || (a.tag < b.tag ? -1 : 1)),
        }
      },
    ],
  ]

  // Every write verb takes `--dry-run` on the CLI, so every write tool takes it
  // here: the schema is what an agent can send, and a key it strips is a preview
  // an agent cannot ask for before a bulk rewrite. Added to all of them below
  // rather than to each by hand, so the next verb cannot arrive without it.
  const DRY_RUN = z.boolean().optional().describe('report what would change and write nothing')

  // Verb plus object, snake_case on this surface (decision 16). An agent picks a
  // tool by name before it reads any documentation, so the axis is in the name.
  const writes = [
    [
      'rename',
      'Rename a note within its folder, rewriting every link into it.',
      {path: z.string(), name: z.string().describe('the new basename, e.g. new-name.md')},
      (args) => renameNote(notesDir, args),
    ],
    [
      'move',
      'Move a note to a new path, rewriting every link into it.',
      {from: z.string(), to: z.string()},
      (args) => moveNote(notesDir, args),
    ],
    [
      'delete',
      'Delete a note. Links into it are reported, not rewritten.',
      {path: z.string()},
      (args) => deleteNote(notesDir, args),
    ],
    [
      'split_by_heading',
      'Split a note into several, one per heading in the plan, which maps headings to paths. source ' +
        "is the source note's fate. A target basename already in the wiki is refused.",
      {
        path: z.string(),
        plan: z.array(z.object({heading: z.string(), path: z.string()})).min(1),
        source: z.enum(['delete', 'stub', 'keep']),
      },
      (args) => splitByHeading(notesDir, args),
    ],
    [
      'merge_files',
      'Merge notes into one, each as a section under its own title, repointing every link into them.',
      {
        sources: z.array(z.string()).min(1),
        into: z.string(),
        depth: z.number().int().min(1).max(6).optional(),
        source: z.enum(['delete', 'keep']),
      },
      (args) => mergeFiles(notesDir, args),
    ],
    [
      'rename_tag',
      'Rename a front-matter tag everywhere it appears.',
      {from: z.string(), to: z.string()},
      (args) => renameTag(notesDir, args),
    ],
    [
      'build_listing',
      'Regenerate the notes listing between its markers in the wiki index. Text outside the markers is not touched.',
      {
        path: z.string().optional(),
        columns: z.array(z.enum(['note', 'topic', 'area', 'about'])).optional().describe('default note, about'),
      },
      (args) => buildListing(notesDir, args),
    ],
  ]

  /**
   * `fmt` is the one write with a read half, so it is registered here rather than
   * in the loop below: its check writes nothing, and asking a wiki you may not
   * write to whether it is formatted is an ordinary read — the same question
   * `check` answers about the link graph, which a read-only mount serves happily.
   *
   * **Permission does not depend on the argument being honoured.** `check` is
   * forced by `allowWrites`, so a read-only server cannot construct a writing run
   * at all; `dryRun` only chooses between the two halves on a server that has
   * both. A call that wanted the write half is told that, rather than quietly
   * being given the other one.
   */
  const fmtDescription =
    "Format notes in IntelliJ's style, keeping wikilink and embed syntax intact. Paths are " +
    'workspace-relative; no path formats the whole wiki. The write verbs format what they write; ' +
    'prose written with other tools is not formatted until fmt runs. dryRun is the CLI --check: it ' +
    'names what is unformatted and writes nothing.' +
    (allowWrites ? '' : ' This server is read-only: only dryRun: true is available.')

  server.tool(
    'fmt',
    fmtDescription,
    {
      paths: z.array(z.string()).optional().describe('workspace-relative notes or folders, e.g. meta/conventions.md'),
      dryRun: DRY_RUN,
    },
    async (args) => {
      if (!allowWrites && args?.dryRun !== true) {
        return reply({
          error:
            'this server was started read-only, so fmt can only check. Pass dryRun: true to see what ' +
            'is unformatted here, or start the server with --allow-writes to fix it.',
        })
      }
      try {
        return reply(await fmt(notesDir, {...args, globBase: schemaGlobBase, check: !allowWrites || args?.dryRun === true}))
      } catch (error) {
        return reply({ok: false, error: error.message})
      }
    },
  )

  for (const [toolName, description, schema, handler] of readOnly) {
    server.tool(toolName, description, schema, async (args) => reply(await handler(args ?? {})))
  }

  // Without `--allow-writes` the write verbs are not registered, so the tool list
  // holds only what the server can do.
  for (const [toolName, description, schema, handler] of allowWrites ? writes : []) {
    server.tool(toolName, description, {...schema, dryRun: DRY_RUN}, async (args) => {
      try {
        // Awaited, because `fmt` runs a whole unified pipeline and the verbs do
        // not. An un-awaited promise here serialises as `{}` and reads as success.
        return reply(await handler(args ?? {}))
      } catch (error) {
        // A verb that cannot start reports in the same shape as one that finished
        // partially: the caller should never have to tell a refusal from a crash.
        return reply(error.report ?? {ok: false, error: error.message})
      }
    })
  }

  return server
}
