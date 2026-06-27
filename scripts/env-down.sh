#!/usr/bin/env bash
# env-down.sh — revert THIS worktree from its isolated local env back to the shared sandbox.
#
#   bash scripts/env-down.sh [name] [--purge]
#
#   (no flag) stop the local stack, restore the sandbox .env.local + .mcp.json.
#   --purge   also delete the stack's data volume + config (reclaims disk, frees the slot).
#
# After it finishes: RESTART your Claude session so it reloads the sandbox .mcp.json.
set -euo pipefail

WORKTREE="$(pwd)"
PURGE=0
ARGS=()
for a in "$@"; do [ "$a" = "--purge" ] && PURGE=1 || ARGS+=("$a"); done
NAME="${ARGS[0]:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null | tr '/' '-' )}"
STACK_DIR="$HOME/.td-local-stacks/$NAME"

# ---- stop the stack --------------------------------------------------------
if [ -d "$STACK_DIR/supabase" ]; then
  echo "▶ stopping local stack '$NAME'…"
  if [ "$PURGE" = 1 ]; then
    ( cd "$STACK_DIR" && supabase stop --no-backup >/dev/null 2>&1 || true )
    rm -rf "$STACK_DIR"
    echo "   purged stack dir + volume, slot freed"
  else
    ( cd "$STACK_DIR" && supabase stop >/dev/null 2>&1 || true )
    echo "   stopped (data kept; re-up is fast). Use --purge to reclaim disk."
  fi
else
  echo "  (no stack dir for '$NAME' — nothing to stop)"
fi

# ---- restore the sandbox env files -----------------------------------------
if [ -f "$WORKTREE/.env.sandbox.local" ]; then
  cp "$WORKTREE/.env.sandbox.local" "$WORKTREE/.env.local"
  echo "✓ .env.local restored to shared sandbox"
else
  echo "⚠️  no .env.sandbox.local backup found — .env.local left as-is"
fi
if [ -f "$WORKTREE/.mcp.json.sandbox" ]; then
  cp "$WORKTREE/.mcp.json.sandbox" "$WORKTREE/.mcp.json"
  echo "✓ .mcp.json restored to shared sandbox"
fi

echo ""
echo "✅ reverted to shared sandbox."
echo "⚠️  RESTART your Claude session so it reloads the sandbox .mcp.json (MCP → cloud sandbox)."
