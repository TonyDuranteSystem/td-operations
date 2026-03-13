#!/bin/bash
# Auto-pull td-operations repo every 5 minutes
# Installed as macOS LaunchAgent: com.tonydurante.td-operations-pull
# Portable: uses script location to find repo root

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$REPO_DIR" || exit 0

# Skip if there are uncommitted changes (don't overwrite local work)
if ! /usr/bin/git diff --quiet HEAD 2>/dev/null; then
  exit 0
fi

# Pull latest
/usr/bin/git pull --ff-only origin main >/dev/null 2>&1
exit 0
