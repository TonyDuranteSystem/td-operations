#!/usr/bin/env node
/**
 * Phase A1 — SS-4 Path 2 / Client Audit master plan.
 * Creates `addresses` registry table + adds 3 FK columns + 3 verified flags
 * to `accounts`. SANDBOX ONLY.
 *
 * TARGET: sandbox DB (ref xjcxlmlpeywtwkhstjlw)
 * NEVER run against production.
 *
 * Idempotent — safe to re-run.
 *
 * Master plan: sysdoc 'client-audit-ss4-path2-master-plan' (§3.1 + §3.2)
 * Master dev task: 841ef0d6-55db-4bab-9b72-5fa8b2b3da7c
 */
const fs = require('fs')
const path = require('path')
const { Client } = require('pg')

const env = fs.readFileSync(path.resolve(__dirname, '../../.env.sandbox'), 'utf8')
const DB_URL = env.match(/SUPABASE_DB_URL="([^"]+)"/)[1]

if (!DB_URL.includes('xjcxlmlpeywtwkhstjlw')) {
  console.error('ABORT — SUPABASE_DB_URL does not contain sandbox ref xjcxlmlpeywtwkhstjlw')
  console.error('This script must only run against sandbox.')
  process.exit(1)
}

const SQL = `
-- ── addresses registry ────────────────────────────────────────────────────
-- One row per real-world address used as Registered Agent, Business Legal,
-- or Business Mailing. Three kinds via CHECK constraint.
CREATE TABLE IF NOT EXISTS addresses (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            TEXT        NOT NULL,
  name            TEXT        NOT NULL,
  provider        TEXT,
  agent_name      TEXT,
  address_line1   TEXT        NOT NULL,
  address_line2   TEXT,
  city            TEXT        NOT NULL,
  state           TEXT        NOT NULL,
  zip             TEXT        NOT NULL,
  country         TEXT        NOT NULL    DEFAULT 'US',
  county          TEXT,
  is_td_provided  BOOLEAN     NOT NULL    DEFAULT false,
  notes           TEXT,
  active          BOOLEAN     NOT NULL    DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL    DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL    DEFAULT now(),
  created_by      TEXT,
  CONSTRAINT addresses_kind_check
    CHECK (kind IN ('business_legal','business_mailing','registered_agent'))
);

-- Dropdown lookup index
CREATE INDEX IF NOT EXISTS addresses_kind_active_name_idx
  ON addresses (kind, active, name);

-- Dropdown sort: TD-provided first, then alphabetic
CREATE INDEX IF NOT EXISTS addresses_kind_active_td_name_idx
  ON addresses (kind, active, is_td_provided DESC, name);

-- ── RLS ───────────────────────────────────────────────────────────────────
ALTER TABLE addresses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_all" ON addresses;
DROP POLICY IF EXISTS "staff_select"     ON addresses;

CREATE POLICY "service_role_all" ON addresses
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "staff_select" ON addresses
  FOR SELECT USING (
    auth.role() = 'authenticated' AND
    (auth.jwt() -> 'app_metadata' ->> 'role') <> 'client'
  );

-- ── accounts: 3 FKs + 3 verified flags ────────────────────────────────────
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS business_legal_address_id    UUID REFERENCES addresses(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS business_mailing_address_id  UUID REFERENCES addresses(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS registered_agent_id          UUID REFERENCES addresses(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS legal_link_verified          BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS mailing_link_verified        BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ra_link_verified             BOOLEAN NOT NULL DEFAULT false;
`

;(async () => {
  const client = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } })
  await client.connect()
  console.log('Connected to sandbox:', DB_URL.replace(/:[^@]+@/, ':***@'))

  try {
    await client.query(SQL)
    console.log('OK — addresses table, indexes, RLS, accounts columns applied')
  } catch (e) {
    console.error('FAIL:', e.message)
    await client.end()
    process.exit(1)
  }

  // ── Verify addresses columns ────────────────────────────────────────────
  const cols = await client.query(`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'addresses'
    ORDER BY ordinal_position
  `)
  console.log('\naddresses columns:')
  cols.rows.forEach(r =>
    console.log(`  ${r.column_name.padEnd(20)} ${r.data_type.padEnd(28)} nullable=${r.is_nullable}  default=${r.column_default ?? ''}`)
  )

  // ── Verify addresses constraints ────────────────────────────────────────
  const constraints = await client.query(`
    SELECT constraint_name, constraint_type
    FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'addresses'
    ORDER BY constraint_name
  `)
  console.log('\naddresses constraints:')
  constraints.rows.forEach(r => console.log(`  ${r.constraint_name} (${r.constraint_type})`))

  // ── Verify addresses indexes ────────────────────────────────────────────
  const indexes = await client.query(`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE tablename = 'addresses'
    ORDER BY indexname
  `)
  console.log('\naddresses indexes:')
  indexes.rows.forEach(r => console.log(`  ${r.indexname}\n    ${r.indexdef}`))

  // ── Verify addresses RLS policies ───────────────────────────────────────
  const policies = await client.query(`
    SELECT policyname, cmd
    FROM pg_policies
    WHERE tablename = 'addresses'
    ORDER BY policyname
  `)
  console.log('\naddresses RLS policies:')
  policies.rows.forEach(r => console.log(`  ${r.policyname} (${r.cmd})`))

  const rlsOn = await client.query(`
    SELECT relrowsecurity
    FROM pg_class
    WHERE relname = 'addresses' AND relnamespace = 'public'::regnamespace
  `)
  console.log(`addresses RLS enabled: ${rlsOn.rows[0]?.relrowsecurity}`)

  // ── Verify accounts new columns ─────────────────────────────────────────
  const acctCols = await client.query(`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'accounts'
      AND column_name IN (
        'business_legal_address_id',
        'business_mailing_address_id',
        'registered_agent_id',
        'legal_link_verified',
        'mailing_link_verified',
        'ra_link_verified'
      )
    ORDER BY column_name
  `)
  console.log('\naccounts new columns:')
  acctCols.rows.forEach(r =>
    console.log(`  ${r.column_name.padEnd(32)} ${r.data_type.padEnd(10)} nullable=${r.is_nullable}  default=${r.column_default ?? ''}`)
  )

  // ── Verify accounts FK constraints ──────────────────────────────────────
  const fks = await client.query(`
    SELECT
      tc.constraint_name,
      kcu.column_name,
      ccu.table_name  AS references_table,
      ccu.column_name AS references_column,
      rc.delete_rule
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name
    JOIN information_schema.referential_constraints rc
      ON tc.constraint_name = rc.constraint_name
    WHERE tc.table_schema = 'public'
      AND tc.table_name   = 'accounts'
      AND tc.constraint_type = 'FOREIGN KEY'
      AND kcu.column_name IN (
        'business_legal_address_id',
        'business_mailing_address_id',
        'registered_agent_id'
      )
    ORDER BY kcu.column_name
  `)
  console.log('\naccounts FK constraints:')
  fks.rows.forEach(r =>
    console.log(`  ${r.column_name} → ${r.references_table}.${r.references_column}  ON DELETE ${r.delete_rule}  (${r.constraint_name})`)
  )

  await client.end()
  console.log('\n✅ Phase A1 — addresses registry + accounts FKs applied to sandbox.')
})().catch(e => { console.error(e); process.exit(1) })
