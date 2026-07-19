#!/usr/bin/env bash
# env-up.sh — create (or refresh) an ISOLATED local dev environment for THIS worktree.
#
#   bash scripts/env-up.sh [name]
#
# What it does:
#   1. Backs up the current sandbox .env.local + .mcp.json (once), so env-down can restore them.
#   2. Spins up a private local Supabase stack on Colima with a unique port block.
#   3. Clones the cloud sandbox (schema+data+auth) into that local stack (refresh-clone.sh).
#   4. Rewrites .env.local to point THIS worktree at the local stack, forces SANDBOX_MODE=1,
#      and clears EXPECTED_SUPABASE_REF (local URL has no cloud ref).
#   5. Rewrites .mcp.json so Claude's MCP tools hit the LOCAL app (full isolation), not the
#      shared cloud sandbox.
#
# Preconditions: run `bash scripts/local-stack-setup.sh` once per machine, and have a
# sandbox .env.local present (run `bash scripts/dev-setup.sh` first if needed).
#
# After it finishes: start the dev server on the printed port and RESTART your Claude
# session so it picks up the new .mcp.json.
set -euo pipefail

WORKTREE="$(pwd)"
WITH_STORAGE=1
ARGS=()
for a in "$@"; do
  case "$a" in
    --no-storage) WITH_STORAGE=0 ;;
    *) ARGS+=("$a") ;;
  esac
done
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib-local-stacks.sh
. "$SCRIPT_DIR/lib-local-stacks.sh"

# Shared derivation (see stack_name_for_worktree): the branch, except a DETACHED
# worktree falls back to its folder name — otherwise every detached worktree
# would derive the same stack and silently share one database.
NAME="${ARGS[0]:-$(stack_name_for_worktree "$WORKTREE")}"
[ -n "$NAME" ] || { echo "❌ could not derive a name; pass one: bash scripts/env-up.sh myenv"; exit 1; }
STACK_DIR="$STACKS_ROOT/$NAME"
PROD_REF="ydzipybqeebtpcvsbtvs"
SANDBOX_REF="xjcxlmlpeywtwkhstjlw"

# ---- preconditions ---------------------------------------------------------
command -v supabase >/dev/null 2>&1 || { echo "❌ supabase CLI missing — run: bash scripts/local-stack-setup.sh"; exit 1; }
colima status >/dev/null 2>&1 || { echo "❌ Colima not running — run: bash scripts/local-stack-setup.sh"; exit 1; }
[ -f "$WORKTREE/.env.local" ] || { echo "❌ no .env.local here — run: bash scripts/dev-setup.sh first"; exit 1; }

# ---- backup the sandbox env (once) so env-down can restore -----------------
[ -f "$WORKTREE/.env.sandbox.local" ] || cp "$WORKTREE/.env.local" "$WORKTREE/.env.sandbox.local"
[ -f "$WORKTREE/.mcp.json" ] && [ ! -f "$WORKTREE/.mcp.json.sandbox" ] && cp "$WORKTREE/.mcp.json" "$WORKTREE/.mcp.json.sandbox"

# clone source = the sandbox creds preserved in the backup
SRC_DB_URL=$(grep -E '^SUPABASE_DB_URL=' "$WORKTREE/.env.sandbox.local" | head -1 | cut -d= -f2- | tr -d '"')
echo "$SRC_DB_URL" | grep -q "$PROD_REF"    && { echo "⛔ backup points to PRODUCTION — abort"; exit 2; }
echo "$SRC_DB_URL" | grep -q "$SANDBOX_REF" || { echo "⛔ backup is not the sandbox — run dev-setup first"; exit 2; }
MCP_KEY=$(grep -E '^TD_MCP_API_KEY=' "$WORKTREE/.env.sandbox.local" | head -1 | cut -d= -f2- | tr -d '"')

# ---- assign a free slot (→ unique ports) -----------------------------------
mkdir -p "$STACKS_ROOT"
if [ -f "$STACK_DIR/.slot" ]; then
  SLOT="$(cat "$STACK_DIR/.slot")"
else
  SLOT=1
  while :; do
    used=0
    for d in "$STACKS_ROOT"/*/.slot; do [ -f "$d" ] && [ "$(cat "$d")" = "$SLOT" ] && used=1; done
    [ "$used" = 0 ] && break
    SLOT=$((SLOT+1))
  done
fi
OFFSET=$((SLOT*100))
DEVPORT=$((3000+SLOT))
APIPORT=$((54321+OFFSET))
echo "▶ env '$NAME'  slot=$SLOT  api_port=$APIPORT  dev_port=$DEVPORT"

# ---- init + patch the stack config (unique ports, analytics off) -----------
mkdir -p "$STACK_DIR"; echo "$SLOT" > "$STACK_DIR/.slot"
echo "$WORKTREE" > "$STACK_DIR/.worktree-path"   # used by worktree-stack-sweep.sh to detect orphans
( cd "$STACK_DIR" && supabase init --force >/dev/null 2>&1 || supabase init >/dev/null 2>&1 || true )
CFG="$STACK_DIR/supabase/config.toml"
sed -i '' "s/^project_id = .*/project_id = \"tdlocal-${NAME}\"/" "$CFG"
# BSD/macOS sed has no \b; the 5-digit ports are unique in config.toml so a plain swap is safe.
for p in $(seq 54320 54329); do sed -i '' "s/${p}/$((p+OFFSET))/g" "$CFG"; done
sed -i '' '/^\[analytics\]/,/^\[/ s/^enabled = true/enabled = false/' "$CFG"

