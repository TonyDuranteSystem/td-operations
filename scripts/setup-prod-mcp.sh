#!/usr/bin/env bash
#
# setup-prod-mcp.sh — register the PRODUCTION MCP connection for Claude Code,
# consistently across machines, without ever putting the key in git.
#
# WHY: the sandbox MCP (`td-ops-sandbox`) is generated into the repo's .mcp.json
# by dev-setup.sh, so it loads in every session. The PRODUCTION MCP is NOT in the
# repo (by design — keeps dev sessions sandbox-only). It must be registered once
# per machine at USER scope. If it's missing, Claude Code can't promote migrations
# to production or persist session_checkpoint / dev_tasks (R096) from that machine.
#
# This registers `td-ops-production` at USER scope (available to all Claude Code
# sessions on this machine; the key lives in ~/.claude.json, never in the repo).
# The existing production-write-guard.sh hook still gates every prod write, so the
# sandbox-first safety model is unchanged — this only restores the second
# connection R096 assumes exists.
#
# USAGE:
#   export TD_PROD_MCP_KEY='<the production /api/mcp bearer key>'
#   bash scripts/setup-prod-mcp.sh
#
# Get the key from your password manager, or copy it from a machine where
# production already works:
#   claude mcp get td-ops-production        # on the working machine, shows the header
# NEVER paste the key into chat or commit it.

set -euo pipefail

SERVER_NAME="td-ops-production"
PROD_MCP_URL="${TD_PROD_MCP_URL:-https://td-operations.vercel.app/api/mcp}"

if [ -z "${TD_PROD_MCP_KEY:-}" ]; then
  cat >&2 <<'MSG'
❌ TD_PROD_MCP_KEY is not set.

Set it first (do NOT hardcode it / commit it), then re-run:

  export TD_PROD_MCP_KEY='<production /api/mcp bearer key>'
  bash scripts/setup-prod-mcp.sh

The key is the Authorization bearer for the production MCP endpoint
(parallel to the sandbox key in .mcp.json). Pull it from your password
manager or from a machine where production MCP already works:

  claude mcp get td-ops-production
MSG
  exit 1
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "❌ 'claude' CLI not found on PATH. Install Claude Code first." >&2
  exit 1
fi

echo "→ Registering '$SERVER_NAME' at USER scope ($PROD_MCP_URL)…"

# Idempotent: drop any existing user-scoped registration, then add fresh.
# (Ignore errors when it doesn't exist yet.)
claude mcp remove -s user "$SERVER_NAME" >/dev/null 2>&1 || true

# Note: the key is passed via the header arg only — never echoed. Do not add
# `set -x` to this script, and do not log $TD_PROD_MCP_KEY.
claude mcp add -s user -t http "$SERVER_NAME" "$PROD_MCP_URL" \
  -H "Authorization: Bearer ${TD_PROD_MCP_KEY}" >/dev/null

# Verify presence WITHOUT printing the key.
if claude mcp list 2>/dev/null | grep -q "^${SERVER_NAME}:"; then
  echo "✅ '$SERVER_NAME' registered at user scope."
  echo "   Restart your Claude Code session so the new connection loads."
  echo "   Reminder: production writes are still gated by production-write-guard.sh."
else
  echo "⚠️  Added, but '$SERVER_NAME' did not show up in 'claude mcp list'." >&2
  echo "   Run 'claude mcp list' to check health/auth." >&2
  exit 1
fi
