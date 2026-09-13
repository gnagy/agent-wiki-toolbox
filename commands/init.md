---
description: Bootstrap a wiki in this project — write awt.config.mjs, create the notes skeleton, then stop and agree the structure before writing notes.
disable-model-invocation: true
---

# Bootstrapping a wiki

Add a wiki to this project, or finish one that was started and left without a config.

**`awt.config.mjs` at the project root is the whole of adoption.** Every automatic part of the plugin
— the guard, the touch record, the format-and-check at `Stop`, the mandate — is gated on that file
and inert without it, so a project is not something that installs the plugin, it is something the
plugin recognises. This command is the manual entry point that creates what the automatic parts wait
for. **The config comes first, even empty**: it is what makes `awt` and the server find the notes from
anywhere in the project.

The server resolves the layout on every call, so a wiki bootstrapped mid-session is found on the next
call. Nothing has to be restarted.

## 1. Check there is not one already

```shell
awt check --json 2>&1 | head -5
```

A `notesDir` that resolves means the project has a wiki; this command does not apply, and if the
layout is the old `docs/wiki` the command wanted is `/awt:move-layout`.

## 2. The layout

One home, named once. The four names inside it are the toolbox's convention and are not
configurable, so nothing outside the home needs to name anything inside it:

```
awt.config.mjs        # rootDir names the home; ./wiki is the default, so usually unwritten
wiki/
  notes/              # the wiki root — every workspace-relative path is relative to this
  site/               # the rendered site's install and build; absent until `awt site setup`
  schemas/            # front-matter schemas; absent until the project fixes a vocabulary
  inbox/              # the interop inbox; absent until a message arrives
```

**Nothing else states the layout** — not a `meta/` note, not a schema glob — because a second copy of
a path is the one that goes stale.

```js
// awt.config.mjs
export default {}
```

`export default {}` is enough. Write `rootDir` only if the home is not `./wiki`. A site, when
wanted, is `site: {title: '…', self: '…'}` in the same file and `awt site setup`; the Quartz config is
derived from that and never written by hand.

## 3. The skeleton

```
wiki/notes/
  index.md             # home and index of notes (OKF reserves this name; no front matter)
  meta/conventions.md  # front-matter vocabularies, folders, filenames, linking
  meta/scope.md        # what belongs here, vs. which repo files own a fact instead
```

`meta/conventions.md` gets the wikilink rule and its OKF deviation as part of the skeleton — see
*Wikilinks vs. OKF links* in the skill. That one is not something to agree first; it follows from the
toolbox reading `[[wikilinks]]`.

**Write these two `meta/` notes as this project's *choices* and nothing else.** Vocabularies, folder
layout, the navigation axis, what belongs in the wiki. No tool names, no flags, no hazards — those
are the skill's, and a local copy of one goes stale silently and is read as law by the next agent.
`/awt:adopt` exists because that happens anyway.

## 4. Stop

**Agree the structure with the user before writing a large number of notes.** Layout and taxonomy are
much cheaper to settle now than with fifty notes to migrate. Propose the folder axis and the
front-matter vocabulary, say what you inferred them from, and wait.

Then `awt check` — a new wiki is a clean graph with an unreferenced `index.md`, and that is what a
correct start looks like.
