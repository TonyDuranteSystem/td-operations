#!/usr/bin/env bash
# r093-verifier.sh — Stop hook wrapper for the independent R093 verifier.
# Thin shim: hand the Stop-hook stdin JSON to the Python implementation, which
# launches an independent auditor model and decides whether to block the stop.
# All logic, fail-open behavior, loop-guarding, and kill switch live in the .py.
INPUT=$(cat)
printf '%s' "$INPUT" | python3 "$(dirname "$0")/r093_verifier.py" 2>/dev/null
exit 0
