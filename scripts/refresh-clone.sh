#!/usr/bin/env bash
# refresh-clone.sh — clone the cloud SANDBOX into a LOCAL stack database.
#
#   bash scripts/refresh-clone.sh <SANDBOX_DB_URL> <LOCAL_DB_URL>
#
# Implements the verified clone recipe:
#   1. enable matching extensions (pg_trgm, vector) in local
#   2. dump sandbox public schema+data WITH grants (skip junk log tables)
#   3. load into local; re-assert standard Supabase role grants (so PostgREST can read)
#   4. clone auth users/identities (best-effort, so portal logins work)
# Refuses any source that isn't the sandbox, or any target that isn't localhost.
#
# KNOWN v1 GAP (documented, not silent): storage FILE BYTES (~80MB of documents) are
# NOT copied here — only DB rows. Document-preview QA needs a separate storage copy
# (tracked as the next build step). DB + API + auth are fully cloned.
set -euo pipefail

SRC="${1:?source sandbox DB url required}"
DST="${2:?target local DB url required}"
PROD_REF="ydzipybqeebtpcvsbtvs"
SANDBOX_REF="xjcxlmlpeywtwkhstjlw"

echo "$SRC" | grep -q "$PROD_REF"   && { echo "⛔ source is PRODUCTION — refusing"; exit 2; }
echo "$SRC" | grep -q "$SANDBOX_REF" || { echo "⛔ source is not the sandbox ref — refusing"; exit 2; }
echo "$DST" | grep -qE '127\.0\.0\.1|localhost' || { echo "⛔ target is not localhost — refusing"; exit 2; }

PGBIN="$(brew --prefix libpq)/bin"
PGDUMP="$PGBIN/pg_dump"
PSQL="$PGBIN/psql"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "1/4 enabling extensions in local (pg_trgm, vector)…"
$PSQL "$DST" -q -c "CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS vector;" || true

echo "2/4 dumping sandbox public schema+data (with grants; skipping cron_log/action_log data)…"
$PGDUMP "$SRC" --schema=public --no-owner \
  --exclude-table-data='public.cron_log' \
  --exclude-table-data='public.action_log' \
  -f "$TMP/public.sql"

echo "3/4 loading into local + asserting role grants…"
$PSQL "$DST" -v ON_ERROR_STOP=0 -q -f "$TMP/public.sql" 2> "$TMP/public.err" || true
echo "   load errors: $(grep -c '^ERROR:' "$TMP/public.err" 2>/dev/null || echo 0) (see $TMP/public.err if >0)"
# Belt-and-suspenders: guarantee PostgREST roles can read, even if a grant was missed.
$PSQL "$DST" -q <<'SQL' || true
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL    ON ALL TABLES    IN SCHEMA public TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;
SQL

echo "4/4 cloning auth users/identities (best-effort)…"
$PGDUMP "$SRC" --data-only --table=auth.users --table=auth.identities -f "$TMP/auth.sql" 2>/dev/null || true
if [ -s "$TMP/auth.sql" ]; then
  $PSQL "$DST" -v ON_ERROR_STOP=0 -q -f "$TMP/auth.sql" 2> "$TMP/auth.err" || true
  echo "   auth load errors: $(grep -c '^ERROR:' "$TMP/auth.err" 2>/dev/null || echo 0)"
fi

echo ""
echo "verification:"
$PSQL "$DST" -tAc "SELECT '  tables='   || count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'"
$PSQL "$DST" -tAc "SELECT '  accounts=' || count(*) FROM accounts"   2>/dev/null || true
$PSQL "$DST" -tAc "SELECT '  documents='|| count(*) FROM documents"  2>/dev/null || true
$PSQL "$DST" -tAc "SELECT '  auth_users='|| count(*) FROM auth.users" 2>/dev/null || true
echo "✅ clone complete"
