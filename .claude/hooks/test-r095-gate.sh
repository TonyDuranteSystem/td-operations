#!/usr/bin/env bash
# test-r095-gate.sh
# Test harness for r095-gate.sh.
# Builds synthetic transcripts with known content and pipes them through
# the hook to verify regex patterns catch/ignore the expected strings.

set -euo pipefail

HOOK_SCRIPT="$(cd "$(dirname "$0")" && pwd)/r095-gate.sh"
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

FAILURES=0

run_case() {
  local name="$1"
  local text="$2"
  local expect="$3"  # "violation" or "clean"

  local transcript="$TMPDIR/transcript-$RANDOM.jsonl"
  # Escape the text for JSON
  local json_text
  json_text=$(printf '%s' "$text" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')
  printf '{"type":"user","message":{"content":"irrelevant"}}\n' > "$transcript"
  printf '{"type":"assistant","message":{"content":[{"type":"text","text":%s}]}}\n' "$json_text" >> "$transcript"

  local payload
  payload=$(python3 -c "import json; print(json.dumps({'transcript_path': '$transcript', 'stop_hook_active': False, 'hook_event_name': 'Stop'}))")

  local output
  output=$(echo "$payload" | bash "$HOOK_SCRIPT" 2>&1)

  local got
  if echo "$output" | grep -q 'R095_VIOLATION=true'; then
    got="violation"
  else
    got="clean"
  fi

  if [ "$got" = "$expect" ]; then
    echo "  PASS: $name"
  else
    echo "  FAIL: $name — expected $expect, got $got"
    echo "    text: $text"
    echo "    output: $output"
    FAILURES=$((FAILURES + 1))
  fi
}

echo "─── R095 gate tests ───"

# Violations — should trigger the gate
run_case "file-path-ts" \
  "Look at lib/operations/email.ts for the handler." \
  "violation"

run_case "file-path-with-line" \
  "The issue is in app/api/inbox/route.ts:42." \
  "violation"

run_case "schema-ref" \
  "The email_tracking.account_id column holds the link." \
  "violation"

run_case "backticked-identifier" \
  "We call \`sendEmail\` from the compose route." \
  "violation"

run_case "backticked-function-call" \
  "The \`createOffer()\` function handles it." \
  "violation"

run_case "commit-ref" \
  "Commit 3fd69d2 fixed that bug." \
  "violation"

run_case "multiple-violations" \
  "See lib/operations/email.ts — calls \`sendEmail()\` and writes to email_tracking.account_id." \
  "violation"

# Clean — should NOT trigger the gate
run_case "plain-english" \
  "The email system is working. I sent a test to your inbox." \
  "clean"

run_case "url-portal" \
  "Log in at portal.tonydurante.us to see your dashboard." \
  "clean"

run_case "url-app" \
  "The offer link is at app.tonydurante.us/offer/mario-rossi-2026." \
  "clean"

run_case "product-name" \
  "Stripe is the default payment gateway, Whop is opt-in." \
  "clean"

run_case "dashes-and-punctuation" \
  "The setup is done -- ready to ship. All good." \
  "clean"

run_case "numbers-and-currency" \
  "Invoice INV-001 for 100.00 USD is overdue." \
  "clean"

echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "All tests passed."
  exit 0
else
  echo "$FAILURES test(s) failed."
  exit 1
fi
