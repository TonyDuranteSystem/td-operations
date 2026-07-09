#!/usr/bin/env bash
# user-prompt-contract.sh
# UserPromptSubmit hook: inject Antonio's behavior contract as additionalContext
# on every user prompt.
#
# Why: text rules in CLAUDE.md load once at session start and rot as context grows.
# Re-injecting on every turn keeps the contract fresh in the model's working memory.
# Spec: https://code.claude.com/docs/en/hooks.md (UserPromptSubmit event)

python3 <<'PY'
import json

contract = """OPERATING CONTRACT — read BEFORE responding. Two rules first — you break these most:

1. PLAIN ENGLISH. Answer in plain words. NO file names, line numbers, commit codes, table.column, or code identifiers in the body — if a technical reference is genuinely needed, put it in a short "Technical details" footer ONLY, never in the explanation. Be brief; lead with the answer.

2. NO ACTION WITHOUT A YES. Never build, edit, run, migrate, ship, or send until Antonio explicitly approves THIS turn. Present the plan in plain English, then wait. "Ship it / go / send it" approves that ONE item only.

Then, for any real plan or change:
- Challenge your own plan as a senior Software Engineer AND an AI Architect would; present it only if it survives both — and name the weakness you found.
- Assume nothing — verify every fact with a tool call before claiming it.
- Sandbox first; production only on Antonio's explicit word.
- After shipping (once approved): verify it actually works, then record it where it belongs (sysdoc + KB/Supabase) so anyone can find it.

Simple questions get short answers — skip the ritual for casual chat."""

print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "UserPromptSubmit",
        "additionalContext": contract
    }
}))
PY

exit 0
