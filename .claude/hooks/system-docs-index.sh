#!/bin/sh
# system-docs-index.sh — SessionStart visibility for the System Reference Library.
# Prints the available per-subsystem docs so every session knows they exist and
# reads the relevant one BEFORE re-deriving a system from the code/DB (R107).
# Runs from the repo root (same as the other SessionStart hooks).

[ -d docs/systems ] || exit 0

echo ""
echo "📚 SYSTEM REFERENCE LIBRARY — read the relevant doc BEFORE working on a subsystem (R107)."
echo "   These describe how each system works, so you don't re-audit the DB/code from scratch."
for f in docs/systems/*.md; do
  [ -f "$f" ] || continue
  case "$f" in */README.md) continue ;; esac
  title=$(head -1 "$f" | sed 's/^#* *//')
  echo "   • $f — $title"
done
echo "   Index + how to add one: docs/systems/README.md"
echo "   ⚠️  If you work on a subsystem with NO doc here, CREATE its doc as part of the job."
echo ""
exit 0
