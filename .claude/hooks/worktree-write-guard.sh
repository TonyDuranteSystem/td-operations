#!/bin/bash
# worktree-write-guard.sh — PreToolUse hook, wired on Edit|Write ONLY.
#
# GOAL (Antonio, 2026-07-24): a session working in a git worktree must be
# ISOLATED FOR WRITES but UNRESTRICTED FOR READS. It needs a 360-degree view of
# the whole repo — the main checkout, other branches, sibling worktrees — to
# diagnose correctly; it must only ever *write* inside its own workspace.
#
#   File write into the main checkout / a sibling worktree  -> DENIED
#   Anything else, including every read                     -> ALLOWED
#
# WHY IT EXISTS (2026-07-24 incident, Portal Chats red-dot fix): a worktree
# session wrote its new files into the MAIN repo folder, which was parked on an
# unrelated branch. The repo's 5-minute auto-pull auto-stashed the uncommitted
# work and it vanished from disk mid-session. Recoverable, but it cost a
# round-trip and silently put the work on the wrong branch.
#
# NOT WIRED ON Bash — deliberately. An earlier version tried to classify shell
# commands as read-or-write; two review rounds plus a direct test showed it
# missed every realistic write into main (variables, quoting, relative writes
# after a cd, tee, git stash pop) while blocking legitimate reads. Shell
# semantics cannot be predicted from a string. Commands are covered by
# OBSERVATION instead: main-repo-change-detector.sh (PostToolUse) reports when
# the main checkout actually changed. Because this guard never sees a command,
# a read can never be blocked — that is structural, not a heuristic.
#
# DETECTION (git plumbing, not the ".claude/worktrees" naming convention):
#   SESSION_TOP = git rev-parse --show-toplevel
#   MAIN_ROOT   = dirname(git rev-parse --path-format=absolute --git-common-dir)
#   worktree session  <=>  SESSION_TOP != MAIN_ROOT
# A normal main-repo session short-circuits before any parsing.
#
# Path handling (normalization, ..-escapes, case-insensitive compare) lives in
# worktree_write_guard.py. If python3 is unavailable this wrapper falls back to a
# conservative literal-prefix check so the guard degrades to *something* rather
# than silently vanishing — an earlier version decided to deny and then emitted
# nothing when python3 was missing.
#
# OVERRIDE (deliberate, rare — e.g. recovering a stash into the main repo):
#   ALLOW_MAIN_REPO_WRITE=1 in the environment.
#
# Test: sh .claude/hooks/test-worktree-write-guard.sh

INPUT=$(cat)

# ── Escape hatch ───────────────────────────────────────────────────────────
if [ "${ALLOW_MAIN_REPO_WRITE:-}" = "1" ]; then
  exit 0
fi

# ── Resolve the two checkout roots ─────────────────────────────────────────
SESSION_TOP=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
[ -n "$SESSION_TOP" ] || exit 0
COMMON_DIR=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0
[ -n "$COMMON_DIR" ] || exit 0
MAIN_ROOT=$(dirname "$COMMON_DIR")

# Not a worktree session → the guard has no opinion. Say nothing, cheaply.
[ "$SESSION_TOP" != "$MAIN_ROOT" ] || exit 0

GUARD_DIR=$(cd "$(dirname "$0")" && pwd)
PY="$GUARD_DIR/worktree_write_guard.py"

# ── Normal path: delegate the decision to python3 ──────────────────────────
if command -v python3 >/dev/null 2>&1 && [ -f "$PY" ]; then
  printf '%s' "$INPUT" \
    | GUARD_SESSION_TOP="$SESSION_TOP" GUARD_MAIN_ROOT="$MAIN_ROOT" python3 "$PY"
  exit 0
fi

# ── Fallback (no python3): conservative literal check ──────────────────────
# Grep the RAW payload so it works whether parameters are nested under
# tool_input or sent top-level (the trick verify-before-edit.sh uses).
# Covers notebook_path too, so the fallback is not narrower than the main path.
FILE_PATH=$(printf '%s' "$INPUT" \
  | grep -o '"\(file_path\|notebook_path\)"[[:space:]]*:[[:space:]]*"[^"]*"' \
  | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
[ -n "$FILE_PATH" ] || exit 0
case "$FILE_PATH" in /*) : ;; *) exit 0 ;; esac
# A ..-escape cannot be resolved without python3; treat any path containing ".."
# as suspect rather than trusting the literal prefix (fail closed, not open).
case "$FILE_PATH" in
  "$SESSION_TOP"/*|"$SESSION_TOP")
    case "$FILE_PATH" in *..*) : ;; *) exit 0 ;; esac
    ;;
esac
case "$FILE_PATH" in
  "$MAIN_ROOT"/*)
    cat <<EOF
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"BLOCKED — wrong checkout: that path writes into the MAIN repo ($MAIN_ROOT), but this session runs in the worktree $SESSION_TOP. Writing there silently loses work to the repo's auto-pull auto-stash and puts it on the wrong branch. Reads are never blocked — only file writes are confined. (python3 unavailable, so this is the guard's reduced fallback check.) Deliberate exception: set ALLOW_MAIN_REPO_WRITE=1 in the environment."}}
EOF
    ;;
esac
exit 0
