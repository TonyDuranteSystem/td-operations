#!/usr/bin/env bash
# test-r095-gate.sh
# Test harness for the blocking r095 gate (r095-gate.sh → r095_gate.py).
# Builds synthetic transcripts and verifies the gate blocks jargon-heavy
# reply bodies and passes plain/compliant ones. "block" = the hook emitted
# {"decision":"block"}; "clean" = it stayed silent (fail-open).

set -euo pipefail

HOOK_SCRIPT="$(cd "$(dirname "$0")" && pwd)/r095-gate.sh"
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

FAILURES=0

# run_case <name> <user_prompt> <assistant_text> <expect: block|clean>
run_case() {
  local name="$1"
  local user_text="$2"
  local text="$3"
  local expect="$4"

  local transcript="$TMPDIR/transcript-$RANDOM.jsonl"
  python3 - "$transcript" "$user_text" "$text" <<'PY'
import json, sys
path, user_text, assistant_text = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path, "w") as f:
    f.write(json.dumps({"type": "user", "message": {"content": user_text}}) + "\n")
    f.write(json.dumps({"type": "assistant", "message": {"content": [
        {"type": "text", "text": assistant_text}]}}) + "\n")
PY
  check_case "$name" "$transcript" "$expect"
}

check_case() {
  local name="$1" transcript="$2" expect="$3"
  local payload output got
  payload=$(python3 -c "import json,sys; print(json.dumps({'transcript_path': sys.argv[1], 'stop_hook_active': False, 'hook_event_name': 'Stop'}))" "$transcript")
  output=$(echo "$payload" | bash "$HOOK_SCRIPT" 2>&1)
  if echo "$output" | grep -q '"decision": *"block"'; then
    got="block"
  else
    got="clean"
  fi
  if [ "$got" = "$expect" ]; then
    echo "  PASS: $name"
  else
    echo "  FAIL: $name — expected $expect, got $got"
    echo "    output: $output"
    FAILURES=$((FAILURES + 1))
  fi
}

echo "─── R095 blocking gate tests ───"

# ── Blocks: jargon in the reply body ──────────────────────────────
run_case "two-file-paths" "how does the email system work?" \
  "The handler is lib/operations/email.ts and tracking lives in lib/gmail.ts." \
  "block"

run_case "daily-drip-path-plus-commit" "did you fix it?" \
  "Fixed in lib/foo.ts:42, commit abc1234f, pushed." \
  "block"

run_case "schema-refs" "where is the client language stored?" \
  "It's in email_tracking.account_id and the tier is accounts.portal_tier." \
  "block"

run_case "backticked-code-identifiers" "how do offers go out?" \
  "We call \`sendEmail\` then \`createOffer()\` handles the rest." \
  "block"

run_case "footer-stuffing-evasion" "status?" \
  "Technical details: lib/a.ts changed, lib/b.ts changed, commit deadbee1 pushed." \
  "block"

run_case "council-verdict-pasted-in-body" "what did the review find?" \
  "The reviewer flagged lib/portal/queries.ts:120 and said email_tracking.account_id is wrong." \
  "block"

# ── Clean: plain bodies and compliant shapes ──────────────────────
run_case "plain-english" "how does the email system work?" \
  "The email system is working. I sent a test to your inbox and it arrived." \
  "clean"

run_case "plain-body-with-technical-footer" "did you fix it?" \
  "The invoice bug is fixed: totals now match what clients actually paid, and I verified it on a real example end to end.

**Technical details:** lib/portal/td-invoice.ts:88, commit abc1234f, payments.amount_usd." \
  "clean"

run_case "code-fence-excluded" "show me how to run the tests" \
  "Run this:
