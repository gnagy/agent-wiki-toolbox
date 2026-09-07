#!/usr/bin/env bash
# Nudge an agent into the wiki-docs skill the first time it touches a wiki.
#
# The project copy of this hook carried WIKI_ROOT, the one copy of the layout
# outside awt.config.mjs. The plugin copy has no such setting: it walks up from
# the session's cwd to the config, the same way every awt command does, and
# exits in milliseconds where there is no config.
#
# Fails open by design: anything wrong here lets the tool call through.
set -u

command -v jq >/dev/null 2>&1 || exit 0

input=$(cat)
tool=$(jq -r '.tool_name // ""' <<<"$input" 2>/dev/null)
session=$(jq -r '.session_id // "nosession"' <<<"$input" 2>/dev/null)
cwd=$(jq -r '.cwd // ""' <<<"$input" 2>/dev/null)

# Cheapest check first: after the guard has fired once, every later call stops
# here, before any filesystem walking.
marker="${TMPDIR:-/tmp}/wiki-docs-guard-${session}"
[[ -e "$marker" ]] && exit 0

case "$tool" in
  Write|Edit|MultiEdit|NotebookEdit) target=$(jq -r '.tool_input.file_path // ""' <<<"$input" 2>/dev/null) ;;
  Bash)                              target=$(jq -r '.tool_input.command // ""'   <<<"$input" 2>/dev/null) ;;
  *) exit 0 ;;
esac
[[ -n "$target" ]] || exit 0

# Walk up to the project marker. Start at cwd; a Write to an absolute path
# outside it is found from the path's own directory instead.
find_config() {
  local dir="$1"
  [[ -d "$dir" ]] || dir=$(dirname "$dir")
  while [[ -n "$dir" && "$dir" != "/" ]]; do
    [[ -f "$dir/awt.config.mjs" ]] && { printf '%s\n' "$dir"; return 0; }
    dir=$(dirname "$dir")
  done
  return 1
}

root=$(find_config "${cwd:-$PWD}") || root=""
if [[ -z "$root" && "$target" == /* ]]; then
  root=$(find_config "$target") || root=""
fi
[[ -n "$root" ]] || exit 0

# rootDir names the wiki's home, `wiki` when unsaid; `notes` is a fixed name
# inside it. Read it out of the config rather than importing the module: this
# runs before every matching tool call until it fires, and a node start is not
# worth one string.
rootdir=$(grep -oE "rootDir:[[:space:]]*['\"][^'\"]+['\"]" "$root/awt.config.mjs" 2>/dev/null |
          head -1 | sed -E "s/.*['\"]([^'\"]+)['\"].*/\1/")
notes="${rootdir:-wiki}/notes"

# A file path is matched absolutely, a Bash command as a substring — the same
# split the project copy used, and the same blind spot: a path a script builds
# at runtime is not seen.
case "$tool" in
  Bash) [[ "$target" == *"$notes"* || "$target" == *"$root/$notes"* ]] || exit 0 ;;
  *)    [[ "$target" == "$root/$notes"* || "$target" == *"/$notes/"* ]] || exit 0 ;;
esac

: > "$marker" 2>/dev/null || exit 0

jq -n '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: "That path is a project wiki, and the wiki-docs skill governs it. Load the skill, then retry — this guard fires once per session and will not block you again."
  }
}'
exit 0
