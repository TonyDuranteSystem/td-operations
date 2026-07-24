#!/bin/bash
# test-main-repo-change-detector.sh — proves the safety net actually detects a
# real change to the main checkout, and stays quiet otherwise.
#
# Run:  bash .claude/hooks/test-main-repo-change-detector.sh
#
# This test creates and removes a real temp file in the MAIN checkout (a name
# nothing else uses) because the whole point of the detector is that it observes
# the filesystem rather than parsing commands — a mocked test would prove
# nothing. It cleans up after itself, and fails loudly if it cannot.

HOOK="$(cd "$(dirname "$0")" && pwd)/main-repo-change-detector.sh"
PASS=0; FAIL=0

SESSION_TOP=$(git rev-parse --show-toplevel 2>/dev/null)
COMMON=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
MAIN_ROOT=$(dirname "$COMMON")

if [ -z "$SESSION_TOP" ] || [ "$SESSION_TOP" = "$MAIN_ROOT" ]; then
  echo "❌ CANNOT VALIDATE: must run from inside a git worktree."
  exit 1
fi

PROBE="$MAIN_ROOT/zz-detector-probe-$$.tmp"
SID="detector-test-$$"
PAYLOAD=$(printf '{"tool_name":"Bash","session_id":"%s","tool_input":{"command":"true"}}' "$SID")

cleanup() { rm -f "$PROBE"; }
trap cleanup EXIT

# Clear any stale baseline for this synthetic session id.
KEY=$(printf '%s|%s' "$SID" "$SESSION_TOP" | shasum 2>/dev/null | cut -c1-16)
rm -f "/tmp/claude-main-dirty-${KEY}"

fire() { (cd "$SESSION_TOP" && printf '%s' "$PAYLOAD" | bash "$HOOK" 2>/dev/null); }

check() {
  label=$1; expect=$2; out=$3
  case "$out" in
    *"MAIN CHECKOUT CHANGED"*) got=ALERT ;;
    "")                        got=SILENT ;;
    *)                         got=OTHER ;;
  esac
  if [ "$got" = "$expect" ]; then
    echo "  ✅ $label"; PASS=$((PASS+1))
  else
    echo "  ❌ $label — expected $expect, got $got"
    [ -n "$out" ] && echo "     output: $(printf '%s' "$out" | head -c 300)"
    FAIL=$((FAIL+1))
  fi
}

echo "Worktree: $SESSION_TOP"
echo "Main    : $MAIN_ROOT"
echo

echo "Baseline behaviour:"
check "first sight records a baseline and stays quiet" SILENT "$(fire)"
check "no change since baseline → silent" SILENT "$(fire)"
echo

echo "THE POINT — a real change in the main checkout is detected:"
echo "probe" > "$PROBE"
OUT=$(fire)
check "new file in main raises the alert" ALERT "$OUT"
case "$OUT" in
  *"$(basename "$PROBE")"*) echo "  ✅ the alert names the offending path"; PASS=$((PASS+1)) ;;
  *) echo "  ❌ the alert does not name the offending path"; FAIL=$((FAIL+1)) ;;
esac
echo

echo "Reported once, not on every later call:"
check "re-baselined → silent on the next call" SILENT "$(fire)"
echo

# By design the detector reports only NEWLY APPEARED dirt. A path leaving the
# dirty set means the main checkout got CLEANER (someone reverted or committed),
# which is not a hazard — alarming on it would be noise.
echo "Main getting CLEANER is not an alarm:"
rm -f "$PROBE"
check "removal is not reported" SILENT "$(fire)"
check "still silent afterwards" SILENT "$(fire)"
echo

echo "Kill switch:"
echo "probe" > "$PROBE"
OUT=$(cd "$SESSION_TOP" && printf '%s' "$PAYLOAD" | env MAIN_REPO_DETECTOR_OFF=1 bash "$HOOK" 2>/dev/null)
check "MAIN_REPO_DETECTOR_OFF=1 silences it" SILENT "$OUT"
rm -f "$PROBE"
(cd "$SESSION_TOP" && printf '%s' "$PAYLOAD" | bash "$HOOK" >/dev/null 2>&1)  # resettle
echo

echo "Normal (non-worktree) sessions untouched:"
OUT=$(cd "$MAIN_ROOT" && printf '%s' "$PAYLOAD" | bash "$HOOK" 2>/dev/null)
check "silent when run from the main repo itself" SILENT "$OUT"
echo

echo "Never blocks — it is PostToolUse, output is advisory only:"
(cd "$SESSION_TOP" && printf '%s' "$PAYLOAD" | bash "$HOOK" >/dev/null 2>&1)
if [ $? -eq 0 ]; then echo "  ✅ always exits 0"; PASS=$((PASS+1)); else echo "  ❌ non-zero exit"; FAIL=$((FAIL+1)); fi
echo

echo "Cleanup verification:"
if [ -f "$PROBE" ]; then echo "  ❌ probe file left behind: $PROBE"; FAIL=$((FAIL+1));
else echo "  ✅ probe file removed from the main checkout"; PASS=$((PASS+1)); fi

echo
echo "-------------------------------"
echo "PASS: $PASS   FAIL: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
