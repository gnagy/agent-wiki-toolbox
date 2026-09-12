# Setting up `awt`

How to get the toolbox running on a machine, either from nothing or from the `bin/install` +
`skills add` setup that predates the plugin. `README.md`'s *The binary* section says what gets
installed and why; this file is the sequence of commands for doing it, both ways, and the drift a
half-finished switch leaves behind — both the plugin switch and, separately, a project's own Quartz
install still sitting on the git-clone-and-`npm`-install mechanism that predates *its* switch to bun.
A project can be fully current on one and stale on the other; they are not the same upgrade.

## Prerequisites

- **`bun` on `PATH`**, the version `mise.toml` pins (`1.3.14` as of this writing) — `command -v bun`.
  The install script refuses to run without it, on purpose: a machine with only `npm` would resolve
  its own versions instead of the ones `bun.lock` pins, which is exactly what a formatter that has to
  stay byte-identical to IntelliJ cannot tolerate.
- **`node`**, the version `mise.toml` pins (`24.18.0`), needed only for `npm test` and for the Quartz
  plugins, which run inside Quartz's own node process. Not needed to install or run `awt` itself.
- **A Claude Code build that adopts a plugin from `~/.claude/skills/`.** A directory there carrying
  `.claude-plugin/plugin.json` is adopted as a plugin named `<name>@skills-dir` — the mechanism
  `scripts/install` relies on, and the reason nothing here touches
  `~/.claude/plugins/known_marketplaces.json` or `installed_plugins.json`. Those are the marketplace
  path, for a plugin fetched by a team that isn't cloning this repo; a working copy on this machine
  never needs it.

## Clean install

Nothing of the toolbox on this machine yet — no `~/.local/lib/agent-wiki-toolbox`, no
`~/.agents/skills/wiki-docs`.

```shell
git clone git@github.com:gnagy/agent-wiki-toolbox.git
cd agent-wiki-toolbox
scripts/install
```

That copies the working copy to `~/.claude/skills/awt`, runs `bun install --production` there, and
points `~/.local/bin/awt` at `$PLUGIN/bin/awt`. Verify:

```shell
awt --version   # reports the commit scripts/install stamped, e.g. "awt 0.0.0 (7d754a3)"
```

**Then start a new Claude Code session** — a running one keeps whatever it already loaded, so this
is the one step nothing shortcuts. In the new session:

- `/awt:wiki-docs` loads the skill (bare `/wiki-docs` does not exist; a plugin skill is always
  `<plugin>:<skill>`).
- A project with `awt.config.mjs` above it shows the wiki's MCP tools, scoped as
  `mcp__plugin_awt_agent-wiki-toolbox__*`.
- The `SessionStart` hook's mandate appears in context, and a first write into the wiki is guarded
  once per session.

**Nothing in a project needs to name the plugin.** Every automatic part — the guard, the MCP server,
the mandate, the format-and-check at `Stop` — is gated on `awt.config.mjs` at the project root and
inert without it. A project that has no wiki yet gets one from `/awt:init`.

## Upgrading from a pre-plugin install

A machine that ran the old `bin/install` (into `~/.local/lib/agent-wiki-toolbox`, npm-based) and
installed `wiki-docs` as a standalone skill (`npx skills add ... --skill wiki-docs`, landing in
`~/.agents/skills/wiki-docs` and symlinked into `~/.claude/skills/wiki-docs`). Both are superseded —
the plugin ships its own copy of the skill — and leaving either in place produces duplicates rather
than errors, which is the failure mode worth planning around: a doubled tool surface or a guard that
fires twice reads as a bug report from a session, not as an install log entry.

### 1. Remove the old machine-level install

```shell
rm -rf ~/.local/lib/agent-wiki-toolbox
rm -f ~/.local/bin/awt
rm -f ~/.claude/skills/wiki-docs        # the symlink `skills add` created
rm -rf ~/.agents/skills/wiki-docs       # the actual install target
```

Confirm clean before moving on — `scripts/install` replaces `~/.claude/skills/awt` wholesale, but it
does not know about paths outside that:

```shell
which awt        # nothing
ls ~/.claude/skills/ | grep wiki-docs   # nothing
```

### 2. Install the plugin

```shell
cd agent-wiki-toolbox   # the working copy, pulled to the commit you want installed
scripts/install
awt --version
```

### 3. Reconcile every project that was wired to the old setup

A project that ran the old skill's adoption sweep is carrying **three** things the plugin now owns,
and a leftover copy is drift with teeth — a second implementation nothing propagates a fix to:

| Leftover                                                         | Why it goes                                                        |
|------------------------------------------------------------------|--------------------------------------------------------------------|
| A `wiki-docs:begin`/`end` block in the project's `CLAUDE.md`     | The `SessionStart` hook injects the mandate; the copy can't update |
| `.claude/hooks/wiki-docs-guard.sh` and its `settings.json` entry | The plugin guards by walking up to `awt.config.mjs` itself         |
| An `agent-wiki-toolbox` server in the project's `.mcp.json`      | The plugin declares its own; two entries start two servers         |

`/awt:adopt` §1 is the authoritative version of this table and the report format for it — run it
from each project's root rather than deleting by hand, since it also sweeps for restated mechanics
(a README or `meta/` note explaining how `awt` works, which goes stale the next time a flag is
renamed). **A read-only mount of another project's wiki stays** in `.mcp.json` — that is the
project's own choice, not a copy of a mechanic, and `/awt:adopt` knows the difference.

