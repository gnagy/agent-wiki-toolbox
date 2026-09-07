#!/usr/bin/env bash
# Format what the session wrote and check the graph before the session ends.
#
# Why Stop and not PostToolUse: a hook that formats after every Write changes the
# file under the agent and breaks the next Edit. At Stop the agent is done, so a
# rewrite costs nothing -- but only of files this session actually wrote, which
# is what wiki-docs-touch.sh records. A shell command that may have written notes
# we cannot name is reported, never silently reformatted: the blast radius of a
# whole-wiki fmt is every note, and the session opened a handful.
#
# The graph half is `awt check`. Problems block the stop and come back as the
# list; placeholders, orphans and dead ends do not -- the distinction check
# already draws, and the one a session must not be held hostage to.
#
# Fails open by design: anything wrong here lets the session end. Bash 3.2, which
# is what macOS ships, so no mapfile and no associative arrays.
set -u

command -v jq >/dev/null 2>&1 || exit 0

input=$(cat)
session=$(jq -r '.session_id // "nosession"' <<<"$input" 2>/dev/null)

state="${TMPDIR:-/tmp}/wiki-docs-${session}"
[[ -f "$state.touched" ]] || exit 0
root=$(<"$state.touched")
[[ -n "$root" && -d "$root" ]] || exit 0

# The plugin's own binary, not whatever a shell profile put on PATH: a session is
# checked by the toolbox it was run with.
plugin="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd)" || exit 0
awt="$plugin/bin/awt"
if [[ ! -x "$awt" ]]; then
  awt=$(command -v awt 2>/dev/null) || exit 0
fi
[[ -n "$awt" ]] || exit 0

cd "$root" 2>/dev/null || exit 0

strip_ansi() { sed -e 's/\[[0-9;]*m//g'; }

report=""
add() { report="$report$1"$'\n'; }

# 1. Format exactly what the session wrote, and nothing else. Idempotent, so the
#    second stop after a block re-runs it for nothing rather than for harm.
formatted=0
if [[ -s "$state.files" ]]; then
  live=()
  while IFS= read -r f; do
    [[ -n "$f" && -f "$f" ]] && live+=("$f")
  done < <(sort -u "$state.files" 2>/dev/null)
  if (( ${#live[@]} )); then
    formatted=$("$awt" fmt --json "${live[@]}" 2>/dev/null | jq -r '.files // 0' 2>/dev/null)
    [[ "$formatted" =~ ^[0-9]+$ ]] || formatted=0
  fi
fi

# 2. A shell command may have left an unformatted note behind. Name it; do not
#    reach into notes this session never opened.
if [[ -f "$state.opaque" ]] && ! "$awt" fmt --check >/dev/null 2>&1; then
  add "A shell command in this session wrote into the wiki, and notes are unformatted:"
  add ""
  add "$("$awt" fmt --check 2>&1 | strip_ansi | head -20)"
  add ""
  add "Run \`awt fmt <path>\` on what you wrote. Not the whole wiki, unless you meant to."
  add ""
fi

# 3. The graph. Problems only; placeholders and orphans are reported by check
#    separately and are not failures.
problems=$("$awt" check --json 2>/dev/null |
           jq -r '(.problems // [])[] | "  \(.path):\(.line) [\(.rule)] \(.message)"' 2>/dev/null)
if [[ -n "$problems" ]]; then
  add "\`awt check\` found problems in the link graph:"
  add ""
  add "$problems"
  add ""
  add "Fix them with the awt verbs before finishing."
  add ""
fi

[[ -n "${report//[[:space:]]/}" ]] || exit 0

(( formatted > 0 )) && add "($formatted note(s) this session wrote were formatted on the way out.)"

# A blocked stop that keeps blocking is worse than an unfixed link. Twice is
# enough for the agent to see the list and act on it; after that the report is
# printed and the session is let go.
blocks=0
[[ -f "$state.blocks" ]] && blocks=$(<"$state.blocks")
[[ "$blocks" =~ ^[0-9]+$ ]] || blocks=0
if (( blocks >= 2 )); then
  printf '%s\n' "$report"
  exit 0
fi
printf '%s\n' "$(( blocks + 1 ))" > "$state.blocks" 2>/dev/null || true

jq -n --arg r "$report" '{decision: "block", reason: $r}'
exit 0
