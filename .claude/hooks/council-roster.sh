#!/bin/sh
# council-roster.sh — SessionStart reminder for the Council of Reviewers.
# Prints the standing rules + the CURRENT specialist roster (read live from the
# specialists folder) so the session never forgets what experts exist or how to
# convene them. Print-only (no DB, no side effects); mirrors dev-board-index.sh.
# Runs from the repo root like the other SessionStart hooks.

SPEC_DIR=".claude/skills/council/specialists"

echo ""
echo "🧑‍⚖️  COUNCIL OF REVIEWERS — convene before presenting a significant plan (skill: /council)."
echo "   Core reviewers (read-only, real subagents, ALL on every call): senior-engineer ·"
echo "   ai-architect · project-director · bug-hunter (aggressive, always hunting)."
echo "   Auto-select the specialists from the task (don't make the user name them). For any BUG /"
echo "   issue / investigation / audit → also run the 2-phase bug flow (investigate w/ cited"
echo "   findings → 4 core approve the fix plan → only then show Antonio)."
echo "   Rules: size-gate (skip trivial) · Antonio's \"go\" is the only authorization · any one"
echo "   cited blocker = fix-first (no voting) · flag a missing specialist, never auto-invent one."

if [ -d "$SPEC_DIR" ]; then
  ROSTER=$(ls "$SPEC_DIR" 2>/dev/null | grep -v '^_' | sed 's/\.md$//' | sort | paste -sd ',' - | sed 's/,/,  /g')
  if [ -n "$ROSTER" ]; then
    echo "   Specialists on tap (use now: /council with <Name>; add: @add-specialist <Name>):"
    echo "     $ROSTER"
  fi
fi
echo "   Full rules: .claude/skills/council/PROTOCOL.md"
echo ""
exit 0
