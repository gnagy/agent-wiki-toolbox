# Plugin spike

Throwaway. This branch turns the toolbox repo into a Claude Code plugin far enough to answer the
questions step 1 of `wiki-docs-as-a-plugin.md` asks, and no further. Nothing here is packaging:
`bin/awt` execs whatever `bin/install` already put on the machine, and `skills/wiki-docs/` is a copy
of the skills repo, not the move.

Load it with `claude --plugin-dir tools/agent-wiki-toolbox` from a wiki project.

## What it answered

**A plugin skill is always `<plugin>:<skill>`.** `skills/wiki-docs/SKILL.md` gives
`wiki-docs:wiki-docs`; a `SKILL.md` at the plugin root gives the same doubling, tested with a
throwaway plugin named `wiki-docs-probe` and reported by the session as
`wiki-docs-probe:wiki-docs-probe`. The bare `/wiki-docs` does not survive the plugin form, so the
plugin is named `awt` and the invocation is `/awt:wiki-docs`.

**MCP tools are scoped to `mcp__plugin_<plugin>_<server>__<tool>`.** With the plugin loaded beside
the workspace's own `.mcp.json`, both servers ran and the whole tool surface appeared twice, once
bare and once scoped. Removing the project entry is not tidying; it is what stops two node processes
serving the same wiki.

**`SessionStart` `additionalContext` arrives, attributed.** A probe session quoted the mandate's
first sentence back and named its source as a SessionStart hook, unprompted. So the mechanism
delivers, and the model can tell hook-injected context from a `CLAUDE.md` line. Whether it carries
the same weight is a question about behaviour over many sessions, which one probe cannot settle.

**`bin/` is on the Bash tool's PATH, appended.** `/usr/bin/install` still wins over this repo's
`bin/install`, and an existing `~/.local/bin/awt` still wins over the plugin's `bin/awt`. Both
collisions are real but neither is dangerous today. The one that matters: a skill sentence saying
"run `awt`" gets the old install, not the plugin's copy, on any machine that ran `bin/install` once.

## What it does not do

Step 2's toolbox changes are not in it: the server still serves the current directory as a zero-note
wiki outside a project, and still resolves the layout once at startup.

The guard still fires on read-only Bash commands, spending its one fire per session on a `cat`. That
narrowing waits on the `Stop`-time check.
