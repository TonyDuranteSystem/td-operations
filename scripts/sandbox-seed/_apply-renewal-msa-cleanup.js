#!/usr/bin/env node
/**
 * Renewal MSA cleanup — Step A only (Option B per Antonio's approval 2026-05-03).
 *
 * Deletes unsigned 'draft' renewal offers that have NO contracts row attached.
 * These are leftover shells from before the annual_agreements migration
 * (dev_task f0c108f1=done) — every one has a TWIN row in annual_agreements
 * with the same token, so removing the offer shell is non-destructive.
 *
 * Skipped intentionally:
 *   - 'draft' offers with a contracts row attached (anomalies — manual review)
 *   - 'signed' / 'completed' offers (immutable historical records, FK-protected)
 *
 * The rename phase from the original plan was dropped (Option B) — the FK
 * `contracts_offer_token_fkey` in production blocks token renames, and once
 * the 2026 banner is hidden the legacy 'signed/completed' shells are
 * functionally inert anyway (2027 cron uses different tokens).
 *
 * Idempotent — safe to re-run; second run deletes 0 rows.
 *
 * Usage: node scripts/sandbox-seed/_apply-renewal-msa-cleanup.js
 */
const fs = require('fs')
const path = require('path')
const { Client } = require('pg')

const env = fs.readFileSync(path.resolve(__dirname, '../../.env.sandbox'), 'utf8')
const dbUrl = env.match(/SUPABASE_DB_URL="([^"]+)"/)[1]

const COUNT_SQL = `
  SELECT
    COUNT(*) FILTER (WHERE o.status = 'draft' AND c.id IS NULL) AS drafts_safe_to_delete,
    COUNT(*) FILTER (WHERE o.status = 'draft' AND c.id IS NOT NULL) AS drafts_with_contract_hold,
    COUNT(*) FILTER (WHERE o.status IN ('signed','completed')) AS signed_completed_kept,
    COUNT(DISTINCT o.id) AS total_renewal_offers
  FROM offers o
  LEFT JOIN contracts c ON c.offer_token = o.token
  WHERE o.contract_type = 'renewal'
`

const DELETE_SQL = `
  DELETE FROM offers
  WHERE id IN (
    SELECT o.id
    FROM offers o
    LEFT JOIN contracts c ON c.offer_token = o.token
    WHERE o.contract_type = 'renewal'
      AND o.status = 'draft'
      AND c.id IS NULL
  )
`

;(async () => {
  const c = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } })
  await c.connect()
  console.log('Connected to', dbUrl.replace(/:[^@]+@/, ':***@'))

  const before = await c.query(COUNT_SQL)
  console.log('BEFORE:', before.rows[0])

  const del = await c.query(DELETE_SQL)
  console.log(`DELETED ${del.rowCount} draft renewal offer shells`)

  const after = await c.query(COUNT_SQL)
  console.log('AFTER:', after.rows[0])

  await c.end()
  console.log('DONE.')
})().catch(e => { console.error('FAIL:', e.message); process.exit(1) })
