#!/usr/bin/env bash
# Give a subagent the mandate its parent got at SessionStart.
#
# A subagent spawned by unrelated work -- a search, a refactor, a review that
# happens to reach a note -- starts without the skill and without the parent's
# SessionStart context, and then restructures notes with none of the guard the
# main session has. The write guard does not close the gap: it fires once per
# session and keys that fire on session_id, so if a subagent carries its parent's
# id the fire is already spent, and if it carries its own the nudge arrives only
# after a write has already been refused. Injecting the mandate here arrives
# before either, unconditionally.
#
# No matcher, deliberately. A SubagentStart matcher filters on agent type, and
# the subagents that need this most are the ones nobody wrote for this wiki. So
# the hook runs for every type and gates on the same thing the guard gates on --
# awt.config.mjs found by walking up -- which costs a few stat calls in a project
# that is not a wiki and nothing else.
#
# The mandate itself is wiki-docs-mandate.txt beside this script, the one copy,
# shared with the SessionStart hook.
#
# Fails open by design: a subagent that gets no context is a subagent as
# unguarded as it is today, not a broken one.
set -u

command -v jq >/dev/null 2>&1 || exit 0

input=$(cat 2>/dev/null || true)
cwd=$(jq -r '.cwd // ""' <<<"$input" 2>/dev/null)

dir="${cwd:-$PWD}"
root=""
while [[ -n "$dir" && "$dir" != "/" ]]; do
  [[ -f "$dir/awt.config.mjs" ]] && { root="$dir"; break; }
  dir="${dir%/*}"
done
[[ -n "$root" ]] || exit 0

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)" || exit 0
mandate=$(cat "$here/wiki-docs-mandate.txt" 2>/dev/null) || exit 0
[[ -n "$mandate" ]] || exit 0

# rootDir names the wiki's home, `wiki` when unsaid; `notes` is a fixed name
# inside it. Named outright, because a subagent given a narrow task has no reason
# to know which directory in this project is the one under the mandate.
rootdir=$(grep -oE "rootDir:[[:space:]]*['\"][^'\"]+['\"]" "$root/awt.config.mjs" 2>/dev/null |
          head -1 | sed -E "s/.*['\"]([^'\"]+)['\"].*/\1/")
notes="${rootdir:-wiki}/notes"

# IFS= , or read strips the trailing blank line that separates the two halves.
IFS= read -r -d '' preamble <<TEXT || true
**You are working inside a project wiki.** \`$root\` is the project and \`$notes\` holds the notes.
Whatever you were spawned to do, if it reaches those files, it is wiki work and the mandate below
governs it -- the parent session was given this and you were not.

**\`mv\`, \`rm\` and \`sed -i\` break the link graph** and nothing reports it. Renaming, moving,
deleting, splitting and merging a note are \`awt\` verbs that rewrite every inbound link. Prose edits
are ordinary file edits. \`awt check\` and \`awt fmt --check\` are what say whether you left it whole.

TEXT

jq -n --arg c "$preamble$mandate" \
  '{hookSpecificOutput: {hookEventName: "SubagentStart", additionalContext: $c}}'
exit 0
