#!/bin/bash
# test-session-git-pull-worktree-guard.sh — proves the worktree stash/pull
# EXEMPTION in session-git-pull.sh applies to a linked worktree on ANY
# branch, not just named ones.
#
# Run:  bash .claude/hooks/test-session-git-pull-worktree-guard.sh
#
# WHY THIS EXISTS: this exact boundary has caused two real incidents —
# 2026-08-10 (worktrees on a feature branch were being auto-stashed) and
# 2026-09-15 (the fix for that still missed a worktree left sitting on
# `main` right after a merge, and 5 uncommitted files got auto-stashed for
# real). A third occurrence should be caught here, not by a third incident.
#
# session-git-pull.sh does real git operations (stash, pull, npm ci) with no
# dry-run mode, so this does NOT execute the script end to end — that would
# stash/pull the real repo. Instead it isolates the pure boolean the guard
# decides on (GIT_DIR_SELF vs GIT_DIR_SHARED — branch name is deliberately
# NOT part of it since the fix), and separately PINS that the real script
# still contains the exact conditions this test assumes, so a future edit
# to the real script that silently changes the logic fails this test loudly
# instead of leaving it green against stale, duplicated logic.

HOOK="$(cd "$(dirname "$0")" && pwd)/session-git-pull.sh"
PASS=0; FAIL=0

# ── Pin against drift: the real script must still contain what this test assumes ──
EXPECTED_CONDITION='if [ -n "$GIT_DIR_SELF" ] && [ "$GIT_DIR_SELF" != "$GIT_DIR_SHARED" ]; then'
if ! grep -qF "$EXPECTED_CONDITION" "$HOOK"; then
  echo "❌ CANNOT VALIDATE: session-git-pull.sh's worktree guard condition has changed."
  echo "   Expected to find this exact line: $EXPECTED_CONDITION"
  echo "   Update is_exempt() below to match the new logic, then update EXPECTED_CONDITION."
  exit 1
fi
if grep -qF 'CURRENT_BRANCH" != "main"' "$HOOK"; then
  echo "❌ REGRESSION: the branch-name check (\"\$CURRENT_BRANCH\" != \"main\") is back in"
  echo "   the worktree guard condition. This is the exact bug from dev job fc645bbb —"
  echo "   it silently re-excludes a worktree sitting on main from the exemption."
  exit 1
fi
if ! grep -qF '${CURRENT_BRANCH:-detached HEAD}' "$HOOK"; then
  echo "❌ CANNOT VALIDATE: the detached-HEAD message fallback has changed or was removed."
  echo "   Expected to find: \${CURRENT_BRANCH:-detached HEAD}"
  exit 1
fi

# Mirrors the exact conditional pinned above.
is_exempt() {
  local self="$1" shared="$2"
  [ -n "$self" ] && [ "$self" != "$shared" ]
}

run() {
  local label="$1" expect="$2" self="$3" shared="$4"
  if is_exempt "$self" "$shared"; then got="EXEMPT"; else got="STASH_AND_PULL"; fi
  if [ "$got" = "$expect" ]; then
    echo "  ✅ $label"; PASS=$((PASS+1))
  else
    echo "  ❌ $label — expected $expect, got $got"; FAIL=$((FAIL+1))
  fi
}

echo "Linked worktree, any branch — must be EXEMPT (branch name is NOT part of the test):"
run "worktree on a named feature branch"      EXEMPT "/repo/.git/worktrees/w1" "/repo/.git"
run "worktree on main (the 2026-09-15 bug)"   EXEMPT "/repo/.git/worktrees/w1" "/repo/.git"
run "worktree, detached HEAD"                 EXEMPT "/repo/.git/worktrees/w1" "/repo/.git"
echo

echo "Primary checkout — always stash+pull regardless of branch (unchanged by the fix):"
run "primary checkout on main"                STASH_AND_PULL "/repo/.git" "/repo/.git"
run "primary checkout on a feature branch"    STASH_AND_PULL "/repo/.git" "/repo/.git"
echo

echo "Degenerate git-dir lookups fail CLOSED to the safe (primary-checkout) path:"
run "both rev-parse calls failed (empty/empty)" STASH_AND_PULL "" ""
run "self empty, shared populated"              STASH_AND_PULL "" "/repo/.git"
echo

echo "Detached-HEAD message never renders blank (cosmetic fix, dev job fc645bbb):"
run_display() {
  local label="$1" expect="$2" branch="$3"
  got="${branch:-detached HEAD}"
  if [ "$got" = "$expect" ]; then
    echo "  ✅ $label"; PASS=$((PASS+1))
  else
    echo "  ❌ $label — expected '$expect', got '$got'"; FAIL=$((FAIL+1))
  fi
}
run_display "named branch shows its own name"          "my-feature"    "my-feature"
run_display "empty branch shows a label, not blank"    "detached HEAD" ""
echo

echo "-------------------------------"
echo "PASS: $PASS   FAIL: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
