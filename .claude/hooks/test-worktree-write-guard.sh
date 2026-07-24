#!/bin/bash
# test-worktree-write-guard.sh — proves worktree-write-guard.sh actually works.
#
# Run:  sh .claude/hooks/test-worktree-write-guard.sh
#
# HARD-LEARNED DESIGN RULES (2026-07-24 review found the first version green
# against a guard that was 100% inert):
#  1. Payloads use the REAL nested shape ({"tool_name":..,"tool_input":{..}}).
#     The original suite used a flat shape the platform never sends, so it
#     validated nothing. One flat case is kept only to pin back-compat.
#  2. Assertions PARSE the JSON and check the full protocol envelope
#     (hookSpecificOutput + hookEventName + permissionDecision), not a substring.
#     A structurally-wrong-but-compact deny used to pass silently.
#  3. Reads must NEVER be denied — that is the product requirement (a session
#     needs a 360-degree view), so read cases are first-class tests.
#  4. Refuses to report success if it is not run inside a worktree.

GUARD="$(cd "$(dirname "$0")" && pwd)/worktree-write-guard.sh"
PASS=0; FAIL=0

SESSION_TOP=$(git rev-parse --show-toplevel 2>/dev/null)
COMMON=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
MAIN_ROOT=$(dirname "$COMMON")

if [ -z "$SESSION_TOP" ] || [ -z "$COMMON" ] || [ "$SESSION_TOP" = "$MAIN_ROOT" ]; then
  echo "❌ CANNOT VALIDATE: this suite must run from inside a git worktree."
  echo "   session top: ${SESSION_TOP:-<none>}"
  echo "   main root  : ${MAIN_ROOT:-<none>}"
  echo "   Refusing to report success — the blocking cases would all be skipped."
  exit 1
fi

# Classify the guard's output: DENY only if the full envelope is well-formed.
classify() {
  printf '%s' "$1" | python3 -c '
import sys, json
raw = sys.stdin.read().strip()
if not raw:
    print("ALLOW"); raise SystemExit
try:
    d = json.loads(raw)
except Exception:
    print("MALFORMED"); raise SystemExit
h = d.get("hookSpecificOutput")
if not isinstance(h, dict):
    print("MALFORMED"); raise SystemExit
if h.get("hookEventName") != "PreToolUse":
    print("MALFORMED"); raise SystemExit
if h.get("permissionDecision") == "deny":
    print("DENY" if h.get("permissionDecisionReason") else "MALFORMED")
else:
    print("ALLOW")
'
}

# run <label> <expect DENY|ALLOW> <json> [env-assignment]
run() {
  label=$1; expect=$2; json=$3; envassign=$4
  if [ -n "$envassign" ]; then
    out=$(cd "$SESSION_TOP" && printf '%s' "$json" | env "$envassign" bash "$GUARD" 2>/dev/null)
  else
    out=$(cd "$SESSION_TOP" && printf '%s' "$json" | bash "$GUARD" 2>/dev/null)
  fi
  got=$(classify "$out")
  if [ "$got" = "$expect" ]; then
    echo "  ✅ $label"
    PASS=$((PASS+1))
  else
    echo "  ❌ $label — expected $expect, got $got"
    [ -n "$out" ] && echo "     output: $(printf '%s' "$out" | head -c 200)"
    FAIL=$((FAIL+1))
  fi
}

# Build a realistic nested payload.
w() { printf '{"tool_name":"Write","tool_input":{"file_path":"%s"}}' "$1"; }
b() { printf '{"tool_name":"Bash","tool_input":{"command":"%s"}}' "$1"; }

echo "Worktree session:"
echo "  worktree : $SESSION_TOP"
echo "  main repo: $MAIN_ROOT"
echo

echo "THE REGRESSION THAT MATTERS — real payload shape (was inert before):"
run "Write into MAIN repo is BLOCKED" DENY "$(w "$MAIN_ROOT/lib/portal/mark-thread-read.ts")"
run "New file into MAIN repo is BLOCKED" DENY "$(w "$MAIN_ROOT/tests/unit/x.test.ts")"
run "Legacy FLAT payload still blocked (back-compat)" DENY \
  "$(printf '{"file_path":"%s/lib/x.ts"}' "$MAIN_ROOT")"
run "NotebookEdit param is covered" DENY \
  "$(printf '{"tool_name":"NotebookEdit","tool_input":{"notebook_path":"%s/x.ipynb"}}' "$MAIN_ROOT")"
echo

