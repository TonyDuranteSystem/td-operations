#!/bin/bash
# bash-production-guard.sh
# PreToolUse hook — fires before every Bash tool call Claude Code makes.
#
# Blocks these dangerous commands regardless of session state or compaction:
#   git push ... main            — must go to origin/sandbox first
#   npm run dev/build/test/unit  — blocked if .env.local has production Supabase URL
#   node scripts/                — blocked if .env.local has production Supabase URL
#   vercel deploy / vercel build — blocked if .vercel/project.json = td-operations (prod)
#
# Override for explicit production push (Antonio must set this in the same command):
#   ALLOW_PRODUCTION_PUSH_AFTER_SANDBOX_QA=1 git push origin main

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('command',''))" 2>/dev/null || echo "")

if [ -z "$COMMAND" ]; then
  exit 0
fi

PROD_REF="ydzipybqeebtpcvsbtvs"
PROD_PROJECT="td-operations"

# ── Block: git push to main ────────────────────────────────────────────────
# Catches: git push origin main, git push origin/main, any variant with "main" as target
if echo "$COMMAND" | grep -qE 'git push.+\bmain\b'; then
  if [ "${ALLOW_PRODUCTION_PUSH_AFTER_SANDBOX_QA}" = "1" ]; then
    exit 0
  fi
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"BLOCKED: git push to main is not allowed. All work must go to origin/sandbox first. When Antonio explicitly approves a production push, use: ALLOW_PRODUCTION_PUSH_AFTER_SANDBOX_QA=1 git push origin main"}}'
  exit 0
fi

# ── Block: running code/scripts against production Supabase ───────────────
if echo "$COMMAND" | grep -qE '(npm run (dev|build|test|unit|e2e)|node scripts/)'; then
  if [ -f ".env.local" ]; then
    SUPABASE_URL=$(grep 'NEXT_PUBLIC_SUPABASE_URL' .env.local | head -1 | sed 's/.*"\(.*\)".*/\1/')
    if echo "$SUPABASE_URL" | grep -q "$PROD_REF"; then
      echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"BLOCKED: .env.local is connected to PRODUCTION Supabase (ydzipybqeebtpcvsbtvs). Running code against production is forbidden. Fix now: bash scripts/dev-setup.sh"}}'
      exit 0
    fi
  fi
fi

# ── Block: vercel deploy/build against production project ─────────────────
if echo "$COMMAND" | grep -qE 'vercel (deploy|build)'; then
  if [ -f ".vercel/project.json" ]; then
    PROJECT=$(python3 -c "import json; print(json.load(open('.vercel/project.json')).get('projectName',''))" 2>/dev/null || echo "")
    if [ "$PROJECT" = "$PROD_PROJECT" ]; then
      echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"BLOCKED: vercel deploy/build is linked to PRODUCTION project (td-operations). Fix now: bash scripts/dev-setup.sh"}}'
      exit 0
    fi
  fi
fi

exit 0
