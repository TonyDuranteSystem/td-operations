#!/usr/bin/env bash
# r095-gate.sh — Stop hook shim for the R095 (Present Plainly) blocking gate.
# Thin shim: hand the Stop-hook stdin JSON to the Python implementation, which
# regex-scans the reply body and emits {"decision":"block"} when it carries
# raw technical references (file paths, table.column, commit hashes, code
# identifiers) outside a "Technical details" footer.
#
# HISTORY: the original bash implementation detected the same tokens but
# printed advisory stdout with exit 0 — which a Stop hook silently discards —
# so it never forced a rewrite (dev job ef39fe73). All logic now lives in
# r095_gate.py: deterministic regex (no model call), fail-open, span-dedup,
# footer/code-fence exclusions, kill switch R095_GATE_OFF=1.
INPUT=$(cat)
printf '%s' "$INPUT" | python3 "$(dirname "$0")/r095_gate.py" 2>/dev/null
exit 0
