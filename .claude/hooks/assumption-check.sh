#!/bin/bash
# assumption-check.sh
# Stop hook: Reminds Claude to verify claims have citations.
# This runs after every response to enforce the zero-assumptions policy.

# Always output the reminder — the prompt hook will evaluate
cat <<'CHECK'
⚠️ ASSUMPTION CHECK — Review your last response:
1. Did you make any technical claim about how the system works?
2. Did you cite file+line, table+column, or tool output for EACH claim?
3. Did you say "the system does X" without reading the code first?
4. Did you assume a tool/feature/table exists without verifying?
5. Did you explain WHY something failed without reading the error source?

If ANY answer is YES without a citation → you MUST correct yourself NOW.
Say: "I stated X without verifying. Let me check the code." Then verify.

ZERO ASSUMPTIONS. Cite or correct.
CHECK

exit 0
