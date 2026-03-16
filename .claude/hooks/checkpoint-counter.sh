#!/usr/bin/env bash
set -euo pipefail
INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_name',''))" 2>/dev/null || echo "")
SESSION_ID=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('session_id','default'))" 2>/dev/null || echo "default")
COUNTER_FILE="/tmp/claude-cc-counter-${SESSION_ID}"
if echo "$TOOL_NAME" | grep -qiE "session_checkpoint"; then echo "0" > "$COUNTER_FILE"; exit 0; fi
if echo "$TOOL_NAME" | grep -qiE "execute_sql"; then
  TOOL_INPUT=$(echo "$INPUT" | python3 -c "import sys,json; print(json.dumps(json.load(sys.stdin).get('tool_input',{})))" 2>/dev/null || echo "{}")
  if echo "$TOOL_INPUT" | grep -qiE "dev_tasks.*(INSERT|UPDATE)" || echo "$TOOL_INPUT" | grep -qiE "(INSERT|UPDATE).*dev_tasks"; then echo "0" > "$COUNTER_FILE"; exit 0; fi
fi
COUNT=0
if [ -f "$COUNTER_FILE" ]; then COUNT=$(cat "$COUNTER_FILE" 2>/dev/null || echo "0"); if ! [[ "$COUNT" =~ ^[0-9]+$ ]]; then COUNT=0; fi; fi
COUNT=$((COUNT + 1))
echo "$COUNT" > "$COUNTER_FILE"

# Every 50 tool calls, check if remote has new commits (multi-machine safety)
if [ $((COUNT % 50)) -eq 0 ]; then
  AHEAD=$(git fetch origin main --quiet 2>/dev/null && git rev-list HEAD..origin/main --count 2>/dev/null || echo "0")
  if [ "$AHEAD" != "0" ] && [ -n "$AHEAD" ]; then
    echo "⚠️ Remote is ${AHEAD} commit(s) ahead. Another machine pushed changes. Pull before committing: git pull --rebase origin main"
  fi
fi

if [ "$COUNT" -ge 15 ]; then echo "🔴 URGENT: ${COUNT} tool calls without checkpoint! You MUST save now. Call session_checkpoint({summary: \"what you did\", next_steps: \"what's pending\"})."
elif [ "$COUNT" -ge 10 ]; then echo "🟠 WARNING: ${COUNT} tool calls since last checkpoint. Save your progress now with session_checkpoint({summary: \"what you did\", next_steps: \"what's pending\"})."
elif [ "$COUNT" -ge 5 ]; then echo "🟡 Reminder: ${COUNT} tool calls since last checkpoint. Consider saving with session_checkpoint."
fi
exit 0
