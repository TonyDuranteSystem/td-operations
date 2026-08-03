#!/bin/sh
# council-roster.sh — SessionStart reminder for the Council of Reviewers.
# Prints the standing rules + the CURRENT specialist roster (read live from the
# specialists folder) so the session never forgets what experts exist or how to
# convene them. Print-only (no DB, no side effects); mirrors dev-board-index.sh.
# Runs from the repo root like the other SessionStart hooks.

SPEC_DIR=".claude/skills/council/specialists"

echo ""
echo "🧭 R113 — ASK THE SYSTEM COUNSELOR **FIRST**, ON EVERY INVESTIGATION. Before you form a"
echo "   theory about ANY bug / \"how does X work\" / audit / feature touching an existing flow:"
echo "   spawn the \`system-counselor\` subagent in ORIENTATION mode (short + cheap) with what you"
echo "   were asked and what you're about to go look at. It answers from the LIVE system (DB, CRM,"
echo "   clients, offers, rules, SOPs, catalog, docs, email/chat, code) — how it ACTUALLY works"
echo "   today, where to look, what already exists, what you're about to get wrong."
echo "   Then RE-CHECK it when your theory forms — it can INTERRUPT and redirect a wrong"
echo "   investigation mid-flight. NOT size-gated: Antonio chose this token cost over the cost of"
echo "   a wrong investigation. If HE has to tell you \"that's not how it works here\", this failed."
echo ""
echo "🧑‍⚖️  COUNCIL OF REVIEWERS — convene before presenting a significant plan (skill: /council)."
echo "   Core reviewers (read-only, real subagents, ALL on every call — 5): senior-engineer ·"
echo "   ai-architect · project-director · bug-hunter (aggressive, always hunting) ·"
echo "   system-counselor (360° system + business truth; the ONLY reviewer with LIVE READ"
echo "   access — prod DB/CRM/KB/SOPs/catalog/offers/SDs/deadlines/docs/code — so it must"
echo "   VERIFY BY QUERYING, never by quoting a doc; consulted EARLY; a cited MISMATCH STOPS"
echo "   and REDIRECTS the work. Index: .claude/skills/council/SYSTEM-KNOWLEDGE.md — holds NO"
echo "   business facts by design (one query away); it routes, it is never evidence)."
echo "   Auto-select the specialists from the task (don't make the user name them). For any BUG /"
echo "   issue / investigation / audit → also run the 2-phase bug flow (investigate w/ cited"
echo "   findings → 5 core approve the fix plan → only then show Antonio)."
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
