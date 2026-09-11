/**
 * The agent-facing surface: fourteen tools. Each answers something that cannot be
 * answered by opening a file; reading a note and writing prose into it are left
 * to the agent's own file tools.
 *
 * The server calls the same `core` the CLI does. Nothing is watched: the index is
 * a pure function of the tree, so a write between two calls is seen by the second.
 */
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js'
import {z} from 'zod'

import {check, loadWorkspace} from '@agent-wiki-toolbox/core'
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

import {connections} from './connections.js'
import {fmt} from './fmt-tool.js'
import {resolve} from './resolve-tool.js'
import {search} from './search.js'

/** JSON as an MCP tool result. Structured, because the caller is a program. */
function reply(value) {
  return {content: [{type: 'text', text: JSON.stringify(value, null, 1)}]}
}

/**
 * `notesDir` is the wiki this server answers for: the notes, never the home around
 * them. `rootDir` is that home when the project has one, reported under its own
 * name; null on a legacy layout or a bare directory.
 * `schemaGlobBase` is where `fmt` reads the schema globs from — the notes
 * directory under a `rootDir` layout — and is null when the config's own
 * directory is the base.
 *
 * Those three are the fixed form, for a server handed a path outright: `-w`, and
 * the read-only mounts. `resolveTarget` is the other form — a function returning
 * the same three, or null for "there is no wiki here" — and it is asked on every
 * call rather than once at startup.
 */
