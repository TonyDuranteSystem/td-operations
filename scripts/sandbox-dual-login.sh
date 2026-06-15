#!/usr/bin/env bash
#
# sandbox-dual-login.sh — open two FULLY ISOLATED Chrome windows for sandbox QA:
# one for the CRM dashboard (admin) and one for the client portal (client).
#
# WHY THIS EXISTS
# Admin and client both authenticate against the SAME Supabase project. In one
# browser profile there is ONE cookie jar, so you can only hold ONE identity
# (admin OR client) at a time — logging into one logs you out of the other.
# In production that's a non-issue because admin (crm.*) and portal (portal.*)
# live on different domains => different cookie jars. The sandbox serves both
# from one host (td-operations-sandbox.vercel.app), so the jars collide.
#
# This launcher sidesteps that by giving each window its OWN --user-data-dir,
# which is an independent cookie jar. You log in once in each, and both stay
# logged in side by side — fully interactive on both sides.
#
# USAGE
#   ./scripts/sandbox-dual-login.sh
#
# The profiles persist under ~/.td-sandbox-chrome/ so your logins are remembered
# between runs. Delete that directory to reset (e.g. to test a fresh login).
#
# OVERRIDES (env vars)
#   CRM_URL     CRM/dashboard login URL    (default: sandbox /login)
#   PORTAL_URL  client portal login URL    (default: sandbox /portal/login)
#   CHROME      path to the Chrome binary
#
# NOTE: once the sandbox gets its own portal domain (portal-sandbox.*), point
# PORTAL_URL at it so the setup mirrors production exactly.

set -euo pipefail

CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
SANDBOX_BASE="${SANDBOX_BASE:-https://td-operations-sandbox.vercel.app}"
CRM_URL="${CRM_URL:-$SANDBOX_BASE/login}"
PORTAL_URL="${PORTAL_URL:-$SANDBOX_BASE/portal/login}"

ADMIN_DIR="$HOME/.td-sandbox-chrome/admin"
CLIENT_DIR="$HOME/.td-sandbox-chrome/client"

if [ ! -x "$CHROME" ]; then
  echo "❌ Chrome not found at: $CHROME" >&2
  echo "   Set CHROME=/path/to/Google Chrome and retry." >&2
  exit 1
fi

mkdir -p "$ADMIN_DIR" "$CLIENT_DIR"

echo "🟦 ADMIN  window → $CRM_URL"
echo "🟩 CLIENT window → $PORTAL_URL"
echo "    (separate cookie jars — both stay logged in. Logins persist in ~/.td-sandbox-chrome/)"

# Each --user-data-dir is a distinct Chrome instance with its own cookies.
# --no-first-run / --no-default-browser-check keep the QA windows clean.
"$CHROME" \
  --user-data-dir="$ADMIN_DIR" \
  --no-first-run --no-default-browser-check \
  --window-position=0,0 --window-size=1000,1080 \
  --new-window "$CRM_URL" >/dev/null 2>&1 &

"$CHROME" \
  --user-data-dir="$CLIENT_DIR" \
  --no-first-run --no-default-browser-check \
  --window-position=1010,0 --window-size=1000,1080 \
  --new-window "$PORTAL_URL" >/dev/null 2>&1 &

echo "✅ Two windows launched. Log in once in each; they'll remember you next time."
