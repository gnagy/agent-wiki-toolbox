---
name: wiki-docs
description: Work with a wikilinked markdown wiki through the agent-wiki-toolbox, the `awt` CLI and its MCP tools - search and check the link graph, format notes, and rename, move, split or merge notes with their links rewritten. Read it before restructuring or bulk-editing wiki notes with any tool, formatting a wiki, mounting another project's wiki, or setting one up.
---

# Wiki Docs

A wiki here is a directory of markdown notes with YAML front matter, linked by `[[wikilinks]]`.
The `agent-wiki-toolbox` (`awt`) reads that link graph and performs the edits that break it when
done by hand. This file describes the tool. What a wiki contains, how it is laid out and which
front-matter values it uses are the project's choices, carried in the project's own files.

`awt --help` and each command's `--help` are the authority on commands and flags, and the MCP
server describes its own tools. This file carries what those do not: order of use, and hazards.

## Where the wiki is

`awt.config.mjs` at the project root marks the project. Its `rootDir` names the wiki's home,
`wiki/` when unsaid, with `notes/`, `site/`, `schemas/` and `inbox/` as fixed names inside it.
Every command and the MCP server find the config by walking up, so an `.mcp.json` entry is
`awt mcp --allow-writes` and names no path. `-w <dir>` names a notes directory outright instead.

A project can run more than one server: its own wiki, plus other projects' wikis mounted
read-only. `workspace_info` reports `notesDir`, `rootDir`, `allowWrites` and the tag vocabulary
with counts, and is the call that tells servers apart.

## Reading

| Tool             | What it answers                                                                                                  |
|------------------|------------------------------------------------------------------------------------------------------------------|
| `workspace_info` | Which wiki this server serves, whether it may write, which tags exist                                            |
| `search`         | Bodies, titles, front matter and tags in one call. A string or `/regex/flags`; filters on tag, type, area, topic |
| `connections`    | Links out of and into a note, optionally several hops                                                            |
| `resolve`        | What a link points at, and what else matched when it is ambiguous                                                |
| `check`          | Everything wrong with the graph, in one call                                                                     |

`check` returns `problems`, and separately `placeholders`, `orphans`, `deadends` and
`unreferenced`. It exits non-zero on problems only. A placeholder is a `[[link]]` to a note that
does not exist; the tool reports it and attaches no meaning.

### How links resolve

- A `[[stem]]` resolves by shortest path, so a basename shared by two notes resolves to neither.
  `resolve` names the candidates; a folder segment, `[[folder/note]]`, or a rename settles it.
- `[[folder/index]]` does not reach a listing one level down, though `[[a/b/index]]` reaches one
  two levels down. A relative markdown link, `[text](folder/index.md)`, does, and `check` validates it.
- Two files can render to one address: `x/x.md` beside `x/index.md`, `a b.md` beside `a-b.md`,
  names differing only in case. `check` reports every file in the group.
- `[[stem|label]]` is reported as a problem. `rename` rewrites the target and leaves the label.
- `![[embed]]` is a link: a node, an edge, and rewritten by `rename` and `move`.
- `[text](prefix:path.md)` is a reference into another wiki. `resolve` reports it as `crossWiki`
  and `check` counts it apart from placeholders. See `interop.md` beside this file.

## Writing

Write tools need a server started with `--allow-writes`. A read-only server does not list them;
of the writes only `fmt` is there, and only with `dryRun: true`. Each replaces a shell command
that breaks the graph:

| Tool                               | Instead of                                                    |
|------------------------------------|---------------------------------------------------------------|
| `rename` · `move`                  | `mv`, which leaves every inbound link pointing at nothing     |
| `delete`                           | `rm`; links into the note are reported, not rewritten         |
| `split_by_heading` · `merge_files` | Re-emitting whole documents                                   |
| `rename_tag`                       | `sed`, which cannot tell front matter from prose              |
| `build_listing`                    | Hand-maintaining the notes table between markers in the index |
| `fmt`                              | Any other formatter, see the hazard below                     |

