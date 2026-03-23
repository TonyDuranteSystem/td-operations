#!/bin/bash
# ─────────────────────────────────────────────────────────────
# Migrate td-operations from ~/Desktop to ~/Developer
# Fixes iCloud Desktop sync corrupting .git/ files
#
# Run from OUTSIDE the repo:
#   bash ~/Desktop/td-operations/scripts/migrate-to-developer.sh
#
# Safe to run multiple times — skips steps already done.
# Works on all 3 machines (iMac, MacBook, Mac Mini).
# ─────────────────────────────────────────────────────────────

set -e

USER_HOME="$HOME"
OLD_PATH="$USER_HOME/Desktop/td-operations"
NEW_PATH="$USER_HOME/Developer/td-operations"
PLIST="$USER_HOME/Library/LaunchAgents/com.tonydurante.td-operations-pull.plist"

echo ""
echo "═══════════════════════════════════════════════════"
echo "  TD Operations — Migrate to ~/Developer"
echo "  Machine: $(hostname)"
echo "  User: $(whoami)"
echo "═══════════════════════════════════════════════════"
echo ""

# ── Step 0: Pre-checks ──
if [ -d "$NEW_PATH" ]; then
  echo "✅ ~/Developer/td-operations already exists. Migration already done."
  echo "   If you want to re-run, delete ~/Developer/td-operations first."
  exit 0
fi

if [ ! -d "$OLD_PATH" ]; then
  echo "❌ ~/Desktop/td-operations not found. Nothing to migrate."
  exit 1
fi

# ── Step 1: Clean iCloud duplicate files ──
echo "🧹 Step 1: Cleaning iCloud duplicate files (\" 2\" copies)..."
COUNT=$(find "$OLD_PATH" -name "* 2" -o -name "* 2.*" 2>/dev/null | wc -l | tr -d ' ')
if [ "$COUNT" -gt 0 ]; then
  find "$OLD_PATH" -name "* 2" -print0 2>/dev/null | xargs -0 rm -rf
  find "$OLD_PATH" -name "* 2.*" -print0 2>/dev/null | xargs -0 rm -rf
  echo "   Deleted $COUNT duplicate files/folders"
else
  echo "   No duplicates found — clean"
fi

# ── Step 2: Verify git is healthy ──
echo "🔍 Step 2: Verifying git health..."
cd "$OLD_PATH"
if git status >/dev/null 2>&1; then
  echo "   Git OK — $(git log --oneline -1)"
else
  echo "❌ Git is broken. Try: cd $OLD_PATH && git fsck"
  exit 1
fi

# ── Step 3: Create ~/Developer and move ──
echo "📦 Step 3: Moving repo to ~/Developer/td-operations..."
mkdir -p "$USER_HOME/Developer"
mv "$OLD_PATH" "$NEW_PATH"
echo "   Moved successfully"

# ── Step 4: Update LaunchAgent ──
echo "⚙️  Step 4: Updating LaunchAgent..."
if [ -f "$PLIST" ]; then
  # Unload first
  launchctl unload "$PLIST" 2>/dev/null || true

  # Update path in plist
  sed -i '' "s|$USER_HOME/Desktop/td-operations|$USER_HOME/Developer/td-operations|g" "$PLIST"

  # Reload
  launchctl load "$PLIST" 2>/dev/null || true
  echo "   LaunchAgent updated and reloaded"
else
  echo "   No LaunchAgent found — skipping (install later if needed)"
fi

# ── Step 5: Copy Claude Code memory ──
echo "🧠 Step 5: Migrating Claude Code memory..."
# Claude Code stores per-project memory keyed by path with / replaced by -
OLD_CLAUDE_KEY="-$(echo "${OLD_PATH#/}" | tr '/' '-')"
NEW_CLAUDE_KEY="-$(echo "${NEW_PATH#/}" | tr '/' '-')"
OLD_CLAUDE_DIR="$USER_HOME/.claude/projects/$OLD_CLAUDE_KEY"
NEW_CLAUDE_DIR="$USER_HOME/.claude/projects/$NEW_CLAUDE_KEY"

if [ -d "$OLD_CLAUDE_DIR" ]; then
  mkdir -p "$NEW_CLAUDE_DIR"
  # Copy memory and settings (don't move — keep old as backup)
  if [ -d "$OLD_CLAUDE_DIR/memory" ]; then
    cp -r "$OLD_CLAUDE_DIR/memory" "$NEW_CLAUDE_DIR/memory"
    echo "   Memory files copied"
  fi
  # Copy settings.json if exists
  if [ -f "$OLD_CLAUDE_DIR/settings.json" ]; then
    cp "$OLD_CLAUDE_DIR/settings.json" "$NEW_CLAUDE_DIR/settings.json"
    echo "   Project settings copied"
  fi
  # Copy settings.local.json if exists
  if [ -f "$OLD_CLAUDE_DIR/settings.local.json" ]; then
    cp "$OLD_CLAUDE_DIR/settings.local.json" "$NEW_CLAUDE_DIR/settings.local.json"
    echo "   Local settings copied"
  fi
  echo "   Old Claude project folder kept as backup at: $OLD_CLAUDE_DIR"
else
  echo "   No existing Claude project folder found — fresh start"
fi

# ── Step 6: Verify ──
echo ""
echo "🔍 Step 6: Verifying..."
cd "$NEW_PATH"
if git status >/dev/null 2>&1; then
  echo "   ✅ Git works at new location"
else
  echo "   ❌ Git broken at new location!"
  exit 1
fi

if git pull --ff-only origin main >/dev/null 2>&1; then
  echo "   ✅ Git pull works"
else
  echo "   ⚠️  Git pull had issues (may need manual check)"
fi

echo ""
echo "═══════════════════════════════════════════════════"
echo "  ✅ MIGRATION COMPLETE"
echo ""
echo "  New location: ~/Developer/td-operations"
echo ""
echo "  Next steps:"
echo "  1. Open Terminal and run:"
echo "     cd ~/Developer/td-operations && claude"
echo ""
echo "  2. The old ~/Desktop/td-operations is GONE"
echo "     (iCloud may show a ghost — ignore it)"
echo ""
echo "  3. Run this same script on your other machines"
echo "═══════════════════════════════════════════════════"
echo ""
