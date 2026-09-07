---
description: Move a wiki from the old docs/wiki layout onto the one-home layout — wiki/notes, wiki/site, wiki/schemas, wiki/inbox — in one commit.
disable-model-invocation: true
---

# Moving a wiki to the home layout

**Run this once, on a project whose wiki is still `docs/wiki/` beside `site/`.** How to tell: `awt
check --json` from the project root reports a `notesDir` ending in `docs/wiki`, and the first `awt`
command of a session prints one line saying the project is laid out the old way. A project already
reporting `wiki/notes` is done and this command does not apply — say so and stop.

**What the move is for** is one home, named once, with every other directory a fixed name inside it,
and no second copy of the path anywhere. The old shape keeps working indefinitely — the toolbox reads
it as legacy — so this is not urgent. It is worth doing because every file that restated the path is
one `/awt:adopt` has to police, and afterwards there is one.

**It is a wiki edit and a repo edit at once, and neither the write verbs nor `mv` are right for the
first half.** The notes move as a directory, with `git mv`, so their history follows and every
`[[wikilink]]` inside is untouched — links are relative to the notes root, and the root is what
moves. Nothing inside the notes changes.

Work from the project root, on a clean working tree.

## 1. Read what names the old paths

Before moving anything:

```shell
grep -rnE 'docs/wiki|\bsite/|\.remark|wiki-inbox' \
  awt.config.mjs .mcp.json CLAUDE.md README.md AGENTS.md bin/ .claude/ site/README.md \
  site/quartz.config.yaml docs/wiki/meta/ docs/wiki/index.md docs/wiki/log.md 2>/dev/null
```

Every hit is either a path to rewrite in §4 or prose to rewrite in §5. Keep the list.

## 2. Move the directories

```shell
mkdir -p wiki
git mv docs/wiki       wiki/notes
git mv site            wiki/site         # if the project has one
git mv .remark         wiki/schemas      # if it has schemas
git mv docs/wiki-inbox wiki/inbox        # if it exists — it may not, between messages
```

`git mv` carries untracked files inside `site/` along — the Quartz clone, `public/`, the plugin
symlinks — so nothing has to be rebuilt. The symlinks `bootstrap-quartz` made are absolute or
relative within `site/` and survive the move; the one from the clone back to `quartz.config.yaml` is
relative and survives too. Re-run `bootstrap-quartz` afterwards if anything about the site looks off;
it is idempotent.

## 3. Rewrite `awt.config.mjs`

- `rootDir` — leave it unwritten if the home is `./wiki`; write it only for a different home.
- Schema paths — `./.remark/x.json` becomes `./wiki/schemas/x.json`.
- **Schema globs are relative to the notes now.** `docs/wiki/meta/**/*.md` becomes `meta/**/*.md`. A
  glob still spelling out `wiki/notes/` matches nothing and says nothing, because the layout anchors
  globs to the notes directory. **This is the one edit that fails silently if skipped.**

Then `awt fmt --check` from the project root and confirm the schemas fire: introduce a deliberate bad
`status` in one note, see it reported, revert it.

## 4. Shrink what named the path

- **`.mcp.json`**: if the project still declares its own `agent-wiki-toolbox` server, this is the
  moment it goes — the plugin declares one and finds the notes by walking up. Read-only mounts of
  *other* projects' wikis stay, and each keeps its absolute path to that project's notes.
- **The guard hook**: a project copy of `wiki-docs-guard.sh` carried `WIKI_ROOT` as the one copy of
  the layout outside `awt.config.mjs`. The plugin's guard reads the config, so the copy goes rather
  than being updated. Remove its `.claude/settings.json` entry with it.

Both are `/awt:adopt` §1; run it after this if you would rather do them there.

## 5. Rewrite the prose that named the old paths

The list from §1. `CLAUDE.md`, the README, `wiki/site/README.md`, `meta/interop.md`'s inbox
declaration, any `bin/` wrapper that `cd`s into `site/`. **The `meta/` notes are the ones to read
carefully**: a note saying *the schemas live in `.remark/`* was a choice when written and is now a
stale path. Reduce each to the choice it records, or delete it.

## 6. Tell the wikis that depend on this one

A registry in another project's `site/quartz.config.yaml` names this wiki's build output by relative
path — `../../this-project/site/public/static/contentIndex.json` — and now has to say
`../../this-project/wiki/site/public/…`. The resolver warns rather than fails on a missing index, so
a stale registry shows up as every cross-wiki link into this wiki going dead with a warning in *that*
project's build log, not as an error here. Send that project a message through its inbox, or fix it
if it is yours.

## 7. Verify, then commit as one change

```shell
awt check                         # notesDir is wiki/notes, and no legacy line
awt fmt --check                   # formatting and the schemas
git status                        # nothing untracked that used to be ignored
```

Then §1's grep once more over the new paths — a `docs/wiki` that survives is either history, which is
fine in `log.md`, or a stale instruction, which is not.

**What does not change:** the notes themselves, every wikilink, every rendered URL, the site's
`quartz.config.yaml`, the pin, and the port. **What stays behind on purpose:** `.mcp.json` and
`.claude/`, at the repo root where the harness looks for them.
