#!/usr/bin/env bash
# SessionStart hook: git pull + npm ci if package-lock.json changed
# Ensures every session starts with up-to-date code and dependencies
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_DIR"

# Check for uncommitted changes
if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
  echo "⚠️ UNCOMMITTED CHANGES detected on this machine. Stashing before pull."
  git stash --include-untracked -m "auto-stash before session pull $(date +%Y%m%d-%H%M%S)" 2>/dev/null
  STASHED=true
else
  STASHED=false
fi

# Record lock file hash before pull
LOCK_HASH_BEFORE=""
if [ -f package-lock.json ]; then
  LOCK_HASH_BEFORE=$(shasum package-lock.json | cut -d' ' -f1)
fi

# Pull latest
PULL_OUTPUT=$(git pull origin main 2>&1) || {
  echo "❌ Git pull failed: $PULL_OUTPUT"
  echo "⚠️ STOP — resolve manually before proceeding."
  exit 0
}

echo "✅ Git: $( echo "$PULL_OUTPUT" | grep -E 'Already up to date|Updating|Fast-forward' | head -1 || echo 'pulled')"

# Check if package-lock.json changed
LOCK_HASH_AFTER=""
if [ -f package-lock.json ]; then
  LOCK_HASH_AFTER=$(shasum package-lock.json | cut -d' ' -f1)
fi

if [ "$LOCK_HASH_BEFORE" != "$LOCK_HASH_AFTER" ] && [ -n "$LOCK_HASH_AFTER" ]; then
  echo "📦 package-lock.json changed — running npm ci..."
  npm ci --silent 2>/dev/null || echo "⚠️ npm ci failed — run manually"
fi

# Report stash
if [ "$STASHED" = true ]; then
  echo "⚠️ Had to stash local changes. Run 'git stash pop' if you need them back."
fi

exit 0
