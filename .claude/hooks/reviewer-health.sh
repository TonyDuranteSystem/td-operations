#!/usr/bin/env bash
# reviewer-health.sh — SessionStart alert: is the end-of-turn safety reviewer UP?
#
# The independent reviewer (r093_verifier.py) FAILS OPEN — it lets a turn pass —
# whenever its auditor can't run. The worst case is a revoked/expired
# command-line login: the whole net silently steps aside on every turn with no
# signal (this happened 2026-07-24 and went unnoticed). The reviewer now writes a
# DOWN flag on an auth failure and clears it on a clean run. This hook reads that
# flag at session start and warns LOUDLY while DOWN. Silence = healthy.
#
# Print-only, exit 0, no writes, no side effects. Kill switch: REVIEWER_HEALTH_OFF=1.
[ "${REVIEWER_HEALTH_OFF:-}" = "1" ] && exit 0

STATUS="${R093_NET_STATUS:-/tmp/r093-verifier-DOWN}"
[ -f "$STATUS" ] || exit 0

SINCE=$(python3 -c "import json;print(json.load(open('$STATUS')).get('since','?'))" 2>/dev/null || echo "?")

echo ""
echo "🔴🔴 SAFETY REVIEWER DOWN — the end-of-turn reply checker could not sign in on its last run (since ${SINCE})."
echo "     Replies are NOT being independently checked right now — it is failing open silently."
echo "     FIX: run this in a terminal, then it self-heals on the next reply:"
echo "         claude auth login"
echo ""
exit 0
