#!/bin/bash
# worktree-write-guard.sh — PreToolUse hook (Edit|Write and Bash).
#
# GOAL (Antonio, 2026-07-24): a session working in a git worktree must be
# ISOLATED FOR WRITES but UNRESTRICTED FOR READS. It needs a 360-degree view of
# the whole repo — the main checkout, other branches, sibling worktrees — to
# diagnose correctly; it must only ever *write* inside its own workspace.
#
#   WRITES into the main checkout / a sibling worktree  -> DENIED
#   READS anywhere                                      -> ALWAYS ALLOWED
#
# WHY IT EXISTS (2026-07-24 incident, Portal Chats red-dot fix): a worktree
# session wrote its new files into the MAIN repo folder, which was parked on an
# unrelated branch. The repo's 5-minute auto-pull auto-stashed the uncommitted
# work and it vanished from disk mid-session. Recoverable, but it cost a
# round-trip and silently put the work on the wrong branch.
#
# DETECTION (git plumbing, not the ".claude/worktrees" naming convention):
#   SESSION_TOP = git rev-parse --show-toplevel
#   MAIN_ROOT   = dirname(git rev-parse --path-format=absolute --git-common-dir)
#   worktree session  <=>  SESSION_TOP != MAIN_ROOT
# A normal main-repo session short-circuits before any parsing.
#
# DECISION LOGIC lives in worktree_write_guard.py (path normalization, ..-escape
# resolution, read-vs-write classification). This wrapper resolves the two roots,
# then delegates. If python3 is unavailable it falls back to a conservative
# literal-prefix check on the file path so the guard degrades to *something*
# rather than silently vanishing (bug-hunter finding: the previous version
# decided to deny and then emitted nothing when python3 was missing).
#
# OVERRIDE (deliberate, rare — recovering a stash into the main repo, repairing
# the other checkout):
#   - env: ALLOW_MAIN_REPO_WRITE=1
#   - Bash: the command must START with ALLOW_MAIN_REPO_WRITE=1 (anchored, so
#     merely *mentioning* the variable — in docs, a heredoc, a commit message —
#     no longer disarms the guard; that was a bug-hunter blocker).
#
# HONEST LIMIT: the Bash arm is a tripwire, not a wall. It catches the realistic
# write-into-main shapes (redirects, cp/mv/rsync destinations, rm/sed -i, git
# write subcommands, build tools run with main as cwd, including via a relative
# `cd ../../..`). A shell can still write anywhere by indirect means. Do not read
# a passing Bash call as proof the main repo was untouched. File writes
# (Edit/Write) are the exact path and are fully normalized.
#
# Test: sh .claude/hooks/test-worktree-write-guard.sh

INPUT=$(cat)

# ── Escape hatch (env) ─────────────────────────────────────────────────────
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

# ── Fallback (no python3): conservative literal check on the file path ─────
# Grep the RAW payload so it works whether parameters are nested under
# tool_input or sent top-level (same trick verify-before-edit.sh uses).
FILE_PATH=$(printf '%s' "$INPUT" | grep -o '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
[ -n "$FILE_PATH" ] || exit 0
case "$FILE_PATH" in /*) : ;; *) exit 0 ;; esac
case "$FILE_PATH" in "$SESSION_TOP"/*|"$SESSION_TOP") exit 0 ;; esac
case "$FILE_PATH" in
  "$MAIN_ROOT"/*)
    cat <<EOF
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"BLOCKED — wrong checkout: that path writes into the MAIN repo ($MAIN_ROOT), but this session runs in the worktree $SESSION_TOP. Writing there silently loses work to the repo's auto-pull auto-stash and puts it on the wrong branch. Reads are never blocked — only writes are confined. (python3 unavailable, so this is the guard's reduced fallback check.) Deliberate exception: start the command with ALLOW_MAIN_REPO_WRITE=1."}}
EOF
    ;;
esac
exit 0
