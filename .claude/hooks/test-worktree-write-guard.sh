#!/bin/bash
# test-worktree-write-guard.sh — proves the FILE-WRITE guard works.
#
# Run:  bash .claude/hooks/test-worktree-write-guard.sh
#
# Scope note: the guard is wired on Edit|Write only. Commands are deliberately
# not inspected (see the header of worktree-write-guard.sh), so there are no
# command cases here — the safety net for those is
# test-main-repo-change-detector.sh.
#
# HARD-LEARNED RULES (the first version of this suite was green against a guard
# that was 100% inert):
#  1. Payloads use the REAL nested shape ({"tool_name":..,"tool_input":{..}}).
#     One flat case is kept only to pin back-compat.
#  2. Assertions PARSE the JSON and check the full protocol envelope, not a
#     substring — a structurally-wrong-but-compact deny used to pass silently.
#  3. Refuse to report success if not run inside a worktree.

GUARD="$(cd "$(dirname "$0")" && pwd)/worktree-write-guard.sh"
PASS=0; FAIL=0

SESSION_TOP=$(git rev-parse --show-toplevel 2>/dev/null)
COMMON=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
MAIN_ROOT=$(dirname "$COMMON")

if [ -z "$SESSION_TOP" ] || [ -z "$COMMON" ] || [ "$SESSION_TOP" = "$MAIN_ROOT" ]; then
  echo "❌ CANNOT VALIDATE: must run from inside a git worktree."
  echo "   session top: ${SESSION_TOP:-<none>}   main root: ${MAIN_ROOT:-<none>}"
  exit 1
fi

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
if not isinstance(h, dict) or h.get("hookEventName") != "PreToolUse":
    print("MALFORMED"); raise SystemExit
if h.get("permissionDecision") == "deny":
    print("DENY" if h.get("permissionDecisionReason") else "MALFORMED")
else:
    print("ALLOW")
'
}

# run <label> <expect> <json> [env] [cwd] [PATH-override]
run() {
  label=$1; expect=$2; json=$3; envassign=$4; cwd=${5:-$SESSION_TOP}; pathover=$6
  if [ -n "$pathover" ]; then
    # Absolute interpreter path: `env PATH=X bash` would make env look for bash
    # on the stripped PATH and die with 127 before the guard ever runs.
    out=$(cd "$cwd" && printf '%s' "$json" | env PATH="$pathover" /bin/bash "$GUARD" 2>/dev/null)
  elif [ -n "$envassign" ]; then
    out=$(cd "$cwd" && printf '%s' "$json" | env "$envassign" bash "$GUARD" 2>/dev/null)
  else
    out=$(cd "$cwd" && printf '%s' "$json" | bash "$GUARD" 2>/dev/null)
  fi
  got=$(classify "$out")
  if [ "$got" = "$expect" ]; then
    echo "  ✅ $label"; PASS=$((PASS+1))
  else
    echo "  ❌ $label — expected $expect, got $got"
    [ -n "$out" ] && echo "     output: $(printf '%s' "$out" | head -c 200)"
    FAIL=$((FAIL+1))
  fi
}

w() { printf '{"tool_name":"Write","tool_input":{"file_path":"%s"}}' "$1"; }

echo "Worktree: $SESSION_TOP"
echo "Main    : $MAIN_ROOT"
echo

echo "THE REGRESSION THAT MATTERS (real payload shape; was inert before):"
run "write into MAIN is BLOCKED" DENY "$(w "$MAIN_ROOT/lib/portal/mark-thread-read.ts")"
run "new file into MAIN is BLOCKED" DENY "$(w "$MAIN_ROOT/tests/unit/x.test.ts")"
run "legacy FLAT payload still blocked" DENY "$(printf '{"file_path":"%s/lib/x.ts"}' "$MAIN_ROOT")"
run "notebook_path is covered" DENY \
  "$(printf '{"tool_name":"NotebookEdit","tool_input":{"notebook_path":"%s/x.ipynb"}}' "$MAIN_ROOT")"
