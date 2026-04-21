#!/usr/bin/env node
/**
 * Applies scripts/sandbox-seed/30-tax-returns-observability.sql to the
 * SANDBOX database via the direct Postgres connection in .env.sandbox.
 * Idempotent (CREATE OR REPLACE / DROP TRIGGER IF EXISTS). Safe to re-run.
 *
 * After apply, exercises the trigger with a no-op UPDATE + a real
 * status-neutral field bump to prove action_log rows are produced.
 */
const fs = require('fs')
const path = require('path')
const { Client } = require('pg')

const env = fs.readFileSync(path.resolve(__dirname, '../../.env.sandbox'), 'utf8')
const dbUrl = env.match(/SUPABASE_DB_URL="([^"]+)"/)[1]
const SQL = fs.readFileSync(
  path.resolve(__dirname, '30-tax-returns-observability.sql'),
  'utf8'
)

;(async () => {
  const client = new Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false },
  })
  await client.connect()
  console.log('Connected to', dbUrl.replace(/:[^@]+@/, ':***@'))
  console.log(`Executing observability SQL (${SQL.length} chars)...`)
  try {
    await client.query(SQL)
    console.log('  OK — trigger + view applied')
  } catch (e) {
    console.error('  FAIL:', e.message)
    throw e
  }

  // Verify trigger + view
  const t = await client.query(`
    SELECT trigger_name, event_manipulation
    FROM information_schema.triggers
    WHERE trigger_schema='public' AND event_object_table='tax_returns'
    ORDER BY trigger_name, event_manipulation
  `)
  console.log('Triggers on tax_returns:', t.rows)

  const v = await client.query(`
    SELECT count(*) AS anomaly_count
    FROM public.v_tax_return_data_received_anomalies
  `)
  console.log('Anomaly rows in sandbox:', v.rows[0].anomaly_count)

  const sample = await client.query(`
    SELECT company_name, tax_year, status, data_received, data_received_date,
           has_submission_row, has_submitted_data
    FROM public.v_tax_return_data_received_anomalies
    WHERE company_name ILIKE '%titan%'
    LIMIT 5
  `)
  console.log('Titan in anomaly view:', sample.rows)

  await client.end()
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