# ---- start the stack -------------------------------------------------------
echo "▶ starting local stack (first run pulls images)…"
( cd "$STACK_DIR" && supabase start )

# capture local connection details (JSON is stable across CLI versions; env var names are not)
STATUS_JSON="$( cd "$STACK_DIR" && supabase status -o json 2>/dev/null )"
get() { echo "$STATUS_JSON" | python3 -c "import sys,json;print(json.load(sys.stdin).get('$1',''))"; }
LOCAL_API="$(get API_URL)"; LOCAL_DB="$(get DB_URL)"
LOCAL_ANON="$(get ANON_KEY)"; LOCAL_SVC="$(get SERVICE_ROLE_KEY)"
[ -n "$LOCAL_API" ] && [ -n "$LOCAL_DB" ] && [ -n "$LOCAL_SVC" ] || { echo "❌ could not read local stack status"; exit 1; }

# ---- clone sandbox → local -------------------------------------------------
echo "▶ cloning sandbox → local…"
bash "$SCRIPT_DIR/refresh-clone.sh" "$SRC_DB_URL" "$LOCAL_DB"

# copy document file bytes from sandbox storage → local (best-effort, non-fatal)
if [ "$WITH_STORAGE" = 1 ]; then
  echo "▶ copying storage files (documents)…"
  SRC_API=$(grep -E '^NEXT_PUBLIC_SUPABASE_URL=' "$WORKTREE/.env.sandbox.local" | head -1 | cut -d= -f2- | tr -d '"')
  SRC_KEY=$(grep -E '^SUPABASE_SERVICE_ROLE_KEY=' "$WORKTREE/.env.sandbox.local" | head -1 | cut -d= -f2- | tr -d '"')
  SRC_URL="$SRC_API" SRC_KEY="$SRC_KEY" DST_URL="$LOCAL_API" DST_KEY="$LOCAL_SVC" \
    node "$SCRIPT_DIR/copy-storage.cjs" || echo "  ⚠️ storage copy skipped/failed (non-fatal)"
fi

# ---- rewrite .env.local for local mode (start from the sandbox backup) -----
upsert() { # file key value
  local f="$1" k="$2" v="$3" t; t="$(mktemp)"
  grep -vE "^${k}=" "$f" > "$t" || true; echo "${k}=\"${v}\"" >> "$t"; mv "$t" "$f"
}
cp "$WORKTREE/.env.sandbox.local" "$WORKTREE/.env.local"
upsert "$WORKTREE/.env.local" NEXT_PUBLIC_SUPABASE_URL      "$LOCAL_API"
upsert "$WORKTREE/.env.local" NEXT_PUBLIC_SUPABASE_ANON_KEY "$LOCAL_ANON"
upsert "$WORKTREE/.env.local" SUPABASE_SERVICE_ROLE_KEY     "$LOCAL_SVC"
upsert "$WORKTREE/.env.local" SUPABASE_DB_URL               "$LOCAL_DB"
upsert "$WORKTREE/.env.local" SANDBOX_MODE                  "1"
upsert "$WORKTREE/.env.local" EXPECTED_SUPABASE_REF         ""
upsert "$WORKTREE/.env.local" LOCAL_STACK_NAME              "$NAME"

# ---- rewrite .mcp.json so Claude's MCP tools hit the LOCAL app --------------
python3 - "$WORKTREE/.mcp.json" "$DEVPORT" "$MCP_KEY" "$WORKTREE/.mcp.json.sandbox" <<'PY'
import json, sys, os
out, devport, key, backup = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
cfg = {"mcpServers": {}}
if os.path.exists(backup):
    try: cfg = json.load(open(backup))
    except Exception: pass
cfg.setdefault("mcpServers", {})["td-ops-sandbox"] = {
    "type": "http",
    "url": f"http://127.0.0.1:{devport}/api/mcp",
    "headers": {"Authorization": "Bearer " + key},
}
json.dump(cfg, open(out, "w"), indent=2); open(out, "a").write("\n")
PY

echo ""
echo "✅ env '$NAME' is up and isolated."
echo "   • dev server : npm run dev -- -p $DEVPORT   (serves the app + local MCP)"
echo "   • studio     : http://127.0.0.1:$((54323+OFFSET))"
echo "   • database   : private local copy (clone of sandbox)"
echo "   • emails/ext : BLOCKED (SANDBOX_MODE=1)"
echo ""
echo "⚠️  RESTART your Claude session now so it loads the new .mcp.json (MCP → local)."
echo "   To revert this worktree to the shared sandbox:  bash scripts/env-down.sh"
