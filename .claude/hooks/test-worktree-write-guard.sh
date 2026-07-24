#!/bin/bash
# test-worktree-write-guard.sh — proves worktree-write-guard.sh actually blocks.
#
# Run:  sh .claude/hooks/test-worktree-write-guard.sh
#
# Design note (deliberate): the FIRST test reproduces the exact 2026-07-24
# mistake — an Edit aimed at the main repo from a worktree session. If the guard
# is ever gutted, that test goes red first. A guard test that only asserts the
# happy path would have passed even while the guard did nothing.

GUARD="$(cd "$(dirname "$0")" && pwd)/worktree-write-guard.sh"
PASS=0; FAIL=0

SESSION_TOP=$(git rev-parse --show-toplevel 2>/dev/null)
MAIN_ROOT=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)")

if [ "$SESSION_TOP" = "$MAIN_ROOT" ]; then
  echo "⚠️  Not running inside a worktree (session top == main root)."
  echo "    The blocking tests need a worktree session; run this from one."
  echo "    Running the 'stays silent in a normal session' test only."
fi

# run <label> <expect: DENY|ALLOW> <cwd> <json> [env-assignment]
run() {
  label=$1; expect=$2; cwd=$3; json=$4; envassign=$5
  if [ -n "$envassign" ]; then
    out=$(cd "$cwd" && printf '%s' "$json" | env "$envassign" sh "$GUARD" 2>/dev/null)
  else
    out=$(cd "$cwd" && printf '%s' "$json" | sh "$GUARD" 2>/dev/null)
  fi
  case "$out" in
    *'"permissionDecision":"deny"'*) got=DENY ;;
    *)                               got=ALLOW ;;
  esac
  if [ "$got" = "$expect" ]; then
    echo "  ✅ $label  (expected $expect)"
    PASS=$((PASS+1))
  else
    echo "  ❌ $label  — expected $expect, got $got"
    echo "     output: $out"
    FAIL=$((FAIL+1))
  fi
}

if [ "$SESSION_TOP" != "$MAIN_ROOT" ]; then
  echo "Worktree session detected:"
  echo "  worktree : $SESSION_TOP"
  echo "  main repo: $MAIN_ROOT"
  echo

  echo "THE REGRESSION THAT MATTERS (reproduces the 2026-07-24 loss):"
  run "Write into MAIN repo is BLOCKED" DENY "$SESSION_TOP" \
    "{\"file_path\":\"$MAIN_ROOT/lib/portal/mark-thread-read.ts\"}"
  run "Write a NEW test into MAIN repo is BLOCKED" DENY "$SESSION_TOP" \
    "{\"file_path\":\"$MAIN_ROOT/tests/unit/some-new.test.ts\"}"
  echo

  echo "Must NOT block legitimate work:"
  # The worktree lives UNDER the main root, so this proves the worktree check
  # correctly wins over the main-root check (ordering regression guard).
  run "Write inside the worktree is allowed" ALLOW "$SESSION_TOP" \
    "{\"file_path\":\"$SESSION_TOP/lib/portal/mark-thread-read.ts\"}"
  run "Relative path is allowed" ALLOW "$SESSION_TOP" \
    '{"file_path":"lib/portal/mark-thread-read.ts"}'
  run "Path outside the repo is allowed" ALLOW "$SESSION_TOP" \
    '{"file_path":"/tmp/scratch.txt"}'
  echo

  echo "Bash tripwire (best-effort):"
  run "Command naming MAIN repo is BLOCKED" DENY "$SESSION_TOP" \
    "{\"command\":\"cd $MAIN_ROOT && npm run build\"}"
  run "Command naming the worktree is allowed" ALLOW "$SESSION_TOP" \
    "{\"command\":\"cd $SESSION_TOP && npm run build\"}"
  run "Unrelated command is allowed" ALLOW "$SESSION_TOP" \
    '{"command":"git status --short"}'
  echo

  echo "Deliberate override:"
  run "Override in command string allows main-repo command" ALLOW "$SESSION_TOP" \
    "{\"command\":\"ALLOW_MAIN_REPO_WRITE=1 git -C $MAIN_ROOT checkout -- lib/x.ts\"}"
  run "Override in environment allows main-repo write" ALLOW "$SESSION_TOP" \
    "{\"file_path\":\"$MAIN_ROOT/lib/x.ts\"}" "ALLOW_MAIN_REPO_WRITE=1"
  echo
fi

echo "Normal (non-worktree) sessions must be untouched:"
run "Main-repo write from a MAIN-repo session is allowed" ALLOW "$MAIN_ROOT" \
  "{\"file_path\":\"$MAIN_ROOT/lib/portal/mark-thread-read.ts\"}"
run "Main-repo command from a MAIN-repo session is allowed" ALLOW "$MAIN_ROOT" \
  "{\"command\":\"cd $MAIN_ROOT && npm run build\"}"

echo
echo "-------------------------------"
echo "PASS: $PASS   FAIL: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
