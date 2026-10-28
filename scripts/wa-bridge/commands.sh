#!/bin/bash
# What the CRM asked the Mac to do (dev job 69c6ce32, 2026-10-28). Started in the background by heartbeat.sh after every beat that the CRM
# answered with HTTP 200. The CRM cannot call the Mac, so every heartbeat REPLY carries `commands`:
#   {"want_code": true}       "Get a new code" was pressed (owner, while WhatsApp is unlinked) → link-code.sh asks GOWA for ONE code
#   {"recover_days": 7}       "Recover missing messages" was pressed → run the normal catch-up (node sync.mjs catchup --days N, the same
#                             thing that already runs every 15 min), then report how many messages it read / how many were new
# Nothing is done when the reply says nothing is wanted. One job at a time (lock); a stuck job is dropped after 10 minutes.
# The reply file is consumed (deleted) first, so a stale reply can never be acted on twice.
#
# Env overrides (rehearsal against the sandbox): CHANNEL_ID WEBHOOK_SECRET CRM_BASE_URL HB_FILE SYNC_CMD LINK_SCRIPT
set -uo pipefail
cd "$HOME/wa-bridge" || exit 1
_ov_ch="${CHANNEL_ID:-}"; _ov_sec="${WEBHOOK_SECRET:-}"; _ov_url="${CRM_BASE_URL:-}"
set -a; source ./bridge.env; set +a
[[ -n "$_ov_ch" ]] && CHANNEL_ID="$_ov_ch"; [[ -n "$_ov_sec" ]] && WEBHOOK_SECRET="$_ov_sec"; [[ -n "$_ov_url" ]] && CRM_BASE_URL="$_ov_url"
HB="${HB_FILE:-$HOME/wa-bridge/storages/hb.json}"
NODE_BIN="/Users/10225office/.nvm/versions/node/v20.20.1/bin/node"
SYNC_CMD="${SYNC_CMD:-}"
LINK_SCRIPT="${LINK_SCRIPT:-./link-code.sh}"
LOCK="$HOME/wa-bridge/storages/commands.lock.d"
BYPASS="$(cat ./vercel-bypass.txt 2>/dev/null || true)"
URL="$CRM_BASE_URL/api/wa-bridge/$CHANNEL_ID"
if [[ "$CRM_BASE_URL" == *sandbox* && -n "$BYPASS" ]]; then URL="$URL?x-vercel-protection-bypass=$BYPASS"; fi

[[ -s "$HB" ]] || exit 0
WANT="$(jq -r '.commands.want_code // false' "$HB" 2>/dev/null || echo false)"
DAYS="$(jq -r '.commands.recover_days // empty' "$HB" 2>/dev/null || true)"
rm -f "$HB"                                              # consume the reply: it can only be acted on once
[[ "$WANT" == "true" || -n "$DAYS" ]] || exit 0

# one job at a time; a lock older than 10 minutes belongs to a job that died
mkdir -p "$HOME/wa-bridge/storages"
if ! mkdir "$LOCK" 2>/dev/null; then
  age=$(( $(date +%s) - $(stat -f %m "$LOCK" 2>/dev/null || echo 0) ))
  if (( age > 600 )); then rm -rf "$LOCK"; mkdir "$LOCK" 2>/dev/null || exit 0; else exit 0; fi
fi
trap 'rm -rf "$LOCK"' EXIT

log() { echo "$(date '+%F %T') commands: $*"; }

# ── 1. a pairing code was asked for ─────────────────────────────────────────────────────────────────────────────────────────────
if [[ "$WANT" == "true" ]]; then
  log "pairing code requested from the CRM — asking for one"
  WANTED=1 bash "$LINK_SCRIPT" >> "$HOME/wa-bridge/logs/link-code.log" 2>&1
fi

# ── 2. "Recover missing messages" ──────────────────────────────────────────────────────────────────────────────────────────────────
if [[ -n "$DAYS" ]]; then
  if ! [[ "$DAYS" =~ ^[0-9]+$ ]] || (( DAYS < 1 || DAYS > 30 )); then log "ignoring a recover request with a bad day count"; exit 0; fi
  log "recover requested — running the catch-up over $DAYS days"
  OUT_FILE="$(mktemp "$HOME/wa-bridge/storages/recover.XXXXXX")"
  if [[ -n "$SYNC_CMD" ]]; then
    ( bash -c "$SYNC_CMD" > "$OUT_FILE" 2>&1 ) &
  else
    ( "$NODE_BIN" sync.mjs catchup --days "$DAYS" > "$OUT_FILE" 2>&1 ) &
  fi
  PID=$!
  # a catch-up normally takes seconds; give it 3 minutes, then stop it
  for _ in $(seq 1 90); do kill -0 "$PID" 2>/dev/null || break; sleep 2; done
  if kill -0 "$PID" 2>/dev/null; then kill "$PID" 2>/dev/null; log "the catch-up did not finish in 3 minutes — stopped; no result reported"; rm -f "$OUT_FILE"; exit 0; fi
  wait "$PID" 2>/dev/null || true
  LINE="$(grep -E '^catchup: [0-9]+ chats?, [0-9]+ messages? read; [0-9]+ saved' "$OUT_FILE" | tail -1)"
  rm -f "$OUT_FILE"
  READ="$(printf '%s' "$LINE" | sed -nE 's/^catchup: [0-9]+ chats?, ([0-9]+) messages? read; .*/\1/p')"
  SAVED="$(printf '%s' "$LINE" | sed -nE 's/^catchup: [0-9]+ chats?, [0-9]+ messages? read; ([0-9]+) saved.*/\1/p')"
  if [[ -z "$READ" || -z "$SAVED" ]]; then log "the catch-up gave no summary line — nothing reported (the CRM will say the Mac did not answer)"; exit 0; fi
  TS=$(( $(date +%s) * 1000 ))
  BODY="{\"event\":\"bridge.recover.result\",\"ts\":$TS,\"saved\":$SAVED,\"read\":$READ}"
  SIG="$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" -hex | sed 's/^.* //')"
  HTTP="$(curl -s -m 20 -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" -H "X-Hub-Signature-256: sha256=$SIG" -d "$BODY" "$URL")"
  log "recover finished — read $READ, $SAVED new; reported to the CRM, http $HTTP"
fi
exit 0
