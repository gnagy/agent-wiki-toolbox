# agent-wiki-toolbox

One toolbox for a markdown wiki whose notes are connected by `[[wikilinks]]` — the link graph,
structural edits that keep it intact, formatting, and the build that renders it as a site.

**All seven packages are built.** `syntax`, `core`, `format`, `verbs`, `mcp`, `cli` and `publish` all
work, and both local sites build through them. What is outstanding is the switch: Foam and the old
site tooling still run alongside, and retiring them waits on a soak of the shadow resolver.

## What it replaces

Three things that currently do this job separately, each with its own model of what a link is:

- **Foam** — the link graph and the MCP server an agent talks to
- **`markdown-toolbox`** — the `mdfmt` formatter
- **`quartz-wiki-tools`** — the site build and the cross-wiki resolver

`markdown-toolbox` is now retired: `@agent-wiki-toolbox/format` reimplements `mdfmt` on remark with
no dependency on it, byte-identically, so `awt fmt` is the formatter for a README and a `CLAUDE.md`
as much as for a note. The other two keep working while this is built.

## The layers

```text
        syntax          the mdast dialect: remark plugins, wikilink config
        /     \
     core     format    core   = resolver, index, graph, cache
        \     /         format = IntelliJ-identical serialisation
         verbs          split / move / merge / listing — needs both
        /  |  \
  mcp   cli   publish   nothing below depends on these
```

Each is a workspace package, so **the dependency graph is the architecture** and a layering violation
fails a check rather than a review. `bun run layering` is that check.

Two of its rules are load-bearing rather than tidy:

- **`format` must not depend on `core`.** It is what keeps formatting a lone `CLAUDE.md` possible
  with no wiki anywhere in sight.
- **`core` must not depend on `mcp` or `cli`.** It is what keeps the index a pure function of the
  file tree — which is what makes it cacheable on disk with no watcher.

## What `syntax` settles

The dialect is **ours**, not `remark-wiki-link`'s. One micromark construct covers `[[stem]]`,
`[[folder/stem]]`, `[[stem#anchor]]`, `[[#anchor]]`, `![[embed]]` and the aliased form the estate
bans, producing one node type:

```js
{type: 'wikiLink', embed: false, target: 'folder/stem', anchor: 'a-heading', alias: null}
```

Three consequences the layers above depend on:

- **An embed is a link.** It is a node rather than escaped text, so it is a graph edge and a rename
  rewrites it through the serialiser like anything else.
- **An anchor is a field**, which is what makes it checkable against the heading index.
- **Nothing un-escapes anything.** A serialised document needs no repair pass, so a note *about* this
  syntax survives being formatted.

Resolution lives in `core`. This package deliberately does not know what a target points at.

## The binary

One command, `awt`, with everything as a subcommand — the verbs, formatting, the graph, the MCP
server and the site build. There is no second binary to reach for.

```shell
awt --help                       # every operation, in sections
awt check                        # everything wrong with the link graph, in one call
awt search 'unique basenames'    # note bodies, titles, front matter and tags
awt move a.md design/a.md        # …rewriting every link into it
awt move a.md b.md               # no folder in the destination means rename
awt frontmatter a.md             # the whole block, as the note holds it
awt frontmatter a.md --set status=stable    # …one key, checked against the schema
awt frontmatter a.md --validate  # does this note satisfy its schema? (writes nothing)
awt frontmatter a.md --schema    # which schema claims this path — ask before writing a note
awt mcp --allow-writes           # the MCP server, over stdio

awt site setup                   # clone or re-pin the renderer a site builds from
awt site serve                   # emit the index, then Quartz's dev server
awt site publish                 # build, then swap into wiki/site/release
awt site index                   # just the artifact the Quartz plugins read
```

**`site` is the one group, and a group is a namespace rather than an alias** — there is no flat
`awt serve` kept working beside `awt site serve`. It is grouped because its four commands share a
flag family (`--wiki`, `--site`) that nothing else has, which is the test: **a group's options are
the definition of what the group is**, so grouping the graph reads under their `-w` and `--json` —
the tool's defaults — would have defined nothing. `awt site setup` also stops a command name
carrying the renderer's.

