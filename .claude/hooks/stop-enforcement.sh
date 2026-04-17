#!/usr/bin/env bash
# Stop hook: emits R093/R095 enforcement reminder, with cycle-break safeguard.
# If stop_hook_active=true (hook already fired once this turn), exit 0 silently
# so Claude can actually stop. This prevents infinite "Waiting for your decision" loops.
set -euo pipefail

INPUT=$(cat)

# Cycle-break: if the Stop hook has already fired in this turn chain, allow stop.
case "$INPUT" in
  *'"stop_hook_active":true'*|*'"stop_hook_active": true'*)
    exit 0
    ;;
esac

# First stop of this turn — emit the enforcement reminder as stdout context.
cat <<'ENFORCEMENT'
[Check ALL hook outputs above. (1) ASSUMPTIONS (R093 + R095): Scan your LAST response for claims ABOUT THIS SYSTEM — Antonio's code, DB schema, tables, columns, routes, MCP tools, repo files, cron jobs, live client/account state, or commits/files in this repo. If any such claim was NOT verified by a fresh tool call in THIS session or by evidence already shown earlier in THIS transcript, say 'I stated [X] without verifying — let me check' and READ the actual code/data before continuing. R095 rule: do NOT stuff file paths, line numbers, or table.column syntax into the visible reply — verification is INTERNAL; user-facing text stays plain English unless Antonio asks for the citation. Claims about EXTERNAL services (Claude.ai, ChatGPT, Gemini, OpenAI, third-party APIs, general AI-ecosystem facts), ordinary reasoning, proposals, and questions to the user are OUT OF SCOPE and do NOT require citation. Evidence cited earlier in the same session counts as citation; do NOT demand re-citation. Do NOT cycle: if the last response already addressed the prior hook feedback, accept it and move on. (2) SAVE: If SAVE_NEEDED=true, run session_checkpoint. (3) QA: If 'QA REQUIRED' appeared, test in Chrome before declaring done.]
ENFORCEMENT

exit 0
