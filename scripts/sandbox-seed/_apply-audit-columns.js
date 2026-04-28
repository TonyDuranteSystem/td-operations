#!/usr/bin/env node
/**
 * Adds audit tracking columns to accounts and contacts in SANDBOX.
 * Idempotent — safe to re-run.
 *
 * Columns added:
 *   accounts.audit_reviewed_by  TEXT         — "Antonio" or "Luca"
 *   accounts.audit_sections     JSONB        — per-section completion flags
 *   contacts.itin               TEXT         — ITIN number (if collected)
 *   accounts.setup_fee_date     DATE         — date setup fee was collected
 *   accounts.setup_fee_invoice  TEXT         — invoice number for setup fee
 *   accounts.audit_reviewed_at  TIMESTAMPTZ  — when reviewed (already exists in prod)
 *   accounts.audit_flag         BOOLEAN      — flagged for follow-up
 *   accounts.onboarding_date    DATE         — TD start date (MSA signed date)
 */
const fs = require('fs')
const path = require('path')
const { Client } = require('pg')

const env = fs.readFileSync(path.resolve(__dirname, '../../.env.sandbox'), 'utf8')
const URL = env.match(/SUPABASE_DB_URL="([^"]+)"/)[1]

const SQL = `
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS audit_reviewed_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS audit_flag         BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS audit_reviewed_by  TEXT,
  ADD COLUMN IF NOT EXISTS audit_sections     JSONB DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS onboarding_date    DATE,
  ADD COLUMN IF NOT EXISTS setup_fee_date     DATE,
  ADD COLUMN IF NOT EXISTS setup_fee_invoice  TEXT;

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS itin TEXT;
`

;(async () => {
  const client = new Client({ connectionString: URL, ssl: { rejectUnauthorized: false } })
  await client.connect()
  console.log('Connected to', URL.replace(/:[^@]+@/, ':***@'))
  try {
    await client.query(SQL)
    console.log('OK — audit columns applied')
  } catch (e) {
    console.error('FAIL:', e.message)
    throw e
  }

  const v = await client.query(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'accounts'
      AND column_name IN (
        'audit_reviewed_at','audit_flag','audit_reviewed_by',
        'audit_sections','onboarding_date','setup_fee_date','setup_fee_invoice'
      )
    ORDER BY column_name
  `)
  console.log('\nAccounts audit columns:', v.rows.map(r => `${r.column_name}(${r.data_type})`).join(', '))

  const c = await client.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='contacts' AND column_name='itin'
  `)
  console.log('Contacts itin:', c.rows.length ? 'EXISTS' : 'MISSING')

  await client.end()
})().catch(e => { console.error(e); process.exit(1) })