Prose edits are made with ordinary file tools; the index is recomputed on the next call. A note
written that way is formatted when the session ends, and `awt check` runs then too, holding the
session open with the problem list if the graph broke. Only the paths a file tool wrote are
formatted. A note a shell command wrote is named in that report and left alone, because nothing
knows which files a shell command touched — run `awt fmt <path>` on it yourself.

- Nothing locks. A file that changed under a verb is listed in `skipped`, not overwritten, and
  running the verb again finishes the job.
- `unresolved` lists the links the verb would not guess at, such as an ambiguous stem.
- `split_by_heading` takes a heading-to-path plan and a source fate of `delete`, `stub` or
  `keep`. A target that already exists is skipped and reported; the other sections proceed.
- Every write accepts `dryRun`.

**The two surfaces are spelled differently, and no longer name quite the same set.** MCP tool names
are flat and keep their qualifiers — `split_by_heading`, `merge_files`, `build_listing`. The CLI
drops those (`awt split`, `awt merge`, `awt listing`) and groups the site commands under `awt site`,
which is a namespace and not an alias: there is no flat `awt serve` still working. One name exists
on one surface only — **`rename` is an MCP tool and not a command**, because the CLI folded it into
`awt move`, where a destination with no folder in it renames in place. `awt --help` is the
authority; this is only the warning not to translate a tool name into a command by habit.

Bare `awt check` and `awt fmt` mean the whole wiki from anywhere in the project. `awt fmt <path>`
resolves the path against the current directory, or against the workspace when `-w` is given; the
MCP `fmt` takes workspace-relative paths, and its `dryRun` is the CLI's `--dry-run`. `awt fmt --dry-run`
also runs the front-matter schemas that `awt.config.mjs` maps onto files.

## Formatting hazard

`awt fmt` tokenises `[[wikilinks]]` and `![[embeds]]`. A remark pipeline without a wikilink
plugin escapes them to `\[\[x]]` and `!\[\[x]]`. Both still render, so the diff looks cosmetic
while every edge in the graph is gone. After a bulk markdown operation by any other tool, run
`awt check` and compare `grep -rc '\[\['` counts before and after. `awt fmt` is also the formatter
for markdown with no wiki around it — a README, a `CLAUDE.md`, a docs tree — because `format` does not
depend on `core`; there is no second formatter to choose between.

## Front matter, an optional shape

```yaml
---
title: <matches the H1>
type: <string>
description: <one sentence>
status: <draft | stable | deprecated>
tags: [<tag>, <tag>]
---
```

A project that fixes vocabularies can hold them as JSON schemas in `wiki/schemas/`, mapped to
globs in `awt.config.mjs` and checked by `awt fmt --dry-run`.

## Open Knowledge Format, optional

[OKF](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf) is a vendor-neutral
spec for markdown knowledge bundles, and a wiki of this shape is close to one. Whether a project
has adopted it is the project's to say. The parts that touch how notes are written:

| Field      | Detail                                                                          |
|------------|---------------------------------------------------------------------------------|
| `type`     | Required, a non-empty string. Values are producer-defined                       |
| `index.md` | Reserved for a listing; no front matter except `okf_version` at the bundle root |
| `log.md`   | Reserved for a chronology, newest first, `YYYY-MM-DD` headings                  |
| `status`   | `draft` · `stable` · `deprecated`; absent means `stable`                        |
| `sources`  | A list of mappings, each with `resource`                                        |
| `verified` | A list of `{by, at}`; `generated` names the author. Extra keys are legal        |

OKF expresses the graph as bundle-relative markdown links. The toolbox reads `[[wikilinks]]`, so
a wiki using both keeps its edges in wikilinks and a generic OKF consumer sees the notes without
the edges. That is a legal extension, not a conformance break.

## Other wikis

`interop.md` beside this file covers wikis mounted read-only, references across wikis, and an
optional message convention.
