#!/bin/bash
# ============================================================
# Deploy the current worktree to the SANDBOX Vercel project.
#
# The ONLY supported way to deploy sandbox. It exists because two things must
# happen on every deploy and both were previously done by hand (and forgotten):
#
#   1. The BUILD STAMP is injected from the local git checkout. Vercel's own
#      git variables are empty here — the project is deliberately
#      git-disconnected (2026-08-07) so main builds can't steal the sandbox
#      alias. Without this injection the banner reads "build unknown" and
#      Antonio is back to QA-ing an unidentifiable page.
#   2. The deployment is PROMOTED to the sandbox alias. A bare `vercel deploy`
#      leaves the alias pointing at whatever was there before, which is exactly
#      how a six-hour-old build ended up under QA.
#   3. The build NEVER reuses a cache (--force, no --with-cache). This sandbox
#      project is shared across every worktree on the machine; reusing a cache
#      built from a different worktree's checkout is a real risk even if it
#      wasn't conclusively caught doing so. Worth the slower deploy.
#
# Usage: bash scripts/deploy-sandbox.sh
# ============================================================
set -euo pipefail

SCOPE="tony-durantes-projects"
ALIAS="td-operations-sandbox.vercel.app"

SHA="$(git rev-parse --short=7 HEAD)"
DIRTY=""
if ! git diff --quiet || ! git diff --cached --quiet; then DIRTY="+dirty"; fi
# Pre-formatted at deploy time so the banner renders a constant string.
STAMP_TIME="$(date '+%b %d %H:%M')"

echo "▶ deploying ${SHA}${DIRTY} (${STAMP_TIME}) to sandbox — clean build, no cache…"

URL="$(vercel deploy \
  --scope "$SCOPE" \
  --force \
  --build-env "NEXT_PUBLIC_BUILD_SHA=${SHA}${DIRTY}" \
  --build-env "NEXT_PUBLIC_BUILD_TIME=${STAMP_TIME}" \
  --yes 2>&1 | tee /dev/stderr | grep -Eo 'https://[a-z0-9-]+\.vercel\.app' | tail -1)"

if [[ -z "$URL" ]]; then
  echo "✖ deploy produced no URL — NOT promoting. Read the output above." >&2
  exit 1
fi

echo "▶ promoting $URL → $ALIAS"
vercel alias set "$URL" "$ALIAS" --scope "$SCOPE"

echo "✔ sandbox now serves ${SHA}${DIRTY} — the orange banner will say so."
echo "  deployment: $URL"
