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
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib-local-stacks.sh
. "$SCRIPT_DIR/lib-local-stacks.sh"

WORKTREE="$(pwd)"
PURGE=0
ARGS=()
for a in "$@"; do [ "$a" = "--purge" ] && PURGE=1 || ARGS+=("$a"); done
# Same derivation as env-up (see stack_name_for_worktree) — if these two ever
# disagree, a session tears down a DIFFERENT stack than the one it provisioned.
NAME="${ARGS[0]:-$(stack_name_for_worktree "$WORKTREE")}"
STACK_DIR="$STACKS_ROOT/$NAME"

# ---- stop the stack --------------------------------------------------------
if [ -d "$STACK_DIR" ]; then
  echo "▶ stopping local stack '$NAME'…"
  if [ "$PURGE" = 1 ]; then
    # ORDER MATTERS. The old code stopped with its failure swallowed and then
    # deleted the directory regardless — so a stop that silently did nothing
    # left containers running with their config destroyed, i.e. unmanageable
    # and unreclaimable forever (incident 2026-07-18, three stacks, ~3 GB).
    # Now: stop, VERIFY, and only then delete.
    if stack_force_stop "$NAME" "$STACK_DIR"; then
      stack_remove_dir_if_stopped "$NAME" "$STACK_DIR" \
        && echo "   purged stack dir + volumes, slot freed"
    else
      echo "   ⚠️  could not confirm the containers stopped — KEEPING the stack" >&2
      echo "      directory so this stack stays reclaimable. Check Docker/Colima" >&2
      echo "      is running and re-run, or: bash scripts/worktree-stack-sweep.sh" >&2
      exit 1
    fi
  else
    ( cd "$STACK_DIR" && supabase stop >/dev/null 2>&1 || true )
    if [ "$(stack_running_count "$NAME")" -gt 0 ]; then
      echo "   ⚠️  some containers are still running — run again, or use --purge" >&2
    else
      echo "   stopped (data kept; re-up is fast). Use --purge to reclaim disk."
    fi
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