echo "Path-normalization bypasses (all were ALLOWED before):"
run "..-escape out of the worktree is BLOCKED" DENY "$(w "$SESSION_TOP/../../../lib/x.ts")"
run "Relative ..-escape is BLOCKED" DENY "$(w "../../../lib/x.ts")"
run "Doubled slash before repo name is BLOCKED" DENY \
  "$(w "$(dirname "$MAIN_ROOT")//$(basename "$MAIN_ROOT")/lib/x.ts")"
echo

echo "Must NOT block legitimate writes:"
run "Write inside this worktree is allowed" ALLOW "$(w "$SESSION_TOP/lib/portal/mark-thread-read.ts")"
run "Relative path inside worktree is allowed" ALLOW "$(w "lib/portal/mark-thread-read.ts")"
run "Path outside the repo entirely is allowed" ALLOW "$(w "/tmp/scratch.txt")"
echo

echo "Sibling worktree is not ours either:"
run "Write into another worktree is BLOCKED" DENY \
  "$(w "$MAIN_ROOT/.claude/worktrees/some-other-wt/lib/x.ts")"
echo

echo "READS MUST ALWAYS PASS (the 360-degree-view requirement):"
run "cat a main-repo file" ALLOW "$(b "cat $MAIN_ROOT/CLAUDE.md")"
run "git log in the main repo" ALLOW "$(b "git -C $MAIN_ROOT log --oneline -5")"
run "git stash list in main (the incident recovery)" ALLOW "$(b "git -C $MAIN_ROOT stash list")"
run "git show a blob from main" ALLOW "$(b "git -C $MAIN_ROOT show HEAD:lib/x.ts")"
run "grep across the main checkout" ALLOW "$(b "grep -rn foo $MAIN_ROOT/lib")"
run "ls the main checkout" ALLOW "$(b "ls -la $MAIN_ROOT/lib")"
run "diff worktree against main" ALLOW "$(b "diff $SESSION_TOP/lib/x.ts $MAIN_ROOT/lib/x.ts")"
run "cd into main then READ only" ALLOW "$(b "cd $MAIN_ROOT && git status --short")"
run "stderr redirect to /dev/null is not a main write" ALLOW "$(b "cat $MAIN_ROOT/x.ts 2>/dev/null")"
run "copy FROM main INTO the worktree (a read of main)" ALLOW \
  "$(b "cp $MAIN_ROOT/lib/x.ts $SESSION_TOP/lib/x.ts")"
echo

echo "WRITES into main via Bash must be blocked:"
run "redirect output into main" DENY "$(b "echo hi > $MAIN_ROOT/lib/x.ts")"
run "append into main" DENY "$(b "echo hi >> $MAIN_ROOT/docs/x.md")"
run "cp worktree -> main (was allowed: worktree mention waved it through)" DENY \
  "$(b "cp $SESSION_TOP/lib/x.ts $MAIN_ROOT/lib/x.ts")"
run "rm a main-repo file" DENY "$(b "rm -f $MAIN_ROOT/lib/x.ts")"
run "sed -i on a main-repo file" DENY "$(b "sed -i '' s/a/b/ $MAIN_ROOT/lib/x.ts")"
run "git checkout in main" DENY "$(b "git -C $MAIN_ROOT checkout main")"
run "cd into main then build" DENY "$(b "cd $MAIN_ROOT && npm run build")"
run "relative cd escape then build (was undetected)" DENY "$(b "cd ../../.. && npm run build")"
echo

echo "Override must be ANCHORED, not a loose mention:"
run "Override at the START allows a main write" ALLOW \
  "$(b "ALLOW_MAIN_REPO_WRITE=1 git -C $MAIN_ROOT checkout -- lib/x.ts")"
run "Override in env allows a main write" ALLOW "$(w "$MAIN_ROOT/lib/x.ts")" "ALLOW_MAIN_REPO_WRITE=1"
run "MENTIONING the override in a doc write does NOT disarm (was a blocker)" DENY \
  "$(b "echo 'use ALLOW_MAIN_REPO_WRITE=1 to override' > $MAIN_ROOT/docs/systems/x.md")"
run "Override buried mid-command does NOT disarm" DENY \
  "$(b "echo x; ALLOW_MAIN_REPO_WRITE=1; rm $MAIN_ROOT/lib/x.ts")"
echo

echo "Malformed / hostile input must fail OPEN (never wedge a session):"
run "empty stdin" ALLOW ""
run "malformed JSON" ALLOW '{"tool_input":'
run "JSON that is not an object" ALLOW '"just a string"'
run "no recognised parameters" ALLOW '{"tool_name":"Read","tool_input":{"offset":1}}'
echo

echo "-------------------------------"
echo "PASS: $PASS   FAIL: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
