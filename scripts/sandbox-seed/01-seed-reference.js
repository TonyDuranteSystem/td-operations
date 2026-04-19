#!/usr/bin/env node
/**
 * Sandbox seed step 1 — reference data
 *
 * Clones from production to sandbox:
 *   - service_catalog (17 active rows)
 *   - app_settings (tax_season_paused=false + any other ops flags)
 *
 * Pipeline_stages is already seeded by PR #16 (56 rows) — we verify + skip.
 *
 * Usage: node scripts/sandbox-seed/01-seed-reference.js
 *
 * Idempotent: uses ON CONFLICT upsert semantics. Safe to re-run.
 */

const fs = require('fs')
const path = require('path')

require('dotenv').config({ path: '.env.local' })
const PROD_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const PROD_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

const sbEnv = fs.readFileSync(path.resolve(__dirname, '../../.env.sandbox'), 'utf8')
const SB_URL = sbEnv.match(/NEXT_PUBLIC_SUPABASE_URL="([^"]+)"/)[1]
const SB_KEY = sbEnv.match(/SUPABASE_SERVICE_ROLE_KEY="([^"]+)"/)[1]

function headers(key) {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  }
}

async function readAll(url, key, table, query = '') {
  const res = await fetch(`${url}/rest/v1/${table}?${query}`, { headers: headers(key) })
  if (!res.ok) throw new Error(`read ${table} failed: ${res.status} ${await res.text()}`)
  return res.json()
}

async function upsertBatch(url, key, table, rows, conflictColumn = 'id') {
  if (!rows.length) return { count: 0 }
  const h = { ...headers(key), Prefer: `resolution=merge-duplicates,return=minimal` }
  const res = await fetch(`${url}/rest/v1/${table}?on_conflict=${conflictColumn}`, {
    method: 'POST',
    headers: h,
    body: JSON.stringify(rows),
  })
  if (!res.ok) {
    throw new Error(`upsert ${table} failed: ${res.status} ${await res.text()}`)
  }
  return { count: rows.length }
}

async function main() {
  console.log('PROD:', PROD_URL)
  console.log('SANDBOX:', SB_URL)
  console.log('')

  // 1. service_catalog
  console.log('Reading service_catalog from prod...')
  const catalog = await readAll(PROD_URL, PROD_KEY, 'service_catalog', 'select=*')
  console.log(`  ${catalog.length} rows`)

  console.log('Upserting into sandbox...')
  const catalogResult = await upsertBatch(SB_URL, SB_KEY, 'service_catalog', catalog)
  console.log(`  upserted ${catalogResult.count} rows`)

  // 2. app_settings
  console.log('\nReading app_settings from prod...')
  const settings = await readAll(PROD_URL, PROD_KEY, 'app_settings', 'select=*')
  console.log(`  ${settings.length} rows`)

  console.log('Upserting into sandbox...')
  const settingsResult = await upsertBatch(SB_URL, SB_KEY, 'app_settings', settings, 'key')
  console.log(`  upserted ${settingsResult.count} rows`)

  // 3. pipeline_stages — verify, don't overwrite
  console.log('\nVerifying pipeline_stages in sandbox...')
  const sbStages = await readAll(SB_URL, SB_KEY, 'pipeline_stages', 'select=count')
  const prodStagesRes = await fetch(`${PROD_URL}/rest/v1/pipeline_stages?select=count`, {
    headers: { ...headers(PROD_KEY), Prefer: 'count=exact' },
  })
  const prodStagesCount = prodStagesRes.headers.get('content-range')?.split('/')[1]
  const sbStagesRes = await fetch(`${SB_URL}/rest/v1/pipeline_stages?select=count`, {
    headers: { ...headers(SB_KEY), Prefer: 'count=exact' },
  })
  const sbStagesCount = sbStagesRes.headers.get('content-range')?.split('/')[1]
  console.log(`  prod=${prodStagesCount}, sandbox=${sbStagesCount}`)
  if (prodStagesCount !== sbStagesCount) {
    console.log('  ⚠️  Mismatch — prod has more/fewer stages than sandbox. Investigate.')
  } else {
    console.log('  ✓ match')
  }

  console.log('\nDone.')
}

main().catch(e => { console.error(e); process.exit(1) })
