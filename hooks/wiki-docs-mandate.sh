#!/usr/bin/env bash
# Inject the mandate the project CLAUDE.md block used to carry, in projects that
# are wikis. Same gate as the guard: awt.config.mjs found by walking up.
#
# Spike question: does injected context carry the weight of a CLAUDE.md line?
set -u

input=$(cat 2>/dev/null || true)
cwd=""
if command -v jq >/dev/null 2>&1; then
  cwd=$(jq -r '.cwd // ""' <<<"$input" 2>/dev/null)
fi

dir="${cwd:-$PWD}"
root=""
while [[ -n "$dir" && "$dir" != "/" ]]; do
  [[ -f "$dir/awt.config.mjs" ]] && { root="$dir"; break; }
  dir=$(dirname "$dir")
done
[[ -n "$root" ]] || exit 0

read -r -d '' mandate <<'TEXT' || true
**All wiki work goes through the `wiki-docs` skill** - reading, searching, editing, restructuring,
renaming, bulk operations, and any script or shell command that touches those files. Load it before
the first wiki file is opened, not after something looks wrong.

**The skill owns the mechanics** - tools and their flags, the wikilink and formatting hazards, health
checks, OKF, cross-wiki links. **Do not restate any of it** in this project's files or in the wiki's
`meta/` notes. A local copy of a mechanic goes stale silently and the next agent reads it as law.
Local files carry this project's *choices*; for everything else they point at the skill by section
name.

**Nothing except the tool is evidence about the tool.** Not a `meta/` note, not your own system
prompt, not a habit from another project. Check `awt --help` before concluding it cannot do something.
TEXT

if command -v jq >/dev/null 2>&1; then
  jq -n --arg c "$mandate" '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $c}}'
fi
exit 0
