#!/usr/bin/env bash
# worktree-auto-isolate.sh — ensure a Claude Code worktree has its own isolated local DB.
#
# Designed to be called from a SessionStart hook (the reliable trigger for Desktop
# auto-worktrees). FAIL-SOFT by design: any problem → log + exit 0, so it NEVER blocks
# a session. A worktree that can't be isolated just keeps using the shared sandbox.
#
#   bash scripts/worktree-auto-isolate.sh [worktree_path]   (defaults to $PWD)
#
# Behavior:
#   - Only acts on a LINKED worktree (not the main checkout).
#   - Idempotent: if already on a local stack, does nothing.
#   - RAM cap (TD_LOCAL_STACK_CAP, default 4): at/over the cap → skip, stay on shared sandbox.
#   - Seeds a sandbox .env.local from the main checkout if the worktree has none, then runs env-up.
set -uo pipefail

WT="${1:-$PWD}"
LOG="$WT/.auto-isolate.log"
say(){ echo "[$(date '+%H:%M:%S')] $*" >> "$LOG" 2>/dev/null; echo "$*"; }
done0(){ exit 0; }  # fail-soft: always succeed so we never block a session

cd "$WT" 2>/dev/null || { say "auto-isolate: cannot cd $WT — skip"; done0; }

# 0. Reclaim stacks whose worktree was closed (runs for EVERY session, even the main
#    checkout). Backgrounded so it never delays session start. Backstop to the session's
#    own "offer to tear down when work ships" — catches worktrees closed without asking.
if [ -f scripts/worktree-stack-sweep.sh ]; then
  nohup bash scripts/worktree-stack-sweep.sh >/dev/null 2>&1 < /dev/null &
  disown 2>/dev/null || true
fi

# 1. Only linked worktrees (their .git is a FILE; the main checkout's is a DIR).
[ -f .git ] || { say "auto-isolate: not a linked worktree — skip"; done0; }
[ -f scripts/env-up.sh ] || { say "auto-isolate: no env-up.sh here — skip"; done0; }

# 2. Idempotent: already isolated?
if [ -f .env.local ] && grep -qE '^NEXT_PUBLIC_SUPABASE_URL="?http://127\.0\.0\.1' .env.local; then
  say "auto-isolate: already isolated — nothing to do"; done0
fi

# 3. RAM cap — count running local stacks (one supabase_db container per stack).
CAP="${TD_LOCAL_STACK_CAP:-4}"
RUNNING=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -c 'supabase_db_tdlocal-')
[ -z "$RUNNING" ] && RUNNING=0
if [ "$RUNNING" -ge "$CAP" ]; then
  say "auto-isolate: $RUNNING/$CAP stacks running — SKIP (worktree stays on shared sandbox)."
  echo "skipped-cap $(date)" > .auto-isolate.status; done0
fi

# 4. Ensure a sandbox .env.local to clone FROM (seed from the main checkout if missing).
if [ ! -f .env.local ]; then
  MAIN_ROOT="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)")"
  if [ -n "$MAIN_ROOT" ] && [ -f "$MAIN_ROOT/.env.local" ]; then
    cp "$MAIN_ROOT/.env.local" ./.env.local
    say "auto-isolate: seeded sandbox .env.local from $MAIN_ROOT"
  else
    say "auto-isolate: no base .env.local to seed from ($MAIN_ROOT) — skip"; done0
  fi
fi

# 5. Provision in the BACKGROUND so the SessionStart hook returns immediately and NEVER hangs.
#    The detached worker brings up Colima + runs env-up + records status. The session opens
#    on the shared sandbox now; this worktree is fully isolated from its NEXT session on.
echo "provisioning $(date)" > .auto-isolate.status
say "auto-isolate: launching background provisioning — session continues; isolation ready shortly."
WT="$WT" LOG="$LOG" nohup bash -c '
  cd "$WT" || exit 0
  if ! colima status >/dev/null 2>&1; then
    colima start >/dev/null 2>&1 || { echo "skipped-nocolima $(date)" > "$WT/.auto-isolate.status"; exit 0; }
  fi
  if bash scripts/env-up.sh >> "$LOG" 2>&1; then
    echo "isolated $(date)" > "$WT/.auto-isolate.status"
  else
    echo "failed $(date)" > "$WT/.auto-isolate.status"
  fi
' >/dev/null 2>&1 < /dev/null &
disown 2>/dev/null || true
done0
