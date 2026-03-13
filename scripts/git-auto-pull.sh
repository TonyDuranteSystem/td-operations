#!/bin/bash
# Auto-pull td-operations repo every 5 minutes
# Installed as macOS LaunchAgent: com.tonydurante.td-operations-pull
# Portable: uses script location to find repo root
# Enhanced: auto-runs npm ci when package-lock.json changes

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$REPO_DIR" || exit 0

# Skip if there are uncommitted changes (don't overwrite local work)
if ! /usr/bin/git diff --quiet HEAD 2>/dev/null; then
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
