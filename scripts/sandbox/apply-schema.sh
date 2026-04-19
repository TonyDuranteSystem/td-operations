#!/bin/bash
# ============================================================
# TD Operations - Sandbox Schema Apply Script
# Usage: ./apply-schema.sh <sandbox-db-password>
#
# Pre-requisite: brew install libpq (adds psql/pg_dump to PATH)
# OR: set SANDBOX_DB_URL to full connection string
# ============================================================
set -euo pipefail

SANDBOX_REF="xjcxlmlpeywtwkhstjlw"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Get DB password
if [[ -n "${SANDBOX_DB_URL:-}" ]]; then
  DB_URL="$SANDBOX_DB_URL"
elif [[ -n "${1:-}" ]]; then
  DB_PASSWORD="$1"
  DB_URL="postgresql://postgres.${SANDBOX_REF}:${DB_PASSWORD}@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require"
else
  echo "Usage: $0 <sandbox-db-password>"
  echo "   or: SANDBOX_DB_URL=postgresql://... $0"
  echo ""
  echo "Get password from: Supabase Dashboard → Project Settings → Database → Connection string"
  exit 1
fi

export PATH="/opt/homebrew/opt/libpq/bin:$PATH"

echo "=== Step 1: Apply schema (120 tables, 26 enums) ==="
psql "$DB_URL" -f "$SCRIPT_DIR/01-schema.sql" 2>&1 | grep -E "ERROR|CREATE|DO" | head -50
echo ""

echo "=== Step 2: Seed reference data (326 rows) ==="
psql "$DB_URL" -f "$SCRIPT_DIR/02-seed-data.sql" 2>&1 | tail -5
echo ""

echo "=== Step 3: Insert test data ==="
psql "$DB_URL" -f "$SCRIPT_DIR/03-test-data.sql" 2>&1 | tail -5
echo ""

echo "=== Step 4: Verify ==="
psql "$DB_URL" -c "
SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'public' 
ORDER BY table_name 
LIMIT 10;
"
echo ""

echo "Done! Sandbox schema applied."
echo ""
echo "Next: Create auth users in Supabase Dashboard → Authentication → Users:"
echo "  Admin:  sandbox.admin@test.internal / TDsandbox-admin-2026!"
echo "  Client: sandbox.client@test.internal / TDsandbox-client-2026!"
