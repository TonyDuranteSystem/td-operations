#!/bin/bash
# send-guard.sh
# PreToolUse hook — fires before MCP calls to client-facing send tools.
#
# Blocks these tools unconditionally unless approval is signalled:
#   portal_chat_send      — message to client portal chat
#   gmail_send            — email to anyone (incl. clients)
#   gmail_draft           — gmail draft (still creates client-visible content)
#   offer_send            — offer link to client
#   lease_send            — lease link to client
#   oa_send               — operating-agreement link to client
#   portal_team_send      — portal team message
#   msg_send              — generic message tool
#   portal_invoice_send   — invoice email to client
#
# Why this hook exists:
#   Claude has previously called send tools when Antonio said "draft a response,"
#   sending unapproved content to clients. This hook is a mechanical brake:
#   when Claude attempts a send, it must STOP and get explicit chat approval
#   ("send it", "ok send", "vai", "manda") BEFORE the tool can run.
#
# Approval signals (either works):
#   1) One-shot sentinel file (preferred — Claude-controlled, single-use):
#        touch /tmp/claude-allow-client-send
#      The hook deletes the file when it runs, so the override is consumed
#      after exactly one send. Antonio's approval gives Claude permission to
#      touch the file; the file gives the hook permission to allow the call.
#
#   2) Process env var (operator escape hatch, persists for the session):
#        ALLOW_CLIENT_SEND=1
#      Useful for batch operations where Antonio has approved a sequence.

INPUT=$(cat)

# Fail-open on parse failure — a broken hook should not block legit work.
TOOL_NAME=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_name',''))" 2>/dev/null || echo "")

if [ -z "$TOOL_NAME" ]; then
  exit 0
fi

# Match MCP send tools across both transports (sandbox + production):
#   mcp__td-ops-sandbox__<tool>
#   mcp__af7d85f2-<uuid>__<tool>
SEND_TOOLS_PATTERN='__(portal_chat_send|gmail_send|gmail_draft|offer_send|lease_send|oa_send|portal_team_send|msg_send|portal_invoice_send)$'

if ! echo "$TOOL_NAME" | grep -qE "$SEND_TOOLS_PATTERN"; then
  exit 0
fi

# It IS a send tool. Check for approval signals.
SENTINEL="/tmp/claude-allow-client-send"

if [ -f "$SENTINEL" ]; then
  rm -f "$SENTINEL"  # one-shot consumption
  exit 0
fi

if [ "${ALLOW_CLIENT_SEND}" = "1" ]; then
  exit 0
fi

# BLOCK
cat <<'BLOCK'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"⛔ SEND GUARD: This tool sends content to a client. You MUST show Antonio the draft and get explicit approval ('send it', 'ok send', 'vai', 'manda') before calling this tool. If you haven't received approval, do NOT proceed — present the draft to Antonio and wait. AFTER Antonio explicitly approves in chat, signal it by running: Bash: touch /tmp/claude-allow-client-send  — then immediately retry the send tool. The approval is single-use: the file is consumed on the next send call. Do not touch the sentinel file before you have approval in chat."}}
BLOCK
exit 0
