---
description: Read a wiki before working in it — which wiki it is, what its index says to read first, and the rules it runs on that no skill can tell you.
---

# Orient in this wiki

The reading pass that comes before the first note is opened or edited. It is short by design: one
command and two reads, ending in a handful of lines rather than a survey.

## 1. Which wiki, and is it healthy

```shell
awt check --json
```

`notesDir` is the answer to *which wiki*, and it is worth having before anything is read: with no
`awt.config.mjs` above the working directory the workspace falls back to the current directory. The
counts and `healthy` come free in the same call. A wiki that is already unhealthy changes what the
work is, so notice it now rather than at `Stop`.

## 2. The index

`index.md` at the root of `notesDir`. OKF reserves it for a listing, and a working wiki puts more
than a listing in it — what the wiki is for, the axis its folders run on, and, when it has them, the
reading paths that say which notes to start from for a given subject. **Follow one reading path if
it matches the work at hand**; that is the wiki's own answer to the question this command is asking,
and it beats anything derived from the file tree.

## 3. The rules the wiki declares for itself

`meta/` when there is one, or whatever the index points at. What is being looked for:

- **What belongs in this wiki**, and which fact is owned by a file outside it instead.
- **The folder axis and what the front-matter fields mean here** — the vocabularies, and which of
  them a schema enforces rather than merely recommends.
- **How notes link**, where this wiki has made a choice about it.
- **Anything the wiki declares as a deviation.** These are the sentences worth reading twice; they
  exist because something here is not what a reader would assume.

**Read for the wiki's choices, not for mechanics.** How the tools work, what the hazards are and what
a health check means are the skill's, identical in every wiki, and already loaded. A `meta/` note is
not evidence about a tool. What no skill can tell you is what *this* wiki decided — that is the whole
content of this pass.

**A wiki with no rules of its own is a finding, not a gap to fill.** Say so and work to what the notes
actually do. Inventing conventions for a wiki that declares none is how a second set of rules starts.

## 4. Report, in a few lines

Where the wiki is, what it is for, the axis and the vocabularies, its health, and which notes the
index says to read for the work at hand. Then start the work.

## What this is not

- **Not a survey.** Do not read every note, or summarise the listing back. The index already lists
  them, and a paraphrase of it is the least useful thing that can be put in front of the user.
- **Not a health check.** `/awt:check` is that; this reads `--json` only to know which wiki it is in
  and whether the ground is level.
- **Not a write.** Nothing here creates, renames or moves a note. If orienting turns up something
  wrong in `meta/` or the index, say so and let the user decide — a rule is a project decision.
