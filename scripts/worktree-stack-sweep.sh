#!/usr/bin/env bash
# worktree-stack-sweep.sh — reclaim isolated local DB stacks whose worktree is GONE.
#
# A worktree being "closed" = its folder no longer exists. env-up records each stack's
# worktree path in ~/.td-local-stacks/<name>/.worktree-path; this sweep purges any stack
# whose recorded path is missing. Clone-agnostic (uses the absolute path, not git state),
# fail-soft, and SAFE: only purges when it can positively confirm the worktree is gone.
#
# Run from the SessionStart hook (best-effort, backgrounded) and/or by hand.
set -uo pipefail
STACKS_ROOT="$HOME/.td-local-stacks"
[ -d "$STACKS_ROOT" ] || exit 0

for STACK_DIR in "$STACKS_ROOT"/*/; do
  [ -d "$STACK_DIR" ] || continue
  name="$(basename "$STACK_DIR")"
  [ -n "$name" ] || continue
  PATHFILE="$STACK_DIR/.worktree-path"

  # No recorded path → can't confirm orphan → leave it alone (safe default).
  [ -f "$PATHFILE" ] || continue
  WTPATH="$(cat "$PATHFILE" 2>/dev/null)"
  [ -n "$WTPATH" ] || continue

  # Worktree folder still exists → stack is live, keep it.
  [ -d "$WTPATH" ] && continue

  # Orphan: the worktree is gone. Purge the stack (stop containers if Docker is up, then remove).
  echo "[sweep] purging orphan stack '$name' (worktree gone: $WTPATH)"
  if docker info >/dev/null 2>&1; then
    ( cd "$STACK_DIR" && supabase stop --no-backup >/dev/null 2>&1 ) || true
  fi
  # Guard: never rm the root; only a named child dir.
  case "$STACK_DIR" in
    "$STACKS_ROOT"/?*/) rm -rf "$STACK_DIR" ;;
  esac
done
exit 0
