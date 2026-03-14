#!/bin/bash
# Auto-pull td-operations repo every 5 minutes
# Installed as macOS LaunchAgent: com.tonydurante.td-operations-pull
# Portable: uses script location to find repo root
# Enhanced: auto-runs npm ci when package-lock.json changes

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$REPO_DIR" || exit 0

# Check for uncommitted changes
if ! /usr/bin/git diff --quiet HEAD 2>/dev/null; then
  # Notify user about uncommitted changes (macOS notification)
  DIRTY_FILES=$(/usr/bin/git diff --name-only HEAD 2>/dev/null | wc -l | tr -d ' ')
  osascript -e "display notification \"${DIRTY_FILES} file non committati in td-operations. Ricorda di committare prima di cambiare macchina.\" with title \"TD Operations\" sound name \"Submarine\"" 2>/dev/null
  exit 0
fi

# Snapshot package-lock hash BEFORE pull
LOCK_BEFORE=""
if [ -f package-lock.json ]; then
  LOCK_BEFORE=$(md5 -q package-lock.json 2>/dev/null)
fi

# Pull latest
/usr/bin/git pull --ff-only origin main >/dev/null 2>&1
PULL_EXIT=$?

# If pull succeeded and package-lock.json changed, run npm ci
if [ $PULL_EXIT -eq 0 ] && [ -f package-lock.json ]; then
  LOCK_AFTER=$(md5 -q package-lock.json 2>/dev/null)
  if [ "$LOCK_BEFORE" != "$LOCK_AFTER" ] && [ -n "$LOCK_AFTER" ]; then
    # Find npm via nvm or direct path
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" 2>/dev/null
    npm ci --silent >/dev/null 2>&1
  fi
fi

exit 0
