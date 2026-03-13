#!/bin/bash
# Auto-pull td-operations repo every 5 minutes
# Installed as macOS LaunchAgent: com.tonydurante.td-operations-pull

REPO_DIR="$HOME/Desktop/td-operations"
LOG_FILE="$REPO_DIR/.claude/git-auto-pull.log"

# Only keep last 100 lines of log
if [ -f "$LOG_FILE" ] && [ "$(wc -l < "$LOG_FILE")" -gt 100 ]; then
  tail -50 "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
fi

cd "$REPO_DIR" || exit 1

# Skip if there are uncommitted changes (don't overwrite local work)
if ! git diff --quiet HEAD 2>/dev/null; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') SKIP — uncommitted changes detected" >> "$LOG_FILE"
  exit 0
fi

# Pull latest
RESULT=$(git pull --ff-only origin main 2>&1)
STATUS=$?

if echo "$RESULT" | grep -q "Already up to date"; then
  # Silent — don't log "already up to date" to keep log clean
  exit 0
fi

if [ $STATUS -eq 0 ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') PULLED — $RESULT" >> "$LOG_FILE"
else
  echo "$(date '+%Y-%m-%d %H:%M:%S') ERROR — $RESULT" >> "$LOG_FILE"
fi