export function createServer({
  notesDir,
  rootDir = null,
  schemaGlobBase = null,
  resolveTarget = null,
  allowWrites = false,
  name = 'agent-wiki-toolbox',
} = {}) {
  const server = new McpServer({name, version: '0.0.0'})

  // Resolved per call, not once at startup. A server started in a directory that
  // becomes a wiki later — bootstrapped by the very session talking to it — sees
  // it on the next call rather than never.
  const target = resolveTarget ?? (async () => ({notesDir, rootDir, schemaGlobBase}))

  /**
   * The wiki this call is about, or null when there is none. The index is a memo
   * in front of the on-disk cache, reloaded per call, so an edit made by anything
   * else — the agent, the IDE, `git checkout` — is seen by the next one.
   */
  const wiki = async () => {
    const t = await target()
    if (!t?.notesDir) return null
    return {...t, index: () => loadWorkspace(t.notesDir)}
  }

  // A directory with no project above it is not an empty wiki, and saying so is
  // the whole point: served as one it reports zero notes and a clean graph, which
  // is what a healthy wiki also reports.
  const noWiki = () =>
    reply({
      error:
        'no wiki here: no awt.config.mjs in this directory or any above it, so there is no project ' +
        'to serve. Create one to mark the project root, or start the server with -w pointing at a ' +
        'notes directory.',
      wiki: null,
    })

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
      (args, w) => search(w.index(), args),
    ],
    [
      'connections',
      'Links out of and into a note, optionally to a depth. Answers "what cites this" and "what would break if it moved".',
      {
        path: z.string().describe('workspace-relative path, e.g. design/foo.md'),
        depth: z.number().int().positive().max(6).optional(),
        direction: z.enum(['in', 'out', 'both']).optional(),
      },
      (args, w) => connections(w.index(), args),
    ],
    [
      'check',
      'Everything wrong with the link graph in one call: ambiguous stems, two files served as one ' +
        'page, a link that misses a note which exists, a note shadowed by a folder of its own name, ' +
        'labelled wikilinks, broken section anchors, broken relative links and unclosed wikilinks. ' +
        'Placeholders, orphans and dead ends are listed separately and are not problems.',
      {},
      (args, w) => check(w.index()),
    ],
    [
      'resolve',
      'What a [[stem]], a folder-qualified link or a prefix:path.md reference points at, and what else matched when it is ambiguous.',
      {
        target: z.string().describe('the link as written, e.g. stem, folder/stem#anchor, vsf:meta/scope.md'),
        from: z.string().optional().describe('the note it is written in, for a bare #anchor'),
      },
      (args, w) => resolve(w.index(), args),
    ],
    [
      'workspace_info',
      'Which wiki this server is talking to (notesDir, and the rootDir home around it when there is one), how big it is, whether it may be written to, and its whole tag vocabulary.',
      {},
      (args, w) => {
        const workspace = w.index()
        const health = check(workspace)
        return {
          notesDir: w.notesDir,
          rootDir: w.rootDir,
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

  // Verb plus object, snake_case on this surface.
  const writes = [
    [
      'rename',
      'Rename a note within its folder, rewriting every link into it.',
      {path: z.string(), name: z.string().describe('the new basename, e.g. new-name.md')},
      (args, w) => renameNote(w.notesDir, args),
    ],
    [
      'move',
      'Move a note to a new path, rewriting every link into it.',
      {from: z.string(), to: z.string()},
      (args, w) => moveNote(w.notesDir, args),
    ],
    [
      'delete',
      'Delete a note. Links into it are reported, not rewritten.',
      {path: z.string()},
      (args, w) => deleteNote(w.notesDir, args),
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
      (args, w) => splitByHeading(w.notesDir, args),
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
      (args, w) => mergeFiles(w.notesDir, args),
    ],
    [
      'rename_tag',
      'Rename a front-matter tag everywhere it appears.',
      {from: z.string(), to: z.string()},
      (args, w) => renameTag(w.notesDir, args),
    ],
    [
      'build_listing',
      'Regenerate the notes listing between its markers in the wiki index. Text outside the markers is not touched.',
      {
        path: z.string().optional(),
        columns: z.array(z.enum(['note', 'topic', 'area', 'about'])).optional().describe('default note, about'),
      },
      (args, w) => buildListing(w.notesDir, args),
    ],
  ]

  /**
   * Front matter is its own domain, so it is its own tool rather than a `metadata`
   * argument on the write verbs: nothing addresses across the two, and the two
   * hazards are unrelated. One tool carries read and write because they are one
   * command — the operation axis says which.
   *
   * Like `fmt`, it has a read half that a read-only mount serves: asking what a
   * note's front matter holds is an ordinary read. A write operation on such a
   * server is told so rather than quietly given the read.
   */
  const FRONTMATTER_DESCRIPTION =
    "Read or write one note's front matter: the whole block, or one key. operation is read, replace, " +
    'delete, append or prepend; scope is block, content (a key) or marker (a key\'s name). ' +
    'replace+content sets a key, replace+marker renames one leaving the value, append/prepend add to a ' +
    'sequence-valued key like tags. Every write is checked against the schema for that path and refused ' +
    'if it violates it. Replacing the block wholesale reserialises it, losing comments and quoting, so it ' +
    'needs derived: true and is only for front matter the toolbox owns. The markdown body is not reachable ' +
    'from here.' +
    (allowWrites ? '' : ' This server is read-only: only operation: "read" is available.')

  server.tool(
    'frontmatter',
    FRONTMATTER_DESCRIPTION,
    {
      path: z.string().describe('workspace-relative path, e.g. design/foo.md'),
      operation: z.enum(['read', 'replace', 'delete', 'append', 'prepend']).optional().describe('default read'),
      scope: z.enum(['block', 'content', 'marker']).optional().describe('default content when a key is named, else block'),
      key: z.string().optional().describe('the front-matter field'),
      // Whatever YAML holds: a string, a number, a list item, or the whole object
      // at block scope. A narrower schema here would be this tool inventing a
      // front-matter vocabulary, which is the schema's job and not a tool's.
      value: z.any().optional().describe("the value to write; for scope marker, the key's new name"),
      derived: z
        .boolean()
        .optional()
        .describe('required for scope block: this front matter is the toolbox\'s to write, not an author\'s'),
      dryRun: DRY_RUN,
    },
    async (args) => {
      const w = await wiki()
      if (!w) return noWiki()
      const operation = args?.operation ?? 'read'
      if (!allowWrites && operation !== 'read') {
        return reply({
          error:
            `this server was started read-only, so frontmatter can only read. Use operation: "read" to see ` +
            'what this note holds, or start the server with --allow-writes to change it.',
        })
      }
      try {
        return reply(await frontmatter(w.notesDir, args))
      } catch (error) {
        return reply(error.report ?? {ok: false, error: error.message})
      }
    },
  )

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
      const w = await wiki()
      if (!w) return noWiki()
      if (!allowWrites && args?.dryRun !== true) {
        return reply({
          error:
            'this server was started read-only, so fmt can only check. Pass dryRun: true to see what ' +
            'is unformatted here, or start the server with --allow-writes to fix it.',
        })
      }
      try {
        return reply(await fmt(w.notesDir, {...args, globBase: w.schemaGlobBase, check: !allowWrites || args?.dryRun === true}))
      } catch (error) {
        return reply({ok: false, error: error.message})
      }
    },
  )

  for (const [toolName, description, schema, handler] of readOnly) {
    server.tool(toolName, description, schema, async (args) => {
      const w = await wiki()
      if (!w) return noWiki()
      return reply(await handler(args ?? {}, w))
    })
  }

  // Without `--allow-writes` the write verbs are not registered, so the tool list
  // holds only what the server can do.
  for (const [toolName, description, schema, handler] of allowWrites ? writes : []) {
    server.tool(toolName, description, {...schema, dryRun: DRY_RUN}, async (args) => {
      const w = await wiki()
      if (!w) return noWiki()
      try {
        // Awaited, because `fmt` runs a whole unified pipeline and the verbs do
        // not. An un-awaited promise here serialises as `{}` and reads as success.
        return reply(await handler(args ?? {}, w))
      } catch (error) {
        // A verb that cannot start reports in the same shape as one that finished
        // partially: the caller should never have to tell a refusal from a crash.
        return reply(error.report ?? {ok: false, error: error.message})
      }
    })
  }

  return server
}
