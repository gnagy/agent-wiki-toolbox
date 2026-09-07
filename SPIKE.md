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
| Plugin     | `--plugin-dir`, per session, writes nothing           | a directory in `~/.claude/skills` | delete it                     |
| Skill      | type `/awt:wiki-docs`; or unlink the standalone one   | `skills add` stops being run      | one `ln -s`                   |
| MCP server | `--disallowedTools 'mcp__agent-wiki-toolbox__*'`      | drop the project `.mcp.json` entry | `git checkout .mcp.json`      |
| `awt`      | `AWT_SHIM_PREFER_INSTALL=1` runs the machine's copy   | nothing: deps install in place    | `bin/install` again           |

**A marketplace is not the only way to install one.** A directory under `~/.claude/skills/` holding a
`.claude-plugin/plugin.json` is adopted as a plugin in its own right, as `<name>@skills-dir` — the
same directory the skills already live in, and what `claude plugin init` scaffolds into. So the
switch is the shape `skills add` already has: put a copy where the skills go, no marketplace file, no
`known_marketplaces.json` entry. A marketplace is for other machines and other people.

Both paths write into `~/.claude`, which is why the trial stays on `--plugin-dir`: it is the only one
that writes nothing at all. Whether a *symlink* under `~/.claude/skills/` is adopted the way a real
directory is, is untested — and it does not matter much, because the workspace rule against
symlinking a working copy into a consumer says the install is a copy either way, and `--plugin-dir`
already gives a trial the live working copy with no footprint.

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

## `bin/install` does not go away

Three consumers of `~/.local/lib/agent-wiki-toolbox` are outside any Claude Code session, so no
plugin install reaches them:

- **Quartz site builds.** A rendered wiki's `site/` holds symlinks straight into the install:
  `wiki/site/awt-links -> ~/.local/lib/agent-wiki-toolbox/quartz-plugins/quartz-links`, four of them
  in this workspace alone. Repointing those at a plugin directory would make a site build depend on
  an agent harness being installed, which is the coupling the repo's own standalone rule forbids.
- **`.mcp.json` mount entries.** A read-only mount is `awt mcp -w ../other/wiki/notes --name other`
  in the project's own config, and a project config has no `${CLAUDE_PLUGIN_ROOT}` to name. This one
  can disappear, but only by moving mounts into `awt.config.mjs` so the plugin's own server starts
  them.
- **A plain shell, and every agent that is not this one.** `awt check` in a terminal, `awt --version`
  as the answer to what is running, a junie or universal session. The plugin's `bin/` is on PATH
  inside a Claude Code session that loaded it, and nowhere else.

And the plugin needs the install logic rather than replacing it: a shim that installs into
`${CLAUDE_PLUGIN_DATA}` on first use is `bin/install`'s copy-tree plus `npm install --omit=dev` with
a different target.

So the split is: **the plugin releases the agent-facing parts** — skill, hooks, server — and
`bin/install` keeps releasing the machine-facing ones. What the plugin removes is having to run
`bin/install` to pick up a new skill or hook, not the install itself.

**Which raises a version question the analysis note answers differently.** It has release as
`claude plugin update`, refreshing skill, hook, server and binary together. But a machine with both
then has two `awt` copies that drift, and `awt --version` answers differently depending on whether it
is typed in a terminal or inside a session — the drift the plugin exists to remove, moved rather than
deleted. The version that keeps one stamp per machine is the reverse: **`bin/install` installs the
plugin too**, into `~/.claude/skills/awt`, so one command produces both targets at the same commit
and the marketplace is only ever for other machines. Untested; it is a step 4 decision, not a spike
finding.

## How other plugins ship a node dependency

Surveyed the 40 plugins in `claude-plugins-official`. Four ship a node server of their own — discord,
telegram, imessage, fakechat — and all four do the same thing:

```json
"start": "bun install --no-summary && bun server.ts"
```

