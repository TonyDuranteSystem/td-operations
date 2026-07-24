#!/bin/bash
# worktree-write-guard.sh
# PreToolUse hook — fires before Edit/Write (and, best-effort, Bash).
#
# WHY THIS EXISTS (2026-07-24 incident, Portal Chats red-dot fix):
# A session running in a git worktree wrote its new files + edits into the MAIN
# repo folder instead (a bare `cd /Users/.../td-operations` in a Bash call lands
# there, and absolute paths in Edit/Write go wherever they point). The main repo
# was parked on an UNRELATED branch, and the repo's 5-minute auto-pull
# auto-stashed the uncommitted work — it vanished from disk mid-session. It was
# fully recoverable from the stash, but it cost a round-trip and it silently put
# the work on the wrong branch.
#
# WHAT IT DOES
# When (and only when) the session is running inside a worktree, it DENIES a
# file write whose target resolves into the MAIN repo instead of this worktree,
# and tells the session the corrected path. Sessions running normally in the
# main repo are unaffected — the guard detects that case and exits silently.
#
# DETECTION (verified 2026-07-24, both directions):
#   session top  = git rev-parse --show-toplevel            -> the worktree
#   main root    = dirname(git rev-parse --git-common-dir)  -> the real repo
#   worktree session  <=>  session top != main root
# This uses git plumbing, NOT the ".claude/worktrees/" naming convention, so it
# still holds for worktrees created anywhere else.
#
# SCOPE / HONEST LIMITS
#  - Edit/Write: exact. This is the path that actually lost work.
#  - Bash: BEST-EFFORT only. It flags a command that names the main repo root,
#    but a shell can write anywhere by indirect means; this is a tripwire, not a
#    wall. Do not treat a passing Bash call as proof the main repo is untouched.
#
# OVERRIDE (deliberate, rare — e.g. recovering a stash into the main repo, or
# intentionally repairing the other checkout):
#   ALLOW_MAIN_REPO_WRITE=1   in the environment, or literally present in the
#   Bash command string.
#
# Test: sh .claude/hooks/test-worktree-write-guard.sh

INPUT=$(cat)

# ── Escape hatch ───────────────────────────────────────────────────────────
if [ "${ALLOW_MAIN_REPO_WRITE:-}" = "1" ]; then
  exit 0
fi

# ── Where is this session actually running? ────────────────────────────────
SESSION_TOP=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
[ -n "$SESSION_TOP" ] || exit 0

COMMON_DIR=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0
[ -n "$COMMON_DIR" ] || exit 0
MAIN_ROOT=$(dirname "$COMMON_DIR")

# Not a worktree session (the overwhelmingly common case) → say nothing.
[ "$SESSION_TOP" != "$MAIN_ROOT" ] || exit 0

# ── Extract the target from the tool input ─────────────────────────────────
FILE_PATH=$(printf '%s' "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('file_path','') or '')" 2>/dev/null || echo "")
COMMAND=$(printf '%s' "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('command','') or '')" 2>/dev/null || echo "")

# Command-level override (matches how bash-production-guard.sh is overridden).
case "$COMMAND" in
  *ALLOW_MAIN_REPO_WRITE=1*) exit 0 ;;
esac

deny() {
  # $1 = reason text. JSON-encode so quotes/newlines in paths can't break it.
  # Compact separators: the other hooks emit compact JSON, and the test asserts
  # on that exact shape.
  printf '%s' "$1" | python3 -c '
import sys, json
reason = sys.stdin.read()
print(json.dumps({"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":reason}}, separators=(",", ":")))
'
  exit 0
}

# ── Edit/Write: exact path check ───────────────────────────────────────────
if [ -n "$FILE_PATH" ]; then
  case "$FILE_PATH" in
    /*) ABS="$FILE_PATH" ;;
     *) exit 0 ;;   # relative path → resolves inside the worktree → fine
  esac

  # Inside this worktree → allow. (Checked FIRST: the worktree may itself live
  # under the main root, e.g. <main>/.claude/worktrees/<name>, so this test must
  # win over the main-root test below.)
  case "$ABS" in
    "$SESSION_TOP"/*|"$SESSION_TOP") exit 0 ;;
  esac

  # Inside the main repo but NOT this worktree → the mistake. Block it.
  case "$ABS" in
    "$MAIN_ROOT"/*)
      REL=${ABS#"$MAIN_ROOT"/}
      deny "BLOCKED — wrong checkout. This session runs in a WORKTREE, but that path writes into the MAIN repo:

  target      : $ABS
  this worktree: $SESSION_TOP
  main repo   : $MAIN_ROOT

The main repo is usually parked on an UNRELATED branch, and the repo's 5-minute auto-pull auto-stashes uncommitted work — writing there silently loses your changes and puts them on the wrong branch (2026-07-24 incident).

Use the worktree path instead:
  $SESSION_TOP/$REL

Also: in Bash, 'cd' does NOT persist between calls, so set W=$SESSION_TOP once and use \"\$W\" (git -C \"\$W\" ...). Commit to the worktree branch early — the auto-stash cannot touch committed work.

If you genuinely mean to write into the main repo (e.g. recovering a stash there), re-run with ALLOW_MAIN_REPO_WRITE=1."
      ;;
  esac
  exit 0
fi

# ── Bash: best-effort tripwire (see HONEST LIMITS above) ───────────────────
if [ -n "$COMMAND" ]; then
  # Only interesting if the command names the main root in a way that is NOT
  # this worktree. Cheap substring test; deliberately conservative.
  case "$COMMAND" in
    *"$SESSION_TOP"*) exit 0 ;;   # already pointed at the worktree
    *"$MAIN_ROOT"*)
      deny "BLOCKED — wrong checkout. This session runs in a WORKTREE, but this command targets the MAIN repo path ($MAIN_ROOT).

  this worktree: $SESSION_TOP

The main repo is usually on an UNRELATED branch and its auto-pull auto-stashes uncommitted work, which silently loses changes (2026-07-24 incident). Point the command at the worktree instead:

  W=$SESSION_TOP
  cd \"\$W\"      # or: git -C \"\$W\" ...

Note 'cd' does not persist between Bash calls, so re-set W (or use absolute paths) in every call.

If you genuinely mean to operate on the main repo (e.g. recovering a stash, or repairing the other checkout), prefix the command with ALLOW_MAIN_REPO_WRITE=1."
      ;;
  esac
fi

exit 0
