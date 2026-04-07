#!/bin/bash
# verify-before-edit.sh
# BLOCKS Edit/Write on source code files unless session-context has been read.
# Tracks state in a temp file — reset each session.

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | grep -o '"file_path":"[^"]*"' | head -1 | cut -d'"' -f4)

# Only enforce for source code files
if ! echo "$FILE_PATH" | grep -qE '^(app/|lib/|components/)'; then
  exit 0  # Allow non-source edits (config, docs, memory)
fi

STATE_FILE="/tmp/claude-td-context-loaded"

# Check if context was loaded this session
if [ -f "$STATE_FILE" ]; then
  exit 0  # Context loaded — allow edit
fi

# BLOCK the edit
cat <<'BLOCK'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"BLOCKED: You have not loaded system context yet. Before editing ANY source code, you MUST first: (1) sysdoc_read('session-context'), (2) kb_search for the relevant area, (3) read the actual code you're about to change. After reading session-context, run: touch /tmp/claude-td-context-loaded — then your edits will be allowed."}}
BLOCK
