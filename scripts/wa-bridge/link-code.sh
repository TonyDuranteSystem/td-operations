#!/bin/bash
# Reconnect-from-the-CRM helper (dev job 907b2535 / e23343a6; ON DEMAND since dev job 69c6ce32, 2026-10-28). Called every ~60 s by agent-loop.sh.
# When WhatsApp has UNLINKED this device (GOWA reports is_logged_in=false) AND the owner pressed "Get a new code" in the CRM
# (commands.sh sets WANTED=1 when the heartbeat reply says so), ask OUR OWN GOWA for ONE pairing code and post it,
# signed, to the CRM as bridge.linkcode. The CRM shows it to the owner only. Nothing else happens while the device is healthy,
# and — new — NOTHING is requested while nobody asked (2026-10-28: all 5 codes had been burnt in 8 minutes with nobody at the screen).
#
# Ban-risk guards: at most 5 codes per rolling HOUR, at least 30 s apart; the counter also resets the moment the device is logged in again.
# The code is a credential-equivalent: it is NEVER written to a log (only "code #n requested / posted, http NNN").
#
# Env overrides (used to rehearse against the sandbox with a spare device / a stand-in for GOWA): CHANNEL_ID WEBHOOK_SECRET CRM_BASE_URL LINK_DEVICE LEAD_PHONE LINK_STATE_FILE LINK_GOWA_URL
set -uo pipefail
cd "$HOME/wa-bridge"
_ov_ch="${CHANNEL_ID:-}"; _ov_sec="${WEBHOOK_SECRET:-}"; _ov_url="${CRM_BASE_URL:-}"; _ov_dev="${LINK_DEVICE:-}"; _ov_ph="${LEAD_PHONE:-}"; _ov_state="${LINK_STATE_FILE:-}"
set -a; source ./bridge.env; set +a
[[ -n "$_ov_ch" ]] && CHANNEL_ID="$_ov_ch"; [[ -n "$_ov_sec" ]] && WEBHOOK_SECRET="$_ov_sec"; [[ -n "$_ov_url" ]] && CRM_BASE_URL="$_ov_url"
DEVICE="${_ov_dev:-td-crm}"
PHONE="${_ov_ph:-${LEAD_PHONE:-}}"
STATE_FILE="${_ov_state:-$HOME/wa-bridge/storages/link.state}"
MAX_ATTEMPTS=5
MIN_GAP_S=30
WINDOW_S=3600
[[ -z "$PHONE" ]] && exit 0
GOWA="${LINK_GOWA_URL:-http://127.0.0.1:$GOWA_PORT}"
BYPASS="$(cat ./vercel-bypass.txt 2>/dev/null || true)"
URL="$CRM_BASE_URL/api/wa-bridge/$CHANNEL_ID"
if [[ "$CRM_BASE_URL" == *sandbox* && -n "$BYPASS" ]]; then URL="$URL?x-vercel-protection-bypass=$BYPASS"; fi

STATUS="$(curl -s -m 8 -u "$GOWA_BASIC_AUTH" "$GOWA/devices/$DEVICE/status")" || exit 0
[[ "$STATUS" == *'"code":"SUCCESS"'* ]] || exit 0            # GOWA itself not answering: the heartbeat already reports process_down
if [[ "$STATUS" == *'"is_logged_in":true'* ]]; then rm -f "$STATE_FILE"; exit 0; fi   # healthy again: reset the outage counter
[[ "${WANTED:-0}" == "1" ]] || exit 0                        # unlinked, but nobody asked for a code: do nothing (no WhatsApp traffic)

ATTEMPTS=0; LAST=0; WSTART=0
[[ -f "$STATE_FILE" ]] && read -r ATTEMPTS LAST WSTART < "$STATE_FILE"
[[ "$ATTEMPTS" =~ ^[0-9]+$ ]] || ATTEMPTS=0; [[ "$LAST" =~ ^[0-9]+$ ]] || LAST=0; [[ "${WSTART:-}" =~ ^[0-9]+$ ]] || WSTART=0
NOW="$(date +%s)"
if (( NOW - WSTART >= WINDOW_S )); then ATTEMPTS=0; WSTART=$NOW; fi   # a new hour starts a new allowance (an old-format file has no start: also a new hour)
(( ATTEMPTS >= MAX_ATTEMPTS )) && { echo "$(date '+%F %T') link-code: not asking — $MAX_ATTEMPTS codes were already made this hour"; exit 0; }
(( NOW - LAST < MIN_GAP_S )) && exit 0
echo "$((ATTEMPTS + 1)) $NOW $WSTART" > "$STATE_FILE"    # count the attempt BEFORE asking, so a crash can never loop

ask() { curl -s -m 30 -u "$GOWA_BASIC_AUTH" -X POST "$GOWA/devices/$DEVICE/login/code?phone=$PHONE"; }
RESP="$(ask)"
if [[ "$RESP" != *'"pair_code"'* ]]; then
  # the device row may have been dropped when WhatsApp unlinked it: recreate it (same id) and ask once more
  curl -s -m 10 -u "$GOWA_BASIC_AUTH" -X POST -H "Content-Type: application/json" -d "{\"device_id\":\"$DEVICE\"}" "$GOWA/devices" > /dev/null
  RESP="$(ask)"
fi
CODE="$(printf '%s' "$RESP" | jq -r '.results.pair_code // empty' 2>/dev/null)"
if [[ -z "$CODE" ]]; then echo "$(date '+%F %T') link-code: attempt $((ATTEMPTS + 1)) — GOWA gave no pairing code"; exit 0; fi

TS=$(( NOW * 1000 ))
BODY="{\"event\":\"bridge.linkcode\",\"ts\":$TS,\"code\":\"$CODE\"}"
SIG="$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" -hex | sed 's/^.* //')"
HTTP="$(curl -s -m 20 -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" -H "X-Hub-Signature-256: sha256=$SIG" -d "$BODY" "$URL")"
echo "$(date '+%F %T') link-code: attempt $((ATTEMPTS + 1)) — code posted to the CRM, http $HTTP"
