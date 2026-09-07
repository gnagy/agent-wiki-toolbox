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

## Testing it beside the old install

`scripts/plugin-session` starts a session with the plugin loaded and the project's own server out of
the way. Run it from the project being tested; it changes nothing on the machine.

**The switch is three switches, not one**, and each reverses on its own:

| Piece      | Trial                                                 | Switch                            | Reverse                       |
|------------|-------------------------------------------------------|-----------------------------------|-------------------------------|
| Plugin     | `--plugin-dir`, per session, writes nothing           | marketplace + install             | uninstall                     |
| Skill      | type `/awt:wiki-docs`; or unlink the standalone one   | `skills add` stops being run      | one `ln -s`                   |
| MCP server | `--disallowedTools 'mcp__agent-wiki-toolbox__*'`      | drop the project `.mcp.json` entry | `git checkout .mcp.json`      |
| `awt`      | untestable through the shim by design                 | shim installs to plugin data      | `bin/install` again           |

Only the marketplace install writes outside the projects, so the trial stays on `--plugin-dir` for
its whole length.

**`--strict-mcp-config` is not the isolation flag.** It suppresses the plugin's server along with the
project's; a session started with it has no wiki tools at all. `--disallowedTools` with a glob is
what works: the project server still starts, but its tools are gone from the list and only
`mcp__plugin_awt_agent-wiki-toolbox__*` remains.

**The skill is the one thing a flag cannot separate.** Both `wiki-docs` and `awt:wiki-docs` are
listed, with the same description, so an automatic load picks one and the transcript is the only
place that says which. Naming it settles a single session; unlinking `~/.claude/skills/wiki-docs`
settles a week of them, and the canonical copy under `~/.agents/skills` survives the unlink.

**Three wikis exist to test in**, and they are not equivalent: this workspace has no guard hook, so it
tests the plugin's guard alone. Atlas has the copied guard and tests the two together — they share a
marker file, so a session is denied once rather than twice, which is worth confirming rather than
assuming. Ghostbusters has a server entry and no guard.

## One thing the switch has to fix

`bin/` is a PATH namespace once the plugin is loaded, so `bin/install` becomes a command called
`install` on every machine that installs the plugin. It loses to `/usr/bin/install` today because the
plugin's directory is appended, not prepended — which is luck, not design. At switch time `install`
belongs in `scripts/`, leaving `bin/` holding only what the plugin means to publish. Moving it is a
rename in `README.md`, the workspace `CLAUDE.md` and the wiki, so it waits for the switch.
