#!/usr/bin/env node
/**
 * Phase 1 — Creates audit_flags table in SANDBOX ONLY.
 * Idempotent — safe to re-run.
 *
 * TARGET: sandbox DB (ref xjcxlmlpeywtwkhstjlw)
 * NEVER run against production.
 *
 * What this applies:
 *   - audit_flags table (entity_type, entity_id, field_name, flag_type, note, ...)
 *   - Two indexes (entity lookup + active-flags partial index)
 *   - RLS enabled + two policies (service_role_all, staff_select)
 */
const fs = require('fs')
const path = require('path')
const { Client } = require('pg')

const env = fs.readFileSync(path.resolve(__dirname, '../../.env.sandbox'), 'utf8')
const URL = env.match(/SUPABASE_DB_URL="([^"]+)"/)[1]

// Hard safety check — confirm this is the sandbox ref
if (!URL.includes('xjcxlmlpeywtwkhstjlw')) {
  console.error('ABORT — SUPABASE_DB_URL does not contain sandbox ref xjcxlmlpeywtwkhstjlw')
  console.error('This script must only run against sandbox.')
  process.exit(1)
}

const SQL = `
-- ── audit_flags table ─────────────────────────────────────────────────────
-- Current-state table: one active row per (entity_type, entity_id, field_name, flag_type).
-- History lives in action_log, not here.
CREATE TABLE IF NOT EXISTS audit_flags (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type   TEXT        NOT NULL,
  entity_id     UUID        NOT NULL,
  field_name    TEXT        NOT NULL,
  flag_type     TEXT        NOT NULL,
  note          TEXT,
  marked_by     TEXT        NOT NULL,
  marked_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  reversed_by   TEXT,
  reversed_at   TIMESTAMPTZ,
  CONSTRAINT audit_flags_entity_type_check
    CHECK (entity_type IN ('account', 'contact', 'service')),
  CONSTRAINT audit_flags_flag_type_check
    CHECK (flag_type IN ('na', 'follow_up')),
  CONSTRAINT audit_flags_note_required_for_na
    CHECK (flag_type <> 'na' OR (note IS NOT NULL AND trim(note) <> '')),
  CONSTRAINT audit_flags_unique_active_flag
    UNIQUE (entity_type, entity_id, field_name, flag_type)
);

-- Entity lookup index
CREATE INDEX IF NOT EXISTS audit_flags_entity_idx
  ON audit_flags (entity_type, entity_id);

-- Active-flags partial index (reversed_at IS NULL = active)
CREATE INDEX IF NOT EXISTS audit_flags_reversed_idx
  ON audit_flags (entity_type, entity_id)
  WHERE reversed_at IS NULL;

-- ── RLS ───────────────────────────────────────────────────────────────────
ALTER TABLE audit_flags ENABLE ROW LEVEL SECURITY;

-- Drop existing policies (idempotent re-run)
DROP POLICY IF EXISTS "service_role_all" ON audit_flags;
DROP POLICY IF EXISTS "staff_select"     ON audit_flags;

-- Service role: full access — all server routes use supabaseAdmin (service_role)
CREATE POLICY "service_role_all" ON audit_flags
  FOR ALL USING (auth.role() = 'service_role');

-- Staff (authenticated, non-client): SELECT only — defense in depth.
-- Primary access control: middleware blocks portal clients from /clients/* routes.
CREATE POLICY "staff_select" ON audit_flags
  FOR SELECT USING (
    auth.role() = 'authenticated' AND
    (auth.jwt() -> 'app_metadata' ->> 'role') <> 'client'
  );
`

;(async () => {
  const client = new Client({ connectionString: URL, ssl: { rejectUnauthorized: false } })
  await client.connect()
  console.log('Connected to sandbox:', URL.replace(/:[^@]+@/, ':***@'))

  try {
    await client.query(SQL)
    console.log('OK — audit_flags table, indexes, RLS applied')
  } catch (e) {
    console.error('FAIL:', e.message)
    await client.end()
    process.exit(1)
  }

  // ── Verify columns ──────────────────────────────────────────────────────
  const cols = await client.query(`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'audit_flags'
    ORDER BY ordinal_position
  `)
  console.log('\naudit_flags columns:')
  cols.rows.forEach(r =>
    console.log(`  ${r.column_name.padEnd(16)} ${r.data_type.padEnd(20)} nullable=${r.is_nullable}`)
  )

  // ── Verify constraints ──────────────────────────────────────────────────
  const constraints = await client.query(`
    SELECT constraint_name, constraint_type
    FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'audit_flags'
    ORDER BY constraint_name
  `)
  console.log('\naudit_flags constraints:')
  constraints.rows.forEach(r => console.log(`  ${r.constraint_name} (${r.constraint_type})`))

  // ── Verify indexes ──────────────────────────────────────────────────────
  const indexes = await client.query(`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE tablename = 'audit_flags'
    ORDER BY indexname
  `)
  console.log('\naudit_flags indexes:')
  indexes.rows.forEach(r => console.log(`  ${r.indexname}`))

  // ── Verify RLS policies ─────────────────────────────────────────────────
  const policies = await client.query(`
    SELECT polname, polcmd
    FROM pg_policies
    WHERE tablename = 'audit_flags'
    ORDER BY polname
  `)
  console.log('\naudit_flags RLS policies:')
  policies.rows.forEach(r => console.log(`  ${r.polname} (${r.polcmd})`))

  await client.end()
  console.log('\n✅ Sandbox Phase 1 audit_flags schema applied and verified.')
})()
