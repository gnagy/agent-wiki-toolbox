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

All three keep working while this is built. Nothing is deprecated, and there is no cutover to
coordinate.

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
fails a check rather than a review. `npm run layering` is that check.

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
awt --help                       # every operation, in one list
awt check                        # everything wrong with the link graph, in one call
awt search 'unique basenames'    # note bodies, titles, front matter and tags
awt move a.md design/a.md        # …rewriting every link into it
awt index --out wiki/site/.awt-index.json
awt mcp --allow-writes           # the MCP server, over stdio
awt bootstrap-quartz             # clone or re-pin the renderer a site builds from
awt serve                        # emit the index, then Quartz's dev server
awt publish                      # build, then swap into wiki/site/release
```

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
project around it needs. A project still laid out as `docs/wiki` beside `site/` keeps working, with
one line on stderr saying how to move; the `wiki-docs` skill's `adoption.md` carries the steps.

Install it with `bin/install`, which is the only step that exposes a change: builds and agent jobs
read `~/.local/lib/agent-wiki-toolbox`, never this working copy.

## Where the reasoning lives

This repo carries the code. The design, the thirty-three decisions behind it and the measurements
they rest on are in the AiSandbox workspace wiki, under the `agent-wiki-toolbox` topic —
`docs/wiki/design/agent-wiki-toolbox/toolbox-shape.md` is the entry point, and `docs/awt-plan.md` is
the milestone-by-milestone plan.

That wiki is where this was designed, not a dependency: **this repo has to be clonable and workable on
its own**, and nothing in it may reference the workspace at build or run time.

## Status

**ALPHA.** No tags, no releases, no npm publish planned. Install from a working copy; ask what is
running with `awt --version`.