**Front matter is its own command, and the markdown body is not reachable from it.** They are two
documents that happen to share a file: different parsers, different addresses — a key against a node
path — and unrelated hazards. `awt frontmatter` reads the block or one key, sets, renames, drops or
appends to one, and checks every write against the schema for that path — the same check
`awt fmt --dry-run` runs, asked before the bytes land. **It reports and does not refuse**: a single
write is not the unit a schema applies to, and a migration passes through states no schema accepts
on its way to one it does. `--validate` asks the question on its own, and the Stop hook asks it of
everything a session wrote. Replacing the whole block reserialises it and loses an author's comments
and quoting, so it needs `--derived` and takes its object from stdin.

**Every command finds the project from anywhere inside it**, by walking up to `awt.config.mjs` at
the project root. That file names the wiki's home once, and every other directory is a fixed name
inside it:

```
awt.config.mjs      # the marker; rootDir names the home, and defaults to ./wiki
wiki/
  notes/            # the wiki root — what -w means when you do not pass it
  site/             # quartz.config.yaml, quartz.pin, and the build's leavings
  schemas/          # front-matter schemas
  inbox/            # the interop inbox
```

```js
export default {
  rootDir: './wiki',                    // the default; write it only to move the home
  serve: {port: 8101},                  // wsPort defaults to port + 100
  schemas: {'./wiki/schemas/note.schema.json': ['meta/**/*.md']},   // globs are notes-relative
}
```

A bare `awt fmt` inside a project means the notes too, unless the config's `files` says otherwise.
`-w` and `$AWT_WORKSPACE` still name the notes outright, which is what a scratch directory with no
project around it needs. With no project above it and nothing named, a command reads the directory
it was started in as the wiki — a real case, and one that says so on stderr, because the answer it
gives is otherwise indistinguishable from a real one. `AWT_QUIET_WORKSPACE=1` silences that. A
project still laid out as `docs/wiki` beside `site/` keeps working, with one line on stderr saying
how to move, and `/awt:move-layout` carries the steps.

**bun installs it and bun runs it**, pinned with node in `mise.toml`: `bun install`, then
`bun run test` and `bun run layering`. Both binaries carry a `bun` shebang.

node stays pinned for two reasons. The test runner is `node --test`, because `bun test` shares one
process across files and the tests that assert behaviour *per working directory* leak into each
other there — every one of them passes when its file is run alone, and the same schema check passes
end to end through the real CLI under bun. And the Quartz plugins are imported by Quartz's own node
process, which is what keeps this source plain node-compatible ESM rather than anything bun-specific.

Install it with `scripts/install`, the only step that exposes a change. It copies this working copy
to `~/.claude/skills/awt`, where Claude Code adopts it as the **`awt` plugin** — and points
`~/.local/bin/awt` at the same tree, so a shell, a site build and a session all run one copy.

What the plugin is, beyond the binary:

| Part                                                                 | What it does                                                                                                                                                                                                                               |
|----------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| The `wiki-docs` skill, as `/awt:wiki-docs`                           | The tool, its verbs and the hazards                                                                                                                                                                                                        |
| The MCP server                                                       | The verbs over whichever project's wiki the session is in                                                                                                                                                                                  |
| `SessionStart`, `SubagentStart`, `PreToolUse`, `PostToolUse`, `Stop` | Inject the mandate, hand a subagent the same one, guard the first wiki write, report what the structural verbs refused, carry the touch record through a compaction, then format what the session wrote and check the graph before it ends |
| `/awt:check` · `/awt:orient`                                         | The everyday two: both health checks as one answer, and the reading pass before work starts                                                                                                                                                |
| `/awt:adopt` · `/awt:move-layout` · `/awt:init`                      | The deliberate acts: the drift sweep, the layout move, bootstrapping a wiki                                                                                                                                                                |

Every automatic part is gated on `awt.config.mjs` and inert without it, so a project is not something
that installs the plugin — it is something the plugin recognises.

## Where the reasoning lives

This repo carries the code. The design, the thirty-three decisions behind it and the measurements
they rest on are in the AiSandbox workspace wiki, under the `agent-wiki-toolbox` topic —
`wiki/notes/projects/agent-wiki-toolbox/design/toolbox-shape.md` is the entry point, and `docs/awt-plan.md` is
the milestone-by-milestone plan.

That wiki is where this was designed, not a dependency: **this repo has to be clonable and workable on
its own**, and nothing in it may reference the workspace at build or run time.

## Status

**ALPHA.** No tags, no releases, no npm publish planned. Install from a working copy; ask what is
running with `awt --version`.
