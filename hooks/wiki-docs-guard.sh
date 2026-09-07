#!/usr/bin/env bash
# Nudge an agent into the wiki-docs skill the first time it writes to a wiki.
#
# The project copy of this hook carried WIKI_ROOT, the one copy of the layout
# outside awt.config.mjs. The plugin copy has no such setting: it walks up from
# the session's cwd to the config, the same way every awt command does, and
# exits in milliseconds where there is no config.
#
# Fails open by design: anything wrong here lets the tool call through.
set -u

command -v jq >/dev/null 2>&1 || exit 0

# Does this shell command write a file?
#
# The guard has one fire per session, and a session reads a wiki far more often
# than it writes to one. Spending the fire on a `cat` leaves the session's first
# real write unguarded, silently -- the same failure the whole-path match below
# exists to prevent, arriving by a different route.
#
# The test is a denylist of mutating operators and utilities, so a command it
# cannot classify does not fire. That bias is what makes the narrowing safe: a
# write this misses is still formatted and still checked by the Stop hook before
# the session ends, so a false negative costs a nudge, while a false positive
# costs the fire itself.
#
# `awt` is deliberately not in the list. Its verbs serialise what they write, and
# the MCP form of the same verb never reaches this guard at all, so firing on the
# CLI form would deny a correct call and buy nothing.
writes_files() {
  local cmd="$1" bare

  # Redirection, minus the forms that write nowhere: `2>&1`, `>/dev/null`.
  bare=$(printf '%s' "$cmd" | sed -E 's/[0-9]*>&[0-9-]+//g; s/[0-9]*>>?[[:space:]]*\/dev\/[a-z]+//g')
  case "$bare" in *'>'*) return 0 ;; esac

  # A mutating utility in command position: line start, or after a separator.
  # The anchor is the point -- `grep -r mv` is not an `mv`, while the second
  # stage of a pipeline is still a command position.
  printf '%s' "$cmd" | grep -qE '(^|[;&|(`]|\$\(|[[:space:]](then|do|else)[[:space:]])[[:space:]]*(sudo[[:space:]]+)?(mv|rm|cp|tee|touch|mkdir|rmdir|ln|dd|truncate|patch|sponge)([[:space:]]|$)' && return 0

  # Editors that write only when a flag says so.
  printf '%s' "$cmd" | grep -qE '(^|[[:space:]])(sed|perl|ruby)[[:space:]]+([^|;&]*[[:space:]])?(-[[:alnum:]]*i|--in-place)' && return 0
  printf '%s' "$cmd" | grep -qE '(^|[[:space:]])awk[[:space:]]+[^|;&]*-i[[:space:]]*inplace' && return 0

  # git subcommands that move or rewrite tracked files.
  printf '%s' "$cmd" | grep -qE '(^|[[:space:]])git[[:space:]]+(mv|rm|apply|restore|checkout|revert|stash)([[:space:]]|$)' && return 0

  return 1
}

input=$(cat)
tool=$(jq -r '.tool_name // ""' <<<"$input" 2>/dev/null)
session=$(jq -r '.session_id // "nosession"' <<<"$input" 2>/dev/null)
cwd=$(jq -r '.cwd // ""' <<<"$input" 2>/dev/null)

# Cheapest check first: after the guard has fired once, every later call stops
# here, before any classifying or filesystem walking.
marker="${TMPDIR:-/tmp}/wiki-docs-guard-${session}"
[[ -e "$marker" ]] && exit 0

case "$tool" in
  Write|Edit|MultiEdit|NotebookEdit) target=$(jq -r '.tool_input.file_path // ""' <<<"$input" 2>/dev/null) ;;
  Bash)                              target=$(jq -r '.tool_input.command // ""'   <<<"$input" 2>/dev/null)
                                     writes_files "$target" || exit 0 ;;
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

# Match the notes path as a whole path, not a prefix, the way the project copy
# in Atlas does: a sibling whose name begins with it (`wiki-inbox/` beside
# `wiki/`) must not spend the one fire, and the inbox is the one path in another
# repo the interop protocol says to write to. The trailing space folds "target
# ends with the notes path" into "notes path followed by whitespace". A Bash
# command and a file path go through the same test; the blind spot both share is
# a path a script builds at runtime.
case "$target " in
  *"$notes"/*|*"$notes"[[:space:]]*|*"$notes"\"*|*"$notes"\'*) ;;
  *) exit 0 ;;
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
