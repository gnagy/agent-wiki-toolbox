#!/usr/bin/env bash
# Inject the mandate the project CLAUDE.md block used to carry, in projects that
# are wikis. Same gate as the guard: awt.config.mjs found by walking up.
#
# The text is in wiki-docs-mandate.txt beside this script, because
# wiki-docs-subagent.sh injects the same mandate and two copies of it would be
# the exact failure the mandate's own second paragraph describes.
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

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)" || exit 0
mandate=$(cat "$here/wiki-docs-mandate.txt" 2>/dev/null) || exit 0
[[ -n "$mandate" ]] || exit 0

if command -v jq >/dev/null 2>&1; then
  jq -n --arg c "$mandate" '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $c}}'
fi
exit 0