echo

echo "Path-normalization bypasses:"
run "..-escape out of the worktree is BLOCKED" DENY "$(w "$SESSION_TOP/../../../lib/x.ts")"
run "relative ..-escape is BLOCKED" DENY "$(w "../../../lib/x.ts")"
run "doubled slash is BLOCKED" DENY "$(w "$(dirname "$MAIN_ROOT")//$(basename "$MAIN_ROOT")/lib/x.ts")"
run "case-variant main path is BLOCKED" DENY "$(w "$(printf '%s' "$MAIN_ROOT" | tr 'a-z' 'A-Z')/lib/x.ts")"
echo

echo "Sibling worktree is not ours either:"
run "write into another worktree is BLOCKED" DENY "$(w "$MAIN_ROOT/.claude/worktrees/other-wt/lib/x.ts")"
echo

echo "Must NOT block legitimate writes:"
run "inside this worktree" ALLOW "$(w "$SESSION_TOP/lib/portal/mark-thread-read.ts")"
run "relative path inside worktree" ALLOW "$(w "lib/portal/mark-thread-read.ts")"
run "outside the repo entirely" ALLOW "$(w "/tmp/scratch.txt")"
run "sibling dir that merely shares the prefix" ALLOW "$(w "${MAIN_ROOT}-sandbox/lib/x.ts")"
echo

echo "Override:"
run "env override allows a main write" ALLOW "$(w "$MAIN_ROOT/lib/x.ts")" "ALLOW_MAIN_REPO_WRITE=1"
echo

echo "Normal (non-worktree) sessions untouched:"
run "main write from a MAIN-repo session" ALLOW "$(w "$MAIN_ROOT/lib/x.ts")" "" "$MAIN_ROOT"
echo

echo "python3-missing FALLBACK still denies (was fail-open):"
# A PATH containing git and the core utils but NOT python3 — stripping PATH
# entirely would also hide git, and the wrapper would exit before the fallback.
FAKEBIN=$(mktemp -d)
# Resolve from standard dirs, NOT `command -v` — an interactive shell may alias
# a name (e.g. grep), which would silently create a broken symlink.
for prog in git dirname sed grep head cat shasum comm sort wc tr; do
  for d in /usr/bin /bin /usr/sbin /sbin; do
    if [ -x "$d/$prog" ]; then ln -sf "$d/$prog" "$FAKEBIN/$prog"; break; fi
  done
done
if [ -e "$FAKEBIN/python3" ]; then
  echo "  ⚠️  could not isolate python3 — fallback cases would be meaningless"; FAIL=$((FAIL+1))
fi
run "fallback blocks a main write" DENY "$(w "$MAIN_ROOT/lib/x.ts")" "" "$SESSION_TOP" "$FAKEBIN"
run "fallback blocks notebook_path too" DENY \
  "$(printf '{"tool_name":"NotebookEdit","tool_input":{"notebook_path":"%s/x.ipynb"}}' "$MAIN_ROOT")" \
  "" "$SESSION_TOP" "$FAKEBIN"
run "fallback allows a worktree write" ALLOW "$(w "$SESSION_TOP/lib/x.ts")" "" "$SESSION_TOP" "$FAKEBIN"
run "fallback fails CLOSED on a ..-escape it cannot resolve" DENY \
  "$(w "$SESSION_TOP/../../../lib/x.ts")" "" "$SESSION_TOP" "$FAKEBIN"
rm -rf "$FAKEBIN"
echo

echo "Malformed / hostile input must fail OPEN (never wedge a session):"
run "empty stdin" ALLOW ""
run "malformed JSON" ALLOW '{"tool_input":'
run "JSON not an object" ALLOW '"just a string"'
run "no recognised parameters" ALLOW '{"tool_name":"Read","tool_input":{"offset":1}}'
run "file_path is not a string" ALLOW '{"tool_name":"Write","tool_input":{"file_path":123}}'
echo

echo "-------------------------------"
echo "PASS: $PASS   FAIL: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
