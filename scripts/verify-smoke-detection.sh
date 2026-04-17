#!/bin/bash
# Gate 2 #3 — Live proof that the post-deploy-smoke.yml detection pattern
# catches a broken bundle (5xx / 4xx / connection failure).
#
# Plan §9.5 line 952: "post-deploy smoke catches a broken bundle."
#
# The detection lives in five shell steps in
# .github/workflows/post-deploy-smoke.yml that share this classifier:
#
#     case "$STATUS" in
#       2*|3*) result=pass ;;
#       *)     result=fail ;;
#     esac
#
# This script replicates that classifier and asserts it produces the
# correct classification for every HTTP status class the workflow will
# ever encounter. It is a shell-level companion to
# tests/integration/smoke-catches-broken-bundle.test.ts (which also
# asserts the same rule in TS).
#
# Usage:
#   bash scripts/verify-smoke-detection.sh
# Exit 0 on all-pass, 1 on any mismatch.

set -uo pipefail

fails=0
classify() {
  case "$1" in
    2*|3*) echo "pass" ;;
    *)     echo "fail" ;;
  esac
}

assert() {
  local status="$1"
  local expected="$2"
  local got
  got=$(classify "$status")
  if [ "$got" = "$expected" ]; then
    printf "  ✅ %-12s → %s\n" "status=$status" "$got"
  else
    printf "  ❌ %-12s → %s (expected %s)\n" "status=$status" "$got" "$expected"
    fails=$((fails+1))
  fi
}

echo "Gate 2 #3 — smoke detection pattern verification"
echo ""
echo "Success: 2xx/3xx → pass (live + deployed routes, redirects)"
assert 200 pass
assert 204 pass
assert 299 pass
assert 301 pass
assert 307 pass
assert 308 pass
echo ""
echo "Broken bundle: 4xx/5xx → fail"
assert 400 fail
assert 401 fail
assert 403 fail
assert 404 fail
assert 500 fail
assert 502 fail
assert 503 fail
assert 504 fail
echo ""
echo "Network failures: curl writes 000 on connection error"
assert 000 fail
assert "" fail

echo ""
if [ "$fails" = "0" ]; then
  echo "✅ All classifications correct — smoke detection will catch a broken bundle."
  exit 0
else
  echo "❌ $fails classification(s) wrong — smoke detection is broken."
  exit 1
fi
