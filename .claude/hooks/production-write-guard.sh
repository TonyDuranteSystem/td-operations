#!/bin/bash
# production-write-guard.sh
# PreToolUse hook — fires before any MCP execute_sql call. Allows the sandbox
# connection (mcp__td-ops-sandbox__execute_sql) and gates EVERY other
# connection'"'"'s execute_sql as production (af7d85f2 OAuth connector,
# td-ops-prod, td-ops-production, and any future production connection name).
#
# Two layers of protection, in order:
#
#   1. DDL is ALWAYS blocked. Any CREATE / ALTER / DROP / TRUNCATE on
#      TABLE / INDEX / FUNCTION / TRIGGER / VIEW / SEQUENCE / TYPE / etc.
#      is rejected, even with a "migration:<file>" reason. R105 requires
#      schema changes to land in scripts/migrations/*.sql and be applied
#      to sandbox before any production promotion.
#
#   2. DML writes (mode='write') require today's sandbox-verified marker:
#         /tmp/.sandbox-verified-YYYY-MM-DD
#      The marker is created after sandbox testing has been performed for
#      the change. It expires at midnight; the next calendar day forces
#      sandbox-first verification again.
#
# Reads (mode='read' or unspecified) pass through unaffected.
#
# Sandbox execute_sql (mcp__td-ops-sandbox__execute_sql) is NOT affected —
# the script allowlists the sandbox connection explicitly and gates all
# other (i.e. production) connections by default.
#
# How to create the marker after sandbox verification:
#   touch /tmp/.sandbox-verified-$(date +%Y-%m-%d)
#
# Why this hook exists:
#   The hardcoded production Supabase ref check in lib/supabase-admin.ts
#   does not apply to MCP tools (R096) — every execute_sql call against
#   the production tool name hits production data directly, with no
#   sandbox stop. This hook is a mechanical brake.

INPUT=$(cat)

# Fail-open on parse failure — a broken hook must not block legitimate work.
DECISION=$(printf '%s' "$INPUT" | python3 -c '
import sys, json, re, os, datetime

try:
    d = json.load(sys.stdin)
except Exception:
    print("ALLOW")
    sys.exit(0)

tool_name = d.get("tool_name", "") or ""
if not tool_name:
    print("ALLOW")
    sys.exit(0)

# Only act on MCP execute_sql tools (belt-and-suspenders if the settings
# matcher is ever narrowed or changed).
if not re.match(r"^mcp__.*__execute_sql$", tool_name):
    print("ALLOW")
    sys.exit(0)

# Sandbox execute_sql is intentionally UNGUARDED — dev work needs free writes.
# EVERY other connection'"'"'s execute_sql is treated as production and gated
# below, so any current OR future production connection name is covered by
# default (af7d85f2 OAuth connector, td-ops-prod, td-ops-production, …).
# This fail-safe default is the fix for the old af7d85f2-only gap, where a
# hand-added production connection with a new name slipped past the brake.
if re.match(r"^mcp__td-ops-sandbox__execute_sql$", tool_name):
    print("ALLOW")
    sys.exit(0)

tool_input = d.get("tool_input", {}) or {}
mode = tool_input.get("mode", "") or ""
query = tool_input.get("query", "") or ""

# Reads pass through. execute_sql defaults to mode="read" server-side, so
# omitted mode is treated as read here too.
if mode != "write":
    print("ALLOW")
    sys.exit(0)

# DDL is ALWAYS blocked. Match the verbs followed by any common DDL object.
ddl_pattern = (
    r"\b(CREATE|ALTER|DROP|TRUNCATE)\s+"
    r"(OR\s+REPLACE\s+)?"
    r"(UNIQUE\s+)?"
    r"(MATERIALIZED\s+)?"
    r"(TABLE|FUNCTION|PROCEDURE|TRIGGER|VIEW|SEQUENCE|TYPE|EXTENSION|"
    r"INDEX|SCHEMA|DATABASE|ROLE|POLICY|CONSTRAINT|COLUMN)\b"
)
if re.search(ddl_pattern, query, re.IGNORECASE):
    print("DDL_BLOCK")
    sys.exit(0)

# DML write — require today is sandbox-verified.
today = datetime.date.today().isoformat()
marker = f"/tmp/.sandbox-verified-{today}"
if os.path.isfile(marker):
    print("ALLOW")
    sys.exit(0)

print("WRITE_BLOCK")
' 2>/dev/null || echo "ALLOW")

case "$DECISION" in
  ALLOW)
    exit 0
    ;;
  DDL_BLOCK)
    cat <<'BLOCK'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"⛔ BLOCKED: DDL must go through migration files (R105). Schema changes (CREATE/ALTER/DROP/TRUNCATE on TABLE/INDEX/FUNCTION/TRIGGER/VIEW/SEQUENCE/TYPE/etc.) cannot be applied directly via execute_sql. Pattern: write SQL to scripts/migrations/YYYYMMDD-HHMM-description.sql → apply to sandbox via `node scripts/apply-migration.js <file>` → get Antonio's explicit approval before any production promotion."}}
BLOCK
    exit 0
    ;;
  WRITE_BLOCK)
    cat <<'BLOCK'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"⛔ BLOCKED: Production write attempted without sandbox verification. Run sandbox tests first, then create the marker with: touch /tmp/.sandbox-verified-$(date +%Y-%m-%d)"}}
BLOCK
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
