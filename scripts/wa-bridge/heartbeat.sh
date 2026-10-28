#!/bin/bash
# Reports the bridge's health to the CRM every 60s (launchd com.td.wa-bridge-heartbeat).
# GOWA emits no connect/disconnect event, so this is how the CRM finds out the link dropped.
# A missing heartbeat (Mac off / no internet) is itself detected by the CRM's wa-bridge-watch cron.
# The body carries a signed timestamp: the CRM rejects a heartbeat older than 2 minutes (no replays).
# The CRM's REPLY carries what it wants the Mac to do next ("Get a new code" / "Recover missing messages" were pressed —
# the CRM cannot call the Mac, so the Mac asks on every beat). The reply is kept in storages/hb.json and handed to commands.sh,
# which runs in the background so a slow job can never delay the next heartbeat. (dev job 69c6ce32, 2026-10-28)
set -uo pipefail
cd "$HOME/wa-bridge"
set -a; source ./bridge.env; set +a
BYPASS="$(cat ./vercel-bypass.txt 2>/dev/null || true)"
URL="$CRM_BASE_URL/api/wa-bridge/$CHANNEL_ID"
if [[ "$CRM_BASE_URL" == *sandbox* && -n "$BYPASS" ]]; then URL="$URL?x-vercel-protection-bypass=$BYPASS"; fi

REACHABLE=false; CONNECTED=false; LOGGED_IN=false
if STATUS="$(curl -s -m 8 -u "$GOWA_BASIC_AUTH" "http://127.0.0.1:$GOWA_PORT/devices/td-crm/status")" && [[ "$STATUS" == *'"code":"SUCCESS"'* ]]; then
  REACHABLE=true
  [[ "$STATUS" == *'"is_connected":true'* ]] && CONNECTED=true
  [[ "$STATUS" == *'"is_logged_in":true'* ]] && LOGGED_IN=true
fi
TS=$(( $(date +%s) * 1000 ))
BODY="{\"event\":\"bridge.heartbeat\",\"ts\":$TS,\"reachable\":$REACHABLE,\"connected\":$CONNECTED,\"logged_in\":$LOGGED_IN}"
SIG="$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" -hex | sed 's/^.* //')"
HB_TMP="$HOME/wa-bridge/storages/hb.json.tmp"; HB_OUT="$HOME/wa-bridge/storages/hb.json"
mkdir -p "$HOME/wa-bridge/storages"
HTTP="$(curl -s -m 20 -o "$HB_TMP" -w "%{http_code}" -X POST -H "Content-Type: application/json" -H "X-Hub-Signature-256: sha256=$SIG" -d "$BODY" "$URL")"
echo "$HTTP"
# keep the reply only when the CRM really answered 200 (a stale or error body must never trigger work)
if [[ "$HTTP" == "200" ]]; then
  mv -f "$HB_TMP" "$HB_OUT"
  # run the commands in the background, detached from this beat (commands.sh has its own lock and does nothing when there is nothing to do)
  if [[ -x "$HOME/wa-bridge/commands.sh" || -f "$HOME/wa-bridge/commands.sh" ]]; then
    ( nohup bash "$HOME/wa-bridge/commands.sh" >> "$HOME/wa-bridge/logs/commands.log" 2>&1 & ) >/dev/null 2>&1
  fi
else
  rm -f "$HB_TMP"
fi
