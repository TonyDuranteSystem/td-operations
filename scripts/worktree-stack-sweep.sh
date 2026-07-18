#!/usr/bin/env bash
# worktree-stack-sweep.sh — reclaim isolated local DB stacks whose worktree is GONE.
#
# A worktree being "closed" = its folder no longer exists. Fail-soft and SAFE:
# only reclaims when it can positively confirm the worktree is gone.
#
# THREE detectors, in order of confidence (2026-07-18 — see lib-local-stacks.sh
# for the incident that motivated the second and third):
#
#   1. MARKER — env-up records the worktree path in <stack>/.worktree-path. Exact
#      and clone-agnostic. Unchanged, and still the primary test.
#
#   2. GIT FALLBACK, for a stack whose marker is missing AND whose config is also
#      missing. A half-finished purge deletes both, leaving containers running
#      that the marker test can never see again. Because env-up names a stack
#      after its branch, git can still say whether any live worktree maps to it.
#      Deliberately narrow: a HEALTHY stack always has its config, so this can
#      never touch one that is genuinely in use — which also keeps it safe when
#      the sweep is run from a different clone whose worktree list differs.
#
#   3. NO DIRECTORY AT ALL — containers running under a `tdlocal-*` compose
#      project with no stack directory anywhere. Nothing can manage those, and
#      no session can be legitimately using them.
#
# Run from the SessionStart hook (best-effort, backgrounded) and/or by hand.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib-local-stacks.sh
. "$SCRIPT_DIR/lib-local-stacks.sh"

DRY_RUN=0
for a in "$@"; do [ "$a" = "--dry-run" ] && DRY_RUN=1; done

LIVE="$(live_stack_names)"          # empty ⇒ "cannot tell" ⇒ detector 2 stays off
is_live() { [ -n "$LIVE" ] && printf '%s\n' "$LIVE" | grep -qxF "$1"; }

reclaim() {  # name, dir(optional), why
  local name="$1" dir="${2:-}" why="$3"
  if [ "$DRY_RUN" = 1 ]; then
    echo "[sweep] WOULD reclaim '$name' ($why)"
    return 0
  fi
  echo "[sweep] reclaiming '$name' ($why)"
  if stack_force_stop "$name" "$dir"; then
    [ -n "$dir" ] && stack_remove_dir_if_stopped "$name" "$dir"
  else
    # Left running on purpose: its config is the only way to reclaim it later.
    echo "[sweep] '$name' could not be stopped — leaving it intact to retry" >&2
  fi
}

# ── 1 + 2: stacks that have a directory ─────────────────────────────────────
if [ -d "$STACKS_ROOT" ]; then
  for STACK_DIR in "$STACKS_ROOT"/*/; do
    [ -d "$STACK_DIR" ] || continue
    STACK_DIR="${STACK_DIR%/}"
    name="$(basename "$STACK_DIR")"
    [ -n "$name" ] || continue

    PATHFILE="$STACK_DIR/.worktree-path"
    if [ -f "$PATHFILE" ]; then
      WTPATH="$(cat "$PATHFILE" 2>/dev/null)"
      [ -n "$WTPATH" ] || continue
      [ -d "$WTPATH" ] && continue                      # worktree alive → keep
      reclaim "$name" "$STACK_DIR" "worktree gone: $WTPATH"
      continue
    fi

    # No marker. Only act when the stack is ALSO already broken (no config) —
    # that combination is the signature of a half-finished purge, not of a
    # healthy stack, and it is the state in which containers leak forever.
    [ -f "$STACK_DIR/supabase/config.toml" ] && continue
    [ -n "$LIVE" ] || continue                          # can't tell → leave alone
    is_live "$name" && continue                         # a live worktree maps to it
    reclaim "$name" "$STACK_DIR" "no marker, no config, and no live worktree maps to it"
  done
fi

# ── 3: containers with no stack directory at all ────────────────────────────
#
# Compare via label_matches_stack, NEVER by string-stripping the label: Docker
# truncates it, so `${label#tdlocal-}` yields a name that matches no directory
# and no live worktree. Stripping naively here would classify the LONGEST-named
# stacks — including a healthy one belonging to the current session — as
# orphans and delete them. Caught in review before this shipped.
if docker_up; then
  for label in $(docker ps -a --format '{{.Label "com.docker.compose.project"}}' 2>/dev/null \
                 | grep '^tdlocal-' | sort -u); do
    claimed=0

    if [ -d "$STACKS_ROOT" ]; then
      for d in "$STACKS_ROOT"/*/; do
        [ -d "$d" ] || continue
        label_matches_stack "$label" "$(basename "${d%/}")" && { claimed=1; break; }
      done
    fi
    [ "$claimed" = 1 ] && continue                      # a directory owns it → detectors 1/2

    if [ -n "$LIVE" ]; then
      while IFS= read -r ln; do
        [ -n "$ln" ] || continue
        label_matches_stack "$label" "$ln" && { claimed=1; break; }
      done <<EOF
$LIVE
EOF
    fi
    [ "$claimed" = 1 ] && continue                      # a live worktree maps to it

    reclaim "${label#tdlocal-}" "" "containers running with no stack directory"
  done
fi

exit 0
