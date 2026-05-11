#!/usr/bin/env bash
# test-send-guard.sh
# Test harness for send-guard.sh.
# Synthesizes PreToolUse JSON payloads with known tool names and pipes them
# through the hook. Asserts on the block/allow decision in the output.

set -uo pipefail

HOOK_SCRIPT="$(cd "$(dirname "$0")" && pwd)/send-guard.sh"
SENTINEL="/tmp/claude-allow-client-send"
FAILURES=0

# Clean any leftover state from a previous run.
rm -f "$SENTINEL"
unset ALLOW_CLIENT_SEND

run_case() {
  local name="$1"
  local tool_name="$2"
  local expect="$3"  # "block" or "allow"

  local payload
  payload=$(python3 -c "import json,sys; print(json.dumps({'tool_name': sys.argv[1], 'tool_input': {}}))" "$tool_name")

  local output
  output=$(printf '%s' "$payload" | bash "$HOOK_SCRIPT" 2>&1) || true

  local got
  if echo "$output" | grep -q '"permissionDecision":"deny"'; then
    got="block"
  else
    got="allow"
  fi

  if [ "$got" = "$expect" ]; then
    echo "  PASS: $name"
  else
    echo "  FAIL: $name — expected $expect, got $got"
    echo "    tool_name: $tool_name"
    echo "    output: $output"
    FAILURES=$((FAILURES + 1))
  fi
}

SEND_TOOLS=(portal_chat_send gmail_send gmail_draft offer_send lease_send oa_send portal_team_send msg_send portal_invoice_send)

echo "─── Block all 9 send tools — sandbox transport ───"
for tool in "${SEND_TOOLS[@]}"; do
  rm -f "$SENTINEL"
  run_case "block-sandbox-$tool" "mcp__td-ops-sandbox__$tool" "block"
done

echo ""
echo "─── Block all 9 send tools — production transport ───"
for tool in "${SEND_TOOLS[@]}"; do
  rm -f "$SENTINEL"
  run_case "block-prod-$tool" "mcp__af7d85f2-1234-5678-9012__$tool" "block"
done

echo ""
echo "─── Allow non-send tools ───"
rm -f "$SENTINEL"
run_case "allow-crm-search-accounts" "mcp__td-ops-sandbox__crm_search_accounts" "allow"
rm -f "$SENTINEL"
run_case "allow-gmail-search-not-send" "mcp__td-ops-sandbox__gmail_search" "allow"
rm -f "$SENTINEL"
run_case "allow-gmail-read" "mcp__td-ops-sandbox__gmail_read" "allow"
rm -f "$SENTINEL"
run_case "allow-execute-sql" "mcp__af7d85f2-abc__execute_sql" "allow"
rm -f "$SENTINEL"
run_case "allow-bash-tool" "Bash" "allow"
rm -f "$SENTINEL"
run_case "allow-edit-tool" "Edit" "allow"
rm -f "$SENTINEL"
run_case "allow-write-tool" "Write" "allow"

echo ""
echo "─── Allow name-collision near-misses (must not block) ───"
# Names that contain a send-tool substring but don't end with one — regex is anchored.
rm -f "$SENTINEL"
run_case "allow-gmail-send-status-suffix" "mcp__td-ops-sandbox__gmail_send_status" "allow"
rm -f "$SENTINEL"
run_case "allow-portal-chat-inbox" "mcp__td-ops-sandbox__portal_chat_inbox" "allow"
rm -f "$SENTINEL"
run_case "allow-portal-chat-read" "mcp__td-ops-sandbox__portal_chat_read" "allow"

echo ""
echo "─── Fail-open on malformed input ───"
rm -f "$SENTINEL"
# Empty tool_name — should allow (fail-open)
run_case "allow-empty-tool-name" "" "allow"
# Completely invalid JSON — should also allow (fail-open)
echo "  Testing: allow-invalid-json"
output=$(printf 'this is not json' | bash "$HOOK_SCRIPT" 2>&1) || true
if echo "$output" | grep -q '"permissionDecision":"deny"'; then
  echo "  FAIL: allow-invalid-json — expected allow, got block"
  echo "    output: $output"
  FAILURES=$((FAILURES + 1))
else
  echo "  PASS: allow-invalid-json"
fi

echo ""
echo "─── One-shot sentinel: allows one call, then consumed ───"
rm -f "$SENTINEL"
touch "$SENTINEL"
run_case "sentinel-allows-first-call" "mcp__td-ops-sandbox__gmail_send" "allow"
if [ -f "$SENTINEL" ]; then
  echo "  FAIL: sentinel-consumed-after-allow — sentinel still exists"
  FAILURES=$((FAILURES + 1))
else
  echo "  PASS: sentinel-consumed-after-allow"
fi
# Without re-touching, second call must block.
run_case "sentinel-blocks-second-call" "mcp__td-ops-sandbox__gmail_send" "block"

echo ""
echo "─── Sentinel only consumed for send tools, not other tools ───"
# If sentinel exists but tool is not a send tool, hook should exit early
# WITHOUT consuming the sentinel (the sentinel is reserved for the next real send).
rm -f "$SENTINEL"
touch "$SENTINEL"
run_case "sentinel-not-consumed-by-non-send" "mcp__td-ops-sandbox__crm_search_accounts" "allow"
if [ -f "$SENTINEL" ]; then
  echo "  PASS: sentinel-preserved-on-non-send"
else
  echo "  FAIL: sentinel-preserved-on-non-send — sentinel was wrongly consumed"
  FAILURES=$((FAILURES + 1))
fi
rm -f "$SENTINEL"

echo ""
echo "─── Env var override ───"
export ALLOW_CLIENT_SEND=1
rm -f "$SENTINEL"
run_case "envvar-allows-call" "mcp__td-ops-sandbox__gmail_send" "allow"
# Env-var path should not touch the sentinel (none exists here, but verify the flow).
run_case "envvar-still-allows-second-call" "mcp__td-ops-sandbox__portal_chat_send" "allow"
unset ALLOW_CLIENT_SEND
# After unsetting, block returns.
run_case "envvar-unset-blocks-again" "mcp__td-ops-sandbox__gmail_send" "block"

echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "All tests passed."
  exit 0
else
  echo "$FAILURES test(s) failed."
  exit 1
fi
