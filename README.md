# agent-wiki-toolbox

One toolbox for a markdown wiki whose notes are connected by `[[wikilinks]]` — the link graph,
structural edits that keep it intact, formatting, and the build that renders it as a site.

**Nothing here works yet.** This is the package skeleton and the layering check; the code arrives
milestone by milestone.

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

## The binary

One command, `awt`, with everything as a subcommand — the verbs, formatting, the site build. There is
no second binary to reach for.

## Where the reasoning lives

This repo carries the code. The design, the twenty-seven decisions behind it and the measurements
they rest on are in the AiSandbox workspace wiki, under the `agent-wiki-toolbox` topic —
`docs/wiki/design/agent-wiki-toolbox/toolbox-shape.md` is the entry point, and `docs/awt-plan.md` is
the milestone-by-milestone plan.

That wiki is where this was designed, not a dependency: **this repo has to be clonable and workable on
its own**, and nothing in it may reference the workspace at build or run time.

## Status

**ALPHA.** No tags, no releases, no npm publish planned. Install from a working copy; ask what is
running with `awt --version`.
