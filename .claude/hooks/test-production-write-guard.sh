#!/usr/bin/env bash
# test-production-write-guard.sh
# Test harness for production-write-guard.sh.
#
# Synthesizes PreToolUse JSON payloads with known tool names, modes, and
# queries, then pipes them through the hook and asserts the block/allow
# decision (and the block reason, where applicable).

set -uo pipefail

HOOK_SCRIPT="$(cd "$(dirname "$0")" && pwd)/production-write-guard.sh"
TODAY="$(date +%Y-%m-%d)"
MARKER="/tmp/.sandbox-verified-$TODAY"
PROD_TOOL="mcp__af7d85f2-3684-4443-8eac-bb32d00e32be__execute_sql"
SANDBOX_TOOL="mcp__td-ops-sandbox__execute_sql"
FAILURES=0

# Track whether the marker existed before the test run so we can restore it.
MARKER_PREEXISTING=0
if [ -f "$MARKER" ]; then
  MARKER_PREEXISTING=1
fi
rm -f "$MARKER"

cleanup() {
  rm -f "$MARKER"
  if [ "$MARKER_PREEXISTING" = "1" ]; then
    touch "$MARKER"
  fi
}
trap cleanup EXIT

# run_case <name> <tool_name> <mode> <query> <expect-block|expect-allow> [expected-reason-substring]
run_case() {
  local name="$1"
  local tool_name="$2"
  local mode="$3"
  local query="$4"
  local expect="$5"
  local reason_must_contain="${6:-}"

  local payload
  payload=$(python3 -c "
import json, sys
print(json.dumps({
    'tool_name': sys.argv[1],
    'tool_input': {
        'query': sys.argv[2],
        'mode': sys.argv[3],
    },
}))
" "$tool_name" "$query" "$mode")

  local output
  output=$(printf '%s' "$payload" | bash "$HOOK_SCRIPT" 2>&1) || true

  local got
  if echo "$output" | grep -q '"permissionDecision":"deny"'; then
    got="block"
  else
    got="allow"
  fi

  local pass=1
  if [ "$got" != "$expect" ]; then
    pass=0
  fi
  if [ -n "$reason_must_contain" ] && ! echo "$output" | grep -qF "$reason_must_contain"; then
    pass=0
  fi

  if [ "$pass" = "1" ]; then
    echo "  PASS: $name"
  else
    echo "  FAIL: $name — expected $expect${reason_must_contain:+ (reason contains '$reason_must_contain')}, got $got"
    echo "    tool: $tool_name"
    echo "    mode: $mode"
    echo "    query: $query"
    echo "    output: $output"
    FAILURES=$((FAILURES + 1))
  fi
}

echo "─── Production writes WITHOUT marker: blocked ───"
rm -f "$MARKER"
run_case "block-insert-no-marker" "$PROD_TOOL" "write" "INSERT INTO accounts (name) VALUES ('Test')" "block" "without sandbox verification"
run_case "block-update-no-marker" "$PROD_TOOL" "write" "UPDATE contacts SET name='X' WHERE id='abc'" "block" "without sandbox verification"
run_case "block-delete-no-marker" "$PROD_TOOL" "write" "DELETE FROM tasks WHERE id='abc'" "block" "without sandbox verification"
run_case "block-cte-update-no-marker" "$PROD_TOOL" "write" "WITH u AS (UPDATE accounts SET status='active' RETURNING *) SELECT * FROM u" "block" "without sandbox verification"

echo ""
echo "─── Production writes WITH marker: allowed (DML only) ───"
touch "$MARKER"
run_case "allow-insert-with-marker" "$PROD_TOOL" "write" "INSERT INTO accounts (name) VALUES ('Test')" "allow"
run_case "allow-update-with-marker" "$PROD_TOOL" "write" "UPDATE contacts SET name='X' WHERE id='abc'" "allow"
run_case "allow-delete-with-marker" "$PROD_TOOL" "write" "DELETE FROM tasks WHERE id='abc'" "allow"

echo ""
echo "─── DDL is ALWAYS blocked, marker or not ───"
# With marker present — still must block DDL.
touch "$MARKER"
run_case "block-create-table-with-marker" "$PROD_TOOL" "write" "CREATE TABLE foo (id uuid)" "block" "migration files"
run_case "block-alter-table-with-marker" "$PROD_TOOL" "write" "ALTER TABLE accounts ADD COLUMN x text" "block" "migration files"
run_case "block-drop-table-with-marker" "$PROD_TOOL" "write" "DROP TABLE foo" "block" "migration files"
run_case "block-truncate-with-marker" "$PROD_TOOL" "write" "TRUNCATE TABLE audit_log" "block" "migration files"
run_case "block-create-index-with-marker" "$PROD_TOOL" "write" "CREATE INDEX idx_foo ON accounts(name)" "block" "migration files"
run_case "block-create-unique-index-with-marker" "$PROD_TOOL" "write" "CREATE UNIQUE INDEX uq_foo ON accounts(name)" "block" "migration files"
run_case "block-create-function-with-marker" "$PROD_TOOL" "write" "CREATE OR REPLACE FUNCTION foo() RETURNS void AS \$\$ BEGIN END; \$\$ LANGUAGE plpgsql" "block" "migration files"
run_case "block-create-trigger-with-marker" "$PROD_TOOL" "write" "CREATE TRIGGER tr_foo BEFORE INSERT ON accounts FOR EACH ROW EXECUTE FUNCTION foo()" "block" "migration files"
run_case "block-alter-column-with-marker" "$PROD_TOOL" "write" "ALTER TABLE accounts ALTER COLUMN name TYPE text" "block" "migration files"

# Without marker — still blocks DDL (the DDL message wins, since it's checked first).
rm -f "$MARKER"
run_case "block-create-table-no-marker" "$PROD_TOOL" "write" "CREATE TABLE foo (id uuid)" "block" "migration files"
run_case "block-drop-table-no-marker" "$PROD_TOOL" "write" "DROP TABLE foo" "block" "migration files"

echo ""
echo "─── Reads pass through (mode=read or unspecified) ───"
rm -f "$MARKER"
run_case "allow-select-read-mode" "$PROD_TOOL" "read" "SELECT * FROM accounts LIMIT 10" "allow"
run_case "allow-select-empty-mode" "$PROD_TOOL" "" "SELECT * FROM accounts LIMIT 10" "allow"
# A SELECT that mentions DDL keywords as identifiers/values must still pass on read mode.
run_case "allow-select-with-ddl-keyword-text" "$PROD_TOOL" "read" "SELECT 'CREATE TABLE foo' AS note" "allow"

echo ""
echo "─── Sandbox execute_sql is NOT affected ───"
rm -f "$MARKER"
run_case "allow-sandbox-write-no-marker" "$SANDBOX_TOOL" "write" "INSERT INTO accounts (name) VALUES ('Test')" "allow"
run_case "allow-sandbox-ddl-no-marker" "$SANDBOX_TOOL" "write" "CREATE TABLE foo (id uuid)" "allow"
run_case "allow-sandbox-drop-no-marker" "$SANDBOX_TOOL" "write" "DROP TABLE foo" "allow"

echo ""
echo "─── Other tools pass through ───"
run_case "allow-other-mcp-tool" "mcp__af7d85f2-abc__crm_search_accounts" "write" "n/a" "allow"
run_case "allow-bash-tool" "Bash" "" "ls" "allow"

echo ""
echo "─── Fail-open on malformed input ───"
echo "  Testing: allow-invalid-json"
output=$(printf 'this is not json' | bash "$HOOK_SCRIPT" 2>&1) || true
if echo "$output" | grep -q '"permissionDecision":"deny"'; then
  echo "  FAIL: allow-invalid-json — expected allow, got block"
  echo "    output: $output"
  FAILURES=$((FAILURES + 1))
else
  echo "  PASS: allow-invalid-json"
fi

echo "  Testing: allow-empty-tool-name"
payload='{"tool_name":"","tool_input":{}}'
output=$(printf '%s' "$payload" | bash "$HOOK_SCRIPT" 2>&1) || true
if echo "$output" | grep -q '"permissionDecision":"deny"'; then
  echo "  FAIL: allow-empty-tool-name — expected allow, got block"
  echo "    output: $output"
  FAILURES=$((FAILURES + 1))
else
  echo "  PASS: allow-empty-tool-name"
fi

echo ""
echo "─── Marker expiry: yesterday's marker does not unlock today ───"
YESTERDAY=$(date -v-1d +%Y-%m-%d 2>/dev/null || date -d 'yesterday' +%Y-%m-%d)
rm -f "$MARKER"
touch "/tmp/.sandbox-verified-$YESTERDAY"
run_case "block-with-yesterday-marker" "$PROD_TOOL" "write" "UPDATE accounts SET name='X' WHERE id='abc'" "block" "without sandbox verification"
rm -f "/tmp/.sandbox-verified-$YESTERDAY"

echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "All tests passed."
  exit 0
else
  echo "$FAILURES test(s) failed."
  exit 1
fi
