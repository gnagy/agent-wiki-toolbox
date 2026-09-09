---
description: The link graph and the formatting in one answer — run `awt check` and `awt fmt --check` together and report once, keeping the distinction between a problem and a placeholder that the tool already draws.
---

# Check this wiki

Both halves of a health check, asked now rather than at the end of the session, and reported as one
answer.

```shell
awt check
awt fmt --check
```

**Confirm it is pointed at the right wiki before reading anything into the numbers.** The `--json`
form of the check reports `notesDir`. With no `awt.config.mjs` above the working directory the
workspace falls back to the current directory, so a run from the wrong place walks whatever markdown
is underneath it and reports confidently on notes nobody owns — a temp directory full of old
fixtures produces dozens of ambiguous links, and every one of them is noise. If `notesDir` is not
this project's wiki, say so and stop rather than reporting the result.

**Neither exit code is the answer by itself.** `awt check` exits non-zero for problems and for
nothing else it reports; `awt fmt --check` exits non-zero for a file that is unformatted *or* whose
front matter the schemas reject. Run both, then answer once.

## What the answer has to keep apart

The tool already separates these, and the separation is not a judgement call to be re-made in the
report. The skill's *Reading* section says what each category is.

| Reported                              | What the answer does with it                                                          |
|---------------------------------------|---------------------------------------------------------------------------------------|
| `problems`                            | These are the failures. Name each one and fix it with the verbs before finishing      |
| `placeholders`, `orphans`, `deadends` | Give the counts. Name individual ones only if asked, or if a count moved unexpectedly |
| `unreferenced`, `crossWikiLinks`      | Counts, same rule                                                                     |
| `awt fmt --check`                     | Name the files. A schema rejection is a different thing from unformatted; say which   |

**Do not promote a placeholder to a failure.** Every working wiki has a backlog of links to notes
nobody has written, and reporting them as breakage teaches the reader to ignore the whole report.
The one case worth raising unprompted is a count that moved when the session did not intend it to.

## Fix nothing on the way past

`awt fmt` over a whole wiki rewrites every note in it, which is why the `Stop` hook formats only the
paths the session actually wrote. Keep that here:

- Files **this session wrote** that come back unformatted: format those paths and say so.
- Anything else: report it. Reformatting notes the session never opened puts a diff in front of the
  user that they did not ask for and cannot easily review.
- A `problems` entry is fixed with the verbs the skill names, never by editing the link text in
  place — the verb is what rewrites the other end.

## What this adds over the hook that already runs

Nothing about the checks; only when they are asked. The `Stop` hook runs both at the end of a
session, over what that session touched. This asks the same question mid-session, over the whole
wiki, and changes nothing — which is what makes it safe to run at any point, including before
starting work rather than after breaking something.
