#!/usr/bin/env bash
# SessionStart hook: git pull + npm ci if package-lock.json changed
# Ensures every session starts with up-to-date code and dependencies
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_DIR"

# Reset context-loaded flag — forces Claude to read session-context before editing code
rm -f /tmp/claude-td-context-loaded

# ── Is this a linked worktree on a feature branch? ────────────────────────
# If so, DO NOT stash and DO NOT pull main. (Antonio approved 2026-08-10, after four
# occurrences on one job. Rationale in dev job fddbf2d5.)
#
# Both halves of the old behaviour are right in the main checkout on main, and wrong here:
#   - the stash silently removes in-flight work from the tree, and recovery depends on the
#     session noticing a single line in a very long start-up output. The fourth occurrence
#     hid a file that an ALREADY-COMMITTED change depended on, so that commit would not have
#     built from a clean checkout and only looked healthy because the working copy still held
#     the missing piece. A silent tidy-up can make finished work retroactively broken.
#   - pulling main INTO a feature branch is a merge decision, not housekeeping.
#
# R070 ("pull before any work") continues to govern the MAIN checkout, which is unchanged.
GIT_DIR_SELF=$(git rev-parse --git-dir 2>/dev/null || echo "")
GIT_DIR_SHARED=$(git rev-parse --git-common-dir 2>/dev/null || echo "")
CURRENT_BRANCH=$(git branch --show-current 2>/dev/null || echo "")

if [ -n "$GIT_DIR_SELF" ] && [ "$GIT_DIR_SELF" != "$GIT_DIR_SHARED" ] && [ "$CURRENT_BRANCH" != "main" ]; then
  echo "ℹ️  Worktree on '$CURRENT_BRANCH' — not stashing, not pulling main (R070 governs the main checkout)."
else
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
fi

# ── Any auto-stash still sitting there is somebody's lost work ────────────
# Belt and braces alongside the guard above: an older stash from before this fix, or one from
# the main checkout, must not sit unnoticed. Reported, never popped automatically — popping
# can conflict, and a hook is the worst place to resolve that.
# Only TODAY'S. The stash list is repo-wide and holds years of them (67 at the time of
# writing); a warning that fires every session is one nobody reads. Work stashed today is the
# work plausibly still needed — older entries are archaeology, not a live problem.
TODAY=$(date +%Y-%m-%d)
FRESH_STASH=$(git stash list --date=short --format='%ad %gs' 2>/dev/null \
  | grep "auto-stash before session pull" | grep -c "^$TODAY" || true)
if [ "${FRESH_STASH:-0}" -gt 0 ]; then
  echo "⚠️  $FRESH_STASH auto-stash(es) from TODAY are still held — that is probably your work."
  echo "   Inspect BEFORE working:  git stash list --date=short | head -3   then  git stash pop"
fi

# Auto-generate .mcp.json if missing (sandbox MCP connection for Claude Code)
if [ ! -f ".mcp.json" ] && [ -f ".env.local" ]; then
  SANDBOX_MCP_KEY=$(grep 'TD_MCP_API_KEY' .env.local | head -1 | sed 's/TD_MCP_API_KEY="\(.*\)"/\1/')
  if [ -n "$SANDBOX_MCP_KEY" ]; then
    cat > .mcp.json << EOF
{
  "mcpServers": {
    "td-ops-sandbox": {
      "type": "http",
      "url": "https://td-operations-sandbox.vercel.app/api/mcp",
      "headers": {
        "Authorization": "Bearer ${SANDBOX_MCP_KEY}"
      }
    }
  }
}
EOF
    echo "📋 Generated .mcp.json (sandbox MCP connection)"
  fi
fi

# ── Environment state declaration ─────────────────────────────────────────
# Printed every session start so Claude and Antonio always know which
# environment this machine is in before any work begins.
VERCEL_PROJECT=$(python3 -c "import json; print(json.load(open('.vercel/project.json')).get('projectName','UNKNOWN'))" 2>/dev/null || echo "UNKNOWN")
SUPABASE_URL=$(grep 'NEXT_PUBLIC_SUPABASE_URL' .env.local 2>/dev/null | head -1 | sed 's/.*"\(.*\)".*/\1/' || echo "MISSING")
SUPABASE_REF=$(echo "$SUPABASE_URL" | sed 's|https://\([^.]*\)\.supabase\.co|\1|')
BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")

echo ""
if [ "$VERCEL_PROJECT" = "td-operations-sandbox" ] && echo "$SUPABASE_URL" | grep -q "xjcxlmlpeywtwkhstjlw"; then
  echo "✅ Environment: SANDBOX"
else
  echo "⛔ WARNING: Environment is NOT sandbox"
fi
echo "   Vercel project : $VERCEL_PROJECT"
echo "   Supabase ref   : $SUPABASE_REF"
echo "   Branch         : $BRANCH"
if [ "$VERCEL_PROJECT" != "td-operations-sandbox" ] || ! echo "$SUPABASE_URL" | grep -q "xjcxlmlpeywtwkhstjlw"; then
  echo ""
  echo "   Run: bash scripts/dev-setup.sh — to reset to sandbox"
fi
echo ""

exit 0
