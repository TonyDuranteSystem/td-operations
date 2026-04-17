#!/usr/bin/env bash
# r095-gate.sh
# Stop hook: deterministic regex scanner for R095 (Present Plainly) violations
# in the last assistant message.
#
# Replaces the LLM-based approach for R095 specifically — an LLM judging
# another LLM's output drifts and loops (demonstrated pathologically during
# the P3.4 #6 session). Regex scan is deterministic: same input → same
# output, no drift.
#
# Catches R095 violations:
#   1. File paths with engineering extensions (.ts/.tsx/.sql/.py/etc.)
#   2. Schema references (snake_case.snake_case)
#   3. Backticked code identifiers (functionName, CamelCase)
#   4. Commit hashes in user-facing text
#   5. file:line references
#
# Out of scope — handled by assumption-check + LLM prompt:
#   - R093 (unverified claims) — requires semantic understanding, not regex

set -euo pipefail

# ─── Parse Stop hook stdin JSON ──────────────────────────

INPUT=$(cat)
TRANSCRIPT_PATH=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('transcript_path',''))" 2>/dev/null || echo "")
STOP_HOOK_ACTIVE=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('stop_hook_active',False))" 2>/dev/null || echo "False")

# Don't recurse — if we're inside a rewrite triggered by this hook, skip.
if [ "$STOP_HOOK_ACTIVE" = "True" ]; then
  echo "R095_CHECK=skipped (stop_hook_active)"
  exit 0
fi

if [ -z "$TRANSCRIPT_PATH" ] || [ ! -f "$TRANSCRIPT_PATH" ]; then
  echo "R095_CHECK=skipped (no transcript at '$TRANSCRIPT_PATH')"
  exit 0
fi

# ─── Extract last assistant message text ─────────────────

LAST_TEXT=$(python3 <<PY
import json, sys
path = "$TRANSCRIPT_PATH"
last_text = ""
try:
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except Exception:
                continue
            if obj.get("type") != "assistant":
                continue
            msg = obj.get("message", {})
            parts = msg.get("content", [])
            if isinstance(parts, str):
                last_text = parts
                continue
            text_parts = []
            for p in parts:
                if isinstance(p, dict) and p.get("type") == "text":
                    text_parts.append(p.get("text", ""))
            if text_parts:
                last_text = "\n".join(text_parts)
    print(last_text)
except Exception as e:
    sys.stderr.write(f"r095-gate: transcript read error: {e}\n")
PY
)

if [ -z "$LAST_TEXT" ]; then
  echo "R095_CHECK=skipped (no assistant text found)"
  exit 0
fi

# ─── Regex scans ─────────────────────────────────────────

VIOLATIONS=""

# 1. File paths with engineering extensions — e.g. lib/operations/email.ts
FILE_HITS=$(echo "$LAST_TEXT" | grep -oE '([a-zA-Z0-9_][a-zA-Z0-9_\-]*/)+[a-zA-Z0-9_\-\.]+\.(ts|tsx|jsx?|py|sql|sh|rb|go|rs|md|json)(:[0-9]+)?' | sort -u | head -5 || true)
if [ -n "$FILE_HITS" ]; then
  VIOLATIONS="${VIOLATIONS}
* File paths: $(echo "$FILE_HITS" | tr '\n' ' ')"
fi

# 2. Schema refs — snake_case.snake_case (table_name.column_name style)
SCHEMA_HITS=$(echo "$LAST_TEXT" | grep -oE '\b[a-z]{2,}(_[a-z0-9]+)+\.[a-z_][a-z0-9_]+\b' | sort -u | head -5 || true)
if [ -n "$SCHEMA_HITS" ]; then
  VIOLATIONS="${VIOLATIONS}
* Schema refs: $(echo "$SCHEMA_HITS" | tr '\n' ' ')"
fi

# 3. Backticked code identifiers — `sendEmail()`, `createOffer`, `email_tracking`
BACKTICK_HITS=$(echo "$LAST_TEXT" | grep -oE '`[a-zA-Z_][a-zA-Z0-9_]*(\(\))?`' | sort -u | head -5 || true)
if [ -n "$BACKTICK_HITS" ]; then
  VIOLATIONS="${VIOLATIONS}
* Backticked identifiers: $(echo "$BACKTICK_HITS" | tr '\n' ' ')"
fi

# 4. Commit hashes — lowercase hex of length 7-40 in engineering contexts
# Heuristic: "commit <hex>" (case-insensitive), "<hex> (", or `<hex>`
COMMIT_HITS=$(echo "$LAST_TEXT" | grep -oEi 'commit[s]?[: ]+[a-f0-9]{7,40}|[a-f0-9]{7,12}[[:space:]]+\(|`[a-f0-9]{7,40}`' | sort -u | head -3 || true)
if [ -n "$COMMIT_HITS" ]; then
  VIOLATIONS="${VIOLATIONS}
* Commit hashes: $(echo "$COMMIT_HITS" | tr '\n' ' ')"
fi

# 5. file:line refs — route.ts:42, foo.py:101
LINEREF_HITS=$(echo "$LAST_TEXT" | grep -oE '[a-zA-Z0-9_\-\.]+\.(ts|tsx|jsx?|py|sql|sh|rb|go|rs):[0-9]+' | sort -u | head -5 || true)
if [ -n "$LINEREF_HITS" ]; then
  VIOLATIONS="${VIOLATIONS}
* file:line refs: $(echo "$LINEREF_HITS" | tr '\n' ' ')"
fi

if [ -n "$VIOLATIONS" ]; then
  cat <<EOF
R095_VIOLATION=true
Deterministic regex scan of your last reply found engineering jargon Antonio asked you NOT to put in user-facing text:
$VIOLATIONS

REWRITE that reply in plain English. Strip:
  - File paths with code extensions
  - Schema references (table.column)
  - Backticked code identifiers
  - Commit hashes
  - file:line references

Plain-English translation is what reaches Antonio; the engineering details stay in your internal reasoning. If he asks for the citation, paste it then.
EOF
else
  echo "R095_CHECK=clean"
fi

exit 0
