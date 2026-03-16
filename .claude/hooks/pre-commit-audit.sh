#!/usr/bin/env bash
# Pre-commit audit hook — checks code quality rules before committing
# Called as a Claude Code hook, NOT a git hook
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_DIR"

ERRORS=0
WARNINGS=0

# Get list of staged files
STAGED=$(git diff --cached --name-only --diff-filter=ACM 2>/dev/null || echo "")
if [ -z "$STAGED" ]; then
  echo "✅ No staged files to audit"
  exit 0
fi

echo "🔍 Pre-commit audit..."

# Rule 1: useSearchParams must have Suspense wrapper in same file
for f in $(echo "$STAGED" | grep -E "\.tsx$" || true); do
  if [ -f "$f" ] && grep -q "useSearchParams" "$f" && ! grep -q "Suspense" "$f"; then
    echo "❌ $f: useSearchParams without Suspense wrapper"
    ERRORS=$((ERRORS + 1))
  fi
done

# Rule 2: MCP tools that send email should use safeSend
for f in $(echo "$STAGED" | grep -E "lib/mcp/tools/.*\.ts$" || true); do
  if [ -f "$f" ] && grep -q "gmailPost\|postmarkPost\|sendEmail" "$f" && ! grep -q "safeSend" "$f"; then
    echo "⚠️ $f: sends email but doesn't use safeSend pattern"
    WARNINGS=$((WARNINGS + 1))
  fi
done

# Rule 3: No debug/test comments
for f in $(echo "$STAGED" | grep -E "\.(ts|tsx)$" || true); do
  if [ -f "$f" ] && grep -nE "// test conflict|// TODO.*remove|// HACK|console\.log.*DEBUG" "$f" | head -3; then
    echo "⚠️ $f: contains debug/test comments"
    WARNINGS=$((WARNINGS + 1))
  fi
done

# Rule 4: vercel.json cron paths must have matching route files
if echo "$STAGED" | grep -q "vercel.json"; then
  CRON_PATHS=$(python3 -c "
import json, sys
try:
  with open('vercel.json') as f:
    d = json.load(f)
  for c in d.get('crons', []):
    print(c.get('path',''))
except: pass
" 2>/dev/null || echo "")
  for p in $CRON_PATHS; do
    ROUTE_DIR="app${p}"
    if [ ! -f "${ROUTE_DIR}/route.ts" ] && [ ! -f "${ROUTE_DIR}/route.js" ]; then
      echo "❌ vercel.json cron path ${p} has no route file at ${ROUTE_DIR}/route.ts"
      ERRORS=$((ERRORS + 1))
    fi
  done
fi

# Rule 5: No git add -A or git add . in hooks/scripts
for f in $(echo "$STAGED" | grep -E "\.sh$" || true); do
  if [ -f "$f" ] && grep -qE "git add -A|git add \." "$f"; then
    echo "❌ $f: contains 'git add -A' or 'git add .' — use specific file paths"
    ERRORS=$((ERRORS + 1))
  fi
done

# Rule 6: Check for accidental secret patterns
for f in $(echo "$STAGED" | grep -E "\.(ts|tsx|js)$" || true); do
  if [ -f "$f" ] && grep -nE "(sk-[a-zA-Z0-9]{20,}|AKIA[A-Z0-9]{16}|ghp_[a-zA-Z0-9]{36})" "$f" | head -1; then
    echo "❌ $f: possible hardcoded secret detected"
    ERRORS=$((ERRORS + 1))
  fi
done

# Summary
if [ $ERRORS -gt 0 ]; then
  echo ""
  echo "🔴 AUDIT FAILED: $ERRORS error(s), $WARNINGS warning(s). Fix before committing."
elif [ $WARNINGS -gt 0 ]; then
  echo "🟡 AUDIT PASSED with $WARNINGS warning(s). Review before pushing."
else
  echo "✅ Audit passed — no issues found."
fi

exit 0
