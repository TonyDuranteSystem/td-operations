#!/usr/bin/env bash
# Stop hook: checks if there are unsaved changes and provides context to Claude
# Outputs concrete data so the prompt hook knows WHAT to save
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

# Get tool call count
COUNTER_FILE=$(ls /tmp/claude-cc-counter-* 2>/dev/null | head -1)
TOOL_COUNT=0
if [ -n "$COUNTER_FILE" ] && [ -f "$COUNTER_FILE" ]; then
  TOOL_COUNT=$(cat "$COUNTER_FILE" 2>/dev/null || echo "0")
fi

# Check git for uncommitted changes
DIRTY_FILES=""
RECENT_COMMITS=""
if [ -d "$REPO_DIR/.git" ]; then
  DIRTY_FILES=$(cd "$REPO_DIR" && git status --short 2>/dev/null || echo "")
  RECENT_COMMITS=$(cd "$REPO_DIR" && git log --oneline -3 --since="1 hour ago" 2>/dev/null || echo "")
fi

# Determine urgency
HAS_CHANGES=false
if [ -n "$DIRTY_FILES" ] || [ -n "$RECENT_COMMITS" ] || [ "$TOOL_COUNT" -ge 3 ]; then
  HAS_CHANGES=true
fi

if [ "$HAS_CHANGES" = true ]; then
  echo "📊 SESSION STATE:"
  echo "  Tool calls since last save: ${TOOL_COUNT}"
  if [ -n "$RECENT_COMMITS" ]; then
    echo "  Recent commits (last hour): ${RECENT_COMMITS}"
  fi
  if [ -n "$DIRTY_FILES" ]; then
    echo "  Uncommitted changes: ${DIRTY_FILES}"
  fi
  echo "---"
  echo "SAVE_NEEDED=true"
else
  echo "SAVE_NEEDED=false"
fi

exit 0
