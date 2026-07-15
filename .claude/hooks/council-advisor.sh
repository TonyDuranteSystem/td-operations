#!/bin/sh
# council-advisor.sh — ADVISORY ONLY, never blocks (always exit 0, never "deny"/"ask").
# When a `git push` touches sensitive areas (money / tax / client data / CRM-portal /
# compliance) it INJECTS a one-line reminder into the session's context suggesting a
# FULL /council before merging. It does NOT run the council and does NOT gate the push —
# the council's real value is at plan time; this is a late backstop reminder only.
#
# Two ways to run:
#   (1) Manually:   sh .claude/hooks/council-advisor.sh --branch   (prints to terminal)
#   (2) PreToolUse Bash hook (.claude/settings.json): reads the tool JSON on stdin and
#       stays SILENT unless the command is a `git push` — so ordinary bash calls are
#       untouched. Surfaces via hookSpecificOutput.additionalContext (non-blocking).
#
# Deliberately its OWN script, NOT wired into the protected .husky/pre-push
# (per the council's Phase-2 review). Never reads the pre-push stdin refs.

MODE="hook"
CMD=""
if [ "$1" = "--branch" ]; then
  MODE="manual"; CMD="git push"          # manual: always analyze, print to terminal
elif [ ! -t 0 ]; then
  INPUT=$(cat 2>/dev/null)                # hook: tool JSON on stdin
  # command may be top-level or nested under tool_input, depending on version.
  CMD=$(printf '%s' "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('command') or d.get('tool_input',{}).get('command','') or '')" 2>/dev/null || echo "")
fi

# Only speak for a git push; fast-exit on every other bash command (no git spawned).
case "$CMD" in
  *"git push"*) : ;;
  *) exit 0 ;;
esac

# Changed files on this branch vs main (committed + staged + unstaged).
CHANGED=$( { git diff --name-only origin/main...HEAD 2>/dev/null; \
             git diff --cached --name-only 2>/dev/null; \
             git diff --name-only 2>/dev/null; } | sort -u )
[ -z "$CHANGED" ] && exit 0

# Sensitive-area path/name patterns (edit this list to tune — keep it flexible).
# Anchored to path segments / distinctive names to limit false positives.
PATTERN='lib/tax/|financial|/pnl|invoice|payment|payout|billing|escrow|lib/portal/|components/portal/|app/portal/|lib/operations/|formation|onboarding|compliance|deadline|renewal|referral|itin|ss4|lease|offer|banking|registered.agent'
HITS=$(printf '%s\n' "$CHANGED" | grep -Ei "$PATTERN")
[ -z "$HITS" ] && exit 0

# Total changed lines across committed + staged + unstaged (fixes commit-time undercount).
LINES=$( { git diff --shortstat origin/main...HEAD 2>/dev/null; \
           git diff --cached --shortstat 2>/dev/null; \
           git diff --shortstat 2>/dev/null; } \
         | grep -oE '[0-9]+ (insertion|deletion)' | grep -oE '[0-9]+' | awk '{s+=$1} END{print s+0}')
COUNT=$(printf '%s\n' "$HITS" | grep -c .)

# Non-trivial gate (avoid alert fatigue): >=2 sensitive files OR >=40 changed lines.
if [ "${COUNT:-0}" -lt 2 ] && [ "${LINES:-0}" -lt 40 ]; then exit 0; fi

FILES=$(printf '%s\n' "$HITS" | head -8 | tr '\n' ';' | sed 's/;/; /g; s/; $//')
MSG="COUNCIL ADVISORY (not a block): this push touches sensitive areas (money / tax / client data / CRM-portal / compliance) — consider a FULL /council before merging. Files: ${FILES}"

if [ "$MODE" = "manual" ]; then
  echo ""
  echo "🧑‍⚖️  $MSG"
  echo ""
else
  # Inject as non-blocking context (does NOT deny or ask — the push proceeds).
  # JSON-encode via python so a path containing a quote/backslash can't break the payload.
  python3 -c "import json,sys; print(json.dumps({'hookSpecificOutput':{'hookEventName':'PreToolUse','additionalContext':sys.argv[1]}}))" "$MSG" 2>/dev/null || true
fi
exit 0