launched as `bun run --cwd ${CLAUDE_PLUGIN_ROOT} --shell=bun --silent start`. **Dependencies install
in place, at server start, into the plugin's own directory.** No install step, no committed
`node_modules`, no data directory: the plugin directory is writable, and the install is idempotent
enough to run every time. The rest reach for `npx -y <pkg>@latest`, `uvx`, `docker run`, or a remote
HTTP server — every one of them a way to avoid shipping a dependency at all.

Measured for this toolbox, which is a seven-package npm workspace: **1.9s cold, 0.4s once installed**,
silent on both streams, with a warm npm cache. A machine that has never fetched these packages pays
network time on that first call, once.

So the `${CLAUDE_PLUGIN_DATA}` shim the analysis note called for is unnecessary, and `bin/awt` now
installs in place instead. Two details that pattern does not have to handle and this one does:

- **cwd.** Those servers do not care where they run; `awt` resolves the wiki by walking up from its
  cwd. So the install runs in a subshell and the exec keeps the caller's directory. `npm --prefix` or
  `bun --cwd` would move the server into the plugin root, where it would find no project.
- **stdout.** An MCP server speaks on stdout. `npm install --silent` is quiet, but `telegram` writes
  its install output to stderr explicitly (`bun install --no-summary 1>&2`), which is the safe habit.

One hazard the pattern brings to a `--plugin-dir` trial: the plugin directory **is** the working copy,
so `--omit=dev` there would prune the dev dependencies and break `npm test`. `bin/awt` installs only
when `node_modules` is absent, which is why a working copy that already has one is left alone.

**No plugin in that marketplace has a `bin/` directory at all**, so putting `awt` on the session PATH
is a road nobody has walked. The MCP server is how every one of them exposes its tool.

## Which package manager installs it

The shim reads the lockfile and runs the manager that wrote it, so switching this repo needs no
change to the plugin. A manager named by a lockfile but missing from PATH is an error, not a fall
back to npm: the lockfile is the version guarantee, and a formatter that has to stay byte-identical
to IntelliJ cannot quietly resolve a different `remark`.

All three were measured on this repo, cold into an empty tree and warm over an existing
`node_modules`, with every cache already populated:

| Manager | Cold  | Warm  | Worked on the repo as it stood                                      |
|---------|-------|-------|---------------------------------------------------------------------|
| npm     | 1.9s  | 0.38s | yes                                                                 |
| bun     | 2.4s  | 0.08s | yes, and it migrates `package-lock.json` to `bun.lock` on first run |
| pnpm    | 5.3s  | 0.22s | **no** — see below                                                  |

**bun is what the repo uses now**, pinned with node in `mise.toml` and named in `packageManager`.
`package-lock.json` is gone, `bin/install` runs `bun install --production`, and 238 tests and the
layering check pass on a tree bun installed from scratch. Nothing is written against bun's runtime:
the shebangs are still `node` and the tests are still `node --test`, so bun installs and node runs.

**pnpm needs the workspace protocol.** Every internal dependency here is `"@agent-wiki-toolbox/x":
"*"`, which npm and bun link to the local package and pnpm resolves against the registry, where it
404s. Six `package.json` files have to say `"workspace:*"` instead, plus a `pnpm-workspace.yaml`,
because pnpm does not read npm's `workspaces` field. With that done it installs and `awt` runs.
`link-workspace-packages=true` in an `.npmrc` did not substitute for the rewrite on pnpm 11.

Disk is the argument the timings do not show. This design ends up with three copies of a 247 MB
`node_modules` — working copy, `~/.local/lib`, plugin — and npm pays for all three. pnpm hardlinks
from a shared store and bun clones through APFS, so under either the second and third copies cost
almost nothing.

pnpm stays untried beyond the scratch copy. If it is ever wanted, the `workspace:*` rewrite is the
whole of the work, and `bin/awt` already follows whichever lockfile it finds.
