#!/bin/sh
# check-system-docs-freshness.sh — System Reference Library anti-rot gate (R107).
#
# Blocks a push that changes a DOCUMENTED subsystem's code without updating that
# subsystem's docs/systems/<x>.md in the same push. The whole point of the library
# is that the doc travels with the code; this is the structural enforcement of that.
#
# Map: docs/systems/_paths.map  (lines: "docs/systems/<doc>.md|prefix1,prefix2,...")
# Override (rare, deliberate):  ALLOW_SYSTEM_DOC_SKIP=1 git push ...
# Test:  CHANGED_FILES="components/dashboard/action-board.tsx" sh scripts/check-system-docs-freshness.sh
#
# Exit 0 = ok (or no map / override set); exit 1 = blocked.

MAP="docs/systems/_paths.map"
[ -f "$MAP" ] || exit 0

# Changed files vs origin/main (override with CHANGED_FILES env for testing).
CHANGED="${CHANGED_FILES:-$(git diff --name-only origin/main...HEAD 2>/dev/null)}"
[ -n "$CHANGED" ] || exit 0

violations=""
while IFS='|' read -r doc prefixes; do
  case "$doc" in ''|\#*) continue ;; esac
  [ -n "$prefixes" ] || continue

  # If the doc itself was updated in this push, this subsystem is satisfied.
  if printf '%s\n' "$CHANGED" | grep -qxF "$doc"; then
    continue
  fi

  # Otherwise: did any mapped code path change?
  OLDIFS=$IFS
  IFS=','
  for p in $prefixes; do
    IFS=$OLDIFS
    if printf '%s\n' "$CHANGED" | grep -q "^$p"; then
      violations="${violations}
  - ${doc}   (code changed under: ${p})"
      break
    fi
    IFS=','
  done
  IFS=$OLDIFS
done < "$MAP"

[ -n "$violations" ] || exit 0

echo ""
echo "❌ PUSH BLOCKED — System Reference Library out of date (R107)."
echo "   You changed code for a documented subsystem but did not update its doc:"
printf '%s\n' "$violations"
echo ""
echo "   Fix: update the doc(s) above in this push and bump 'Last verified against code'."
echo "   If this change genuinely doesn't affect the doc, override deliberately with:"
echo "     ALLOW_SYSTEM_DOC_SKIP=1 git push ..."
echo ""

if [ "${ALLOW_SYSTEM_DOC_SKIP:-}" = "1" ]; then
  echo "   ALLOW_SYSTEM_DOC_SKIP=1 set — continuing despite stale doc(s)."
  echo ""
  exit 0
fi
exit 1
