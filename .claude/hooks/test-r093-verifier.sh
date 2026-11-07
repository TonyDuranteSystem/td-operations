#!/usr/bin/env bash
# test-r093-verifier.sh
# Test harness for the independent R093 verifier (r093-verifier.sh → r093_verifier.py).
# Puts a FAKE `claude` on PATH that returns a canned auditor verdict, so the
# whole block path runs offline: transcript parse → auditor JSON → block text →
# diagnostic log. Pins the 2026-11-06 wording ("reply with ONLY the fix", the
# corrected-draft rule, "say what you re-checked") and the claim logging.

set -euo pipefail

HOOK_SCRIPT="$(cd "$(dirname "$0")" && pwd)/r093-verifier.sh"
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

FAILURES=0
mkdir -p "$TMPDIR/bin"

# Synthetic session: one user prompt, one tool result this turn, a long answer.
TRANSCRIPT="$TMPDIR/transcript.jsonl"
python3 - "$TRANSCRIPT" <<'PY'
import json, sys
with open(sys.argv[1], "w") as f:
    f.write(json.dumps({"type": "user", "message": {"content": "check the offer"}}) + "\n")
    f.write(json.dumps({"type": "assistant", "message": {"content": [
        {"type": "tool_use", "id": "t1", "name": "offer_get", "input": {}}]}}) + "\n")
    f.write(json.dumps({"type": "user", "message": {"content": [
        {"type": "tool_result", "tool_use_id": "t1", "content": "offer total 30000 USD"}]}}) + "\n")
    f.write(json.dumps({"type": "assistant", "message": {"content": [
        {"type": "text", "text": "The offer total is 35000 USD and the client agreed to it last week, "
                                  "so the draft email below quotes that amount and is ready to send."}]}}) + "\n")
PY

# fake_claude <json the auditor should print>
fake_claude() {
  printf '#!/usr/bin/env bash\ncat <<'"'"'EOF'"'"'\n%s\nEOF\n' "$1" > "$TMPDIR/bin/claude"
  chmod +x "$TMPDIR/bin/claude"
}

# run_hook <stop_hook_active true|false> → prints hook stdout; log goes to $LOG
run_hook() {
  : > "$LOG"
  python3 -c "import json,sys; print(json.dumps({'transcript_path': sys.argv[1], 'stop_hook_active': sys.argv[2]=='true', 'hook_event_name': 'Stop'}))" \
    "$TRANSCRIPT" "$1" \
    | PATH="$TMPDIR/bin:$PATH" R093_VERIFIER_LOG="$LOG" R093_NET_STATUS="$TMPDIR/down" bash "$HOOK_SCRIPT" 2>/dev/null
}

expect_contains() { # name haystack needle
  if printf '%s' "$2" | grep -qF -- "$3"; then echo "  PASS: $1"; else echo "  FAIL: $1 (missing: $3)"; FAILURES=$((FAILURES+1)); fi
}
expect_empty() { # name haystack
  if [ -z "$2" ]; then echo "  PASS: $1"; else echo "  FAIL: $1 (expected silence, got: ${2:0:80})"; FAILURES=$((FAILURES+1)); fi
}

LOG="$TMPDIR/verifier.log"

# --- 1. contradiction → block, with the new wording ---------------------------
fake_claude '{"violations":[{"claim":"The offer total is 35000 USD","issue":"contradiction","evidence":"offer total 30000 USD"}]}'
OUT=$(run_hook false)
expect_contains "blocks on a contradiction"            "$OUT" '"decision": "block"'
expect_contains "tells the session the user already read it" "$OUT" 'ALREADY read your previous answer'
expect_contains "reply with ONLY the fix"              "$OUT" 'reply with ONLY the fix'
expect_contains "wrong draft/number is re-sent in full" "$OUT" 're-send ONLY that corrected draft or number in full'
expect_contains "marked as replacing the earlier one"  "$OUT" 'marked as replacing the earlier one'
expect_contains "'stands' must say what was re-checked" "$OUT" 'what you re-checked and what it showed'
expect_contains "does not narrate the audit"           "$OUT" 'Do not narrate this audit'
expect_contains "keeps the plain-English footer clause" "$OUT" "'Technical details' footer"
if printf '%s' "$OUT" | grep -qF 'tell the user what changed'; then
  echo "  FAIL: old 'tell the user what changed' wording is back"; FAILURES=$((FAILURES+1))
else
  echo "  PASS: old 're-tell' wording is gone"
fi

# --- 2. the claim text is logged (truncated), not just a count ----------------
LOGTXT=$(cat "$LOG")
expect_contains "log has decision_block"               "$LOGTXT" '"event": "decision_block"'
expect_contains "log has the flagged claim text"       "$LOGTXT" 'The offer total is 35000 USD'
expect_contains "log has the issue type"               "$LOGTXT" '"contradiction"'

# --- 3. a very long claim is truncated to 160 chars ---------------------------
LONG=$(python3 -c "print('x'*400)")
fake_claude "{\"violations\":[{\"claim\":\"$LONG\",\"issue\":\"ungrounded\",\"evidence\":\"absent\"}]}"
run_hook false >/dev/null
LONGLOGGED=$(python3 -c "
import json,sys
for l in open(sys.argv[1]):
    e=json.loads(l)
    if e['event']=='decision_block': print(len(e['claims'][0]))
" "$LOG")
if [ "$LONGLOGGED" = "160" ]; then echo "  PASS: long claim truncated to 160 chars"; else echo "  FAIL: long claim logged as $LONGLOGGED chars"; FAILURES=$((FAILURES+1)); fi

# --- 4. clean verdict → silent -------------------------------------------------
fake_claude '{"violations":[]}'
OUT=$(run_hook false)
expect_empty "silent when the auditor finds nothing" "$OUT"

# --- 5. forced follow-up (stop_hook_active) → never re-blocks -------------------
fake_claude '{"violations":[{"claim":"c","issue":"ungrounded","evidence":"absent"}]}'
OUT=$(run_hook true)
expect_empty "never blocks a forced follow-up" "$OUT"

# --- 6. kill switch ---------------------------------------------------------------
: > "$LOG"
OUT=$(python3 -c "import json,sys; print(json.dumps({'transcript_path': sys.argv[1], 'stop_hook_active': False}))" "$TRANSCRIPT" \
  | PATH="$TMPDIR/bin:$PATH" R093_VERIFIER_LOG="$LOG" R093_VERIFIER_OFF=1 bash "$HOOK_SCRIPT" 2>/dev/null)
expect_empty "kill switch R093_VERIFIER_OFF silences it" "$OUT"

echo
if [ "$FAILURES" -eq 0 ]; then echo "All tests passed."; else echo "$FAILURES test(s) FAILED."; exit 1; fi