\`\`\`bash
npm run test:unit
bash scripts/check-catalog-validity.ts
\`\`\`
That runs everything." \
  "clean"

run_case "offer-draft-with-hex-link" "prepare the offer draft" \
  "Here is the draft for your approval:

> Hi Mario, your offer is ready at app.tonydurante.us/offer/9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c and expires Friday.

Say send it and I will send exactly this." \
  "clean"

run_case "backticked-plain-words" "anything else?" \
  "Say \`go\` when ready, or \`continua\` to resume where we left off." \
  "clean"

run_case "single-path-line-ref-deduped" "quick status" \
  "One file changed: lib/foo.ts:42 — everything else is untouched and tests pass." \
  "clean"

run_case "urls-and-product-names" "where do clients pay?" \
  "Clients log in at portal.tonydurante.us and pay there. Stripe is the default gateway, Whop is opt-in." \
  "clean"

run_case "times-and-currency" "when is the invoice due?" \
  "Invoice INV-001 for 100.00 USD is due at 14:30 tomorrow." \
  "clean"

run_case "user-named-the-file-whitelist" "what does CLAUDE.md say about testing?" \
  "CLAUDE.md requires unit tests before any push, and it also requires a real browser check." \
  "clean"

# ── Skips: the user's own prompt disables the gate ────────────────
run_case "citation-request-english" "show me the file and line for that" \
  "It's lib/operations/email.ts:120 and lib/gmail.ts:45." \
  "clean"

run_case "citation-request-italian" "dove nel codice viene inviata l'email?" \
  "In lib/operations/email.ts:120, chiamando sendViaGmail in lib/gmail.ts:45." \
  "clean"

run_case "technical-user-prompt" "why does lib/portal/queries.ts return null here?" \
  "Because getPortalFlows filters on account_id and service_deliveries.stage excludes it." \
  "clean"

# ── Structural cases (hand-built transcripts) ─────────────────────

# Post-compaction: no genuine human prompt → scan ONLY the final assistant
# message (older jargon-heavy messages must not leak into the count).
t="$TMPDIR/post-compaction.jsonl"
python3 - "$t" <<'PY'
import json, sys
with open(sys.argv[1], "w") as f:
    f.write(json.dumps({"type": "user", "isCompactSummary": True,
        "message": {"content": "compact summary full of lib/a.ts lib/b.ts commit deadbee1"}}) + "\n")
    f.write(json.dumps({"type": "assistant", "message": {"content": [
        {"type": "text", "text": "Old reply mentioning lib/old.ts:10 and lib/older.ts:20."}]}}) + "\n")
    f.write(json.dumps({"type": "assistant", "message": {"content": [
        {"type": "text", "text": "Everything is back up and running. The fix from before compaction is holding."}]}}) + "\n")
PY
check_case "post-compaction-scans-final-message-only" "$t" "clean"

# Post-compaction with a jargon-heavy FINAL message → still gated.
t="$TMPDIR/post-compaction-block.jsonl"
python3 - "$t" <<'PY'
import json, sys
with open(sys.argv[1], "w") as f:
    f.write(json.dumps({"type": "user", "isCompactSummary": True,
        "message": {"content": "compact summary"}}) + "\n")
    f.write(json.dumps({"type": "assistant", "message": {"content": [
        {"type": "text", "text": "Resumed. Changes are in lib/foo.ts:42 and lib/bar.ts:77 as before."}]}}) + "\n")
PY
check_case "post-compaction-final-message-still-gated" "$t" "block"

# Multi-block reply: jargon in the FIRST text block, plain closing block —
# all blocks after the last human prompt must be scanned together.
t="$TMPDIR/multi-block.jsonl"
python3 - "$t" <<'PY'
import json, sys
with open(sys.argv[1], "w") as f:
    f.write(json.dumps({"type": "user", "message": {"content": "status?"}}) + "\n")
    f.write(json.dumps({"type": "assistant", "message": {"content": [
        {"type": "text", "text": "Checked lib/foo.ts:42 and payments.amount_usd first."}]}}) + "\n")
    f.write(json.dumps({"type": "assistant", "message": {"content": [
        {"type": "text", "text": "All done and verified."}]}}) + "\n")
PY
check_case "multi-block-jargon-in-first-block" "$t" "block"

# Sidechain (subagent) assistant lines must be ignored — a council reviewer's
# cited report is not user-facing text.
t="$TMPDIR/sidechain.jsonl"
python3 - "$t" <<'PY'
import json, sys
with open(sys.argv[1], "w") as f:
    f.write(json.dumps({"type": "user", "message": {"content": "run the review"}}) + "\n")
    f.write(json.dumps({"type": "assistant", "isSidechain": True, "message": {"content": [
        {"type": "text", "text": "REVIEWER: defect at lib/a.ts:10, lib/b.ts:20, commit deadbee1."}]}}) + "\n")
    f.write(json.dumps({"type": "assistant", "message": {"content": [
        {"type": "text", "text": "The review finished: two issues found, both about how invoices are counted. Full references are on the job card."}]}}) + "\n")
PY
check_case "sidechain-reviewer-lines-ignored" "$t" "clean"

# stop_hook_active → one-shot enforcement, never re-block a forced rewrite.
t="$TMPDIR/stop-active.jsonl"
python3 - "$t" <<'PY'
import json, sys
with open(sys.argv[1], "w") as f:
    f.write(json.dumps({"type": "user", "message": {"content": "status?"}}) + "\n")
    f.write(json.dumps({"type": "assistant", "message": {"content": [
        {"type": "text", "text": "Still jargon: lib/foo.ts:42 and lib/bar.ts:77."}]}}) + "\n")
PY
payload=$(python3 -c "import json,sys; print(json.dumps({'transcript_path': sys.argv[1], 'stop_hook_active': True, 'hook_event_name': 'Stop'}))" "$t")
output=$(echo "$payload" | bash "$HOOK_SCRIPT" 2>&1)
if echo "$output" | grep -q '"decision": *"block"'; then
  echo "  FAIL: stop-hook-active-skips — expected clean, got block"
  FAILURES=$((FAILURES + 1))
else
  echo "  PASS: stop-hook-active-skips"
fi

# Kill switch.
t="$TMPDIR/kill-switch.jsonl"
python3 - "$t" <<'PY'
import json, sys
with open(sys.argv[1], "w") as f:
    f.write(json.dumps({"type": "user", "message": {"content": "status?"}}) + "\n")
    f.write(json.dumps({"type": "assistant", "message": {"content": [
        {"type": "text", "text": "Jargon: lib/foo.ts:42 and lib/bar.ts:77."}]}}) + "\n")
PY
payload=$(python3 -c "import json,sys; print(json.dumps({'transcript_path': sys.argv[1], 'stop_hook_active': False, 'hook_event_name': 'Stop'}))" "$t")
output=$(echo "$payload" | R095_GATE_OFF=1 bash "$HOOK_SCRIPT" 2>&1)
if echo "$output" | grep -q '"decision": *"block"'; then
  echo "  FAIL: kill-switch — expected clean, got block"
  FAILURES=$((FAILURES + 1))
else
  echo "  PASS: kill-switch"
fi

# Garbage stdin / missing transcript → fail-open, never crash.
output=$(echo "not json at all" | bash "$HOOK_SCRIPT" 2>&1) || true
if echo "$output" | grep -q '"decision": *"block"'; then
  echo "  FAIL: fail-open-garbage-stdin"
  FAILURES=$((FAILURES + 1))
else
  echo "  PASS: fail-open-garbage-stdin"
fi

echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "All tests passed."
  exit 0
else
  echo "$FAILURES test(s) failed."
  exit 1
fi
