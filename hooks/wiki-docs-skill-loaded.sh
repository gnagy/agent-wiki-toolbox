#!/usr/bin/env bash
# Record that this session loaded the wiki-docs skill, keyed by project root.
#
# The write guard used to gate its one nudge on session_id. A mid-conversation
# resume gets a new session_id while the conversation carries over, so the
# guard found no marker and fired a second time on an agent that had already
# loaded the skill long before. Root survives a resume where session_id does
# not, so this marker -- and the guard's own "already fired" marker -- are both
# keyed on root instead. This hook is what lets the guard tell "never nudged"
# apart from "nudged, and the agent did what it said."
#
# Fails open by design: if this never fires, the guard still falls back to
# nudging once per root, same as before.
set -u

command -v jq >/dev/null 2>&1 || exit 0

input=$(cat 2>/dev/null || true)
skill=$(jq -r '.tool_input.skill // ""' <<<"$input" 2>/dev/null)

# Matches "wiki-docs" and any "<plugin>:wiki-docs" scoping.
case "$skill" in
  wiki-docs|*:wiki-docs) ;;
  *) exit 0 ;;
esac

cwd=$(jq -r '.cwd // ""' <<<"$input" 2>/dev/null)
dir="${cwd:-$PWD}"
root=""
while [[ -n "$dir" && "$dir" != "/" ]]; do
  [[ -f "$dir/awt.config.mjs" ]] && { root="$dir"; break; }
  dir=$(dirname "$dir")
done
[[ -n "$root" ]] || exit 0

slug=$(printf '%s' "$root" | tr '/' '_')
: > "${TMPDIR:-/tmp}/wiki-docs-skill-loaded-${slug}" 2>/dev/null
exit 0