If a project's `.mcp.json` held nothing but the `agent-wiki-toolbox` entry, delete the file, not just
the entry — an empty `mcpServers` object is a second way of saying "no project server" that a later
reader has to notice means the same thing as absence.

### 4. Verify

```shell
awt --version           # the new commit
awt check                # this machine's wikis still resolve and are healthy
awt fmt --dry-run        # formatting and front matter, unaffected by the switch
```

And, per project: a fresh session, `/awt:wiki-docs`, no `mcp__agent-wiki-toolbox__*` tools bare
(only the `mcp__plugin_awt_agent-wiki-toolbox__*` form), and the wiki-write guard firing once, not
twice.

A project's own Quartz install is a separate thing to check — see the next section, which applies
whether or not this machine ever ran a pre-plugin `awt`.

## Moving a project's Quartz install off the old clone

**This is not part of the pre-plugin upgrade above, and does not require it.** A project can already
be fully on the plugin and still have a `site/` built the old way — every wiki that existed before
Quartz moved to a bun-installed git dependency (decision 20; see `quartz-install-sharing.md` in the
AiSandbox workspace wiki for the evidence) is in exactly this state until someone re-runs
`awt site setup` for it. Symptoms if this is skipped: `awt site serve`/`publish` still work (the old
`site/.quartz-src` clone builds fine on its own), so nothing forces the question — the cost is just
that the project keeps paying its own ~250–280 MB clone and `npm install` instead of sharing one
install with every other project on the machine, and its Quartz plugins may still be symlinked into a
path that no longer exists (`~/.local/lib/agent-wiki-toolbox`, removed by the pre-plugin upgrade
above) or into an intermediate one (`~/.claude/skills/awt`, correct at the time but from before the
plugin symlinks moved a level deeper). **Quartz never re-resolves a plugin directory it has already
installed**, so any of these is a silent no-op, not a build failure — the site keeps rendering with
whatever code it last resolved, with no error telling you so.

### 1. Take the new install

```shell
awt site setup
```

Writes `site/package.json` (naming the toolbox's current `quartz.pin` as a git dependency) and
`site/bun.lock`, then `bun install`s — which is what actually fetches Quartz into
`site/node_modules/quartz` and rewires the config and plugin symlinks to match. Safe to run whether
the project has never been set up, is on the old clone, or is already current; it does not touch or
remove what it replaces.

### 2. Remove what it replaced

`awt site setup` adds the new files; it does not delete the old ones, the same way it will not rewrite
a `.gitignore` it does not own. Once step 1 has succeeded (`site/node_modules/quartz` exists), these
are dead weight, not a fallback — nothing reads them. **Not every project carries all three**: one that
was never built locally between the plugin switch and this one has only `quartz.pin`, with no clone and
no symlinks to show for it. The commands below are safe either way — `rm -rf`/`rm -f` on a path that was
never there is a no-op, not an error.

| Leftover                                                               | Why it goes                                                                                                        |
|------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------|
| `site/.quartz-src/`                                                    | The old git clone plus its own `npm install` — the ~250–280 MB this whole switch exists to stop paying per project |
| `site/quartz.pin`                                                      | Read from the toolbox's own `quartz.pin` now, not per project — every wiki this machine builds shares one pin      |
| `site/awt-links`, `awt-cross-wiki`, `awt-headings`, `awt-folder-notes` | Moved one level deeper, to `site/node_modules/`, to match where bun puts Quartz                                    |

```shell
rm -rf site/.quartz-src site/quartz.pin
rm -f site/awt-links site/awt-cross-wiki site/awt-headings site/awt-folder-notes
```

### 3. Update `.gitignore`

`awt site setup` only warns about a `.gitignore` it does not own — see its own message when it runs.
Replace the old `.quartz-src/` entry (and the four `awt-*` lines, if the project ever tracked them
explicitly) with `node_modules/`, which covers all of them at their new location. `bootstrap.js`'s own
`GITIGNORE` constant is the current, authoritative form if there is any doubt what a fresh project's
file should contain.

### 4. Verify

```shell
awt site serve
```

Emits the index and builds itself — no separate `awt site index` step, that is what `serve` exists to
never let come apart. A clean build with both `awt-links` and `awt-headings` agreeing is the whole
test; there is nothing Quartz-specific left to check once that passes. `git status` on `site/` should
show `package.json` and `bun.lock` as the only new tracked files, and nothing named `.quartz-src` or
`quartz.pin` anywhere under it.

## Consumers the plugin install does not reach

Three things read `awt` from outside any Claude Code session, so installing the plugin does not
touch them and each needs its own check after a switch:

- **A plain shell, a terminal, a scheduled job, a non-Claude agent.** All of these get the new
  binary automatically, because `scripts/install` repoints the same `~/.local/bin/awt` symlink the
  old `bin/install` used — but they now need `bun` on `PATH` too, since the binary's shebang is
  `bun`, not `node`. A `launchd` job or anything else with a minimal environment can lose `awt` this
  way with no message beyond "command not found".
- **A read-only `.mcp.json` mount of another project's wiki** (`awt mcp -w
  ../other/wiki/notes --name other`). This is a project's own choice, not a mechanic the plugin owns
  — it keeps working unchanged, naming the same `awt` on `PATH`.
- **A Quartz site build**, covered above.

## Uninstalling

```shell
rm -rf ~/.claude/skills/awt
rm -f ~/.local/bin/awt
```

Both reverse cleanly, with nothing left on disk pointing at either — that is what "one target, not
two" in `scripts/install`'s own header comment means in practice.
