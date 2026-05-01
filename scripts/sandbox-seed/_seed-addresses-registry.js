#!/usr/bin/env node
/**
 * Phase A3 — SS-4 Path 2 / Client Audit master plan.
 * Seeds the `addresses` registry with:
 *   - 8 canonical RA rows (parsed from lib/ra/county-from-ra-address.ts)
 *   - 1 TD office row, kind=business_legal
 *   - 1 TD office row, kind=business_mailing
 *
 * Per master plan §2 #6: provider and agent_name are NULL on seeded RA rows;
 * Antonio fills them during the audit pass.
 *
 * SANDBOX ONLY (ref xjcxlmlpeywtwkhstjlw). NEVER run against production.
 *
 * Idempotency: each row is tagged created_by='phase-a3-seed'. Re-run aborts
 * if any rows with that tag already exist — manual cleanup required to re-seed.
 *
 * Master plan: sysdoc 'client-audit-ss4-path2-master-plan' (§5 step A3)
 * Master dev task: 841ef0d6-55db-4bab-9b72-5fa8b2b3da7c
 */
const fs = require('fs')
const path = require('path')
const { Client } = require('pg')

const env = fs.readFileSync(path.resolve(__dirname, '../../.env.sandbox'), 'utf8')
const DB_URL = env.match(/SUPABASE_DB_URL="([^"]+)"/)[1]

if (!DB_URL.includes('xjcxlmlpeywtwkhstjlw')) {
  console.error('ABORT — SUPABASE_DB_URL does not contain sandbox ref xjcxlmlpeywtwkhstjlw')
  process.exit(1)
}

const SEED_TAG = 'phase-a3-seed'

// 8 canonical RA addresses. Source: lib/ra/county-from-ra-address.ts.
// agent_name + provider intentionally NULL — Antonio fills during audit.
const RA_ROWS = [
  {
    name: '30 N Gould St — Sheridan, WY',
    address_line1: '30 N Gould St', address_line2: 'STE R',
    city: 'Sheridan', state: 'WY', zip: '82801',
    county: 'Sheridan',
  },
  {
    name: '1095 Sugar View Dr — Sheridan, WY',
    address_line1: '1095 Sugar View Dr', address_line2: 'STE 500',
    city: 'Sheridan', state: 'WY', zip: '82801',
    county: 'Sheridan',
  },
  {
    name: '1507 Lampman Ct — Cheyenne, WY',
    address_line1: '1507 Lampman Ct', address_line2: null,
    city: 'Cheyenne', state: 'WY', zip: '82007',
    county: 'Laramie',
  },
  {
    name: '7901 4th St N — St. Petersburg, FL',
    address_line1: '7901 4th St N', address_line2: 'STE 300',
    city: 'St. Petersburg', state: 'FL', zip: '33702',
    county: 'Pinellas',
  },
  {
    name: '1200 S Pine Island Rd — Plantation, FL',
    address_line1: '1200 S Pine Island Rd', address_line2: 'STE 200',
    city: 'Plantation', state: 'FL', zip: '33324',
    county: 'Broward',
  },
  {
    name: '16192 Coastal Highway — Lewes, DE',
    address_line1: '16192 Coastal Highway', address_line2: null,
    city: 'Lewes', state: 'DE', zip: '19958',
    county: 'Sussex',
  },
  {
    name: '1209 Mountain Road Pl NE — Albuquerque, NM',
    address_line1: '1209 Mountain Road Pl NE', address_line2: 'STE R',
    city: 'Albuquerque', state: 'NM', zip: '87110',
    county: 'Bernalillo',
  },
  {
    name: '2929 Coors Blvd NW — Albuquerque, NM',
    address_line1: '2929 Coors Blvd NW', address_line2: 'STE 101',
    city: 'Albuquerque', state: 'NM', zip: '87120',
    county: 'Bernalillo',
  },
]

// TD's current office — seeded twice (legal + mailing).
const TD_OFFICE = {
  name: 'TD office — Largo, FL',
  address_line1: '10225 Ulmerton Rd', address_line2: '3D',
  city: 'Largo', state: 'FL', zip: '33771',
  county: 'Pinellas',
}

;(async () => {
  const client = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } })
  await client.connect()
  console.log('Connected to sandbox:', DB_URL.replace(/:[^@]+@/, ':***@'))

  // Idempotency check
  const existing = await client.query(
    `SELECT COUNT(*)::int AS n FROM addresses WHERE created_by = $1`,
    [SEED_TAG]
  )
  if (existing.rows[0].n > 0) {
    console.error(`ABORT — ${existing.rows[0].n} rows with created_by='${SEED_TAG}' already exist.`)
    console.error('To re-seed: DELETE FROM addresses WHERE created_by=\'phase-a3-seed\' first.')
    await client.end()
    process.exit(1)
  }

  // Insert 8 RA rows
  for (const r of RA_ROWS) {
    await client.query(
      `INSERT INTO addresses
         (kind, name, address_line1, address_line2, city, state, zip, country, county, is_td_provided, created_by)
       VALUES ('registered_agent', $1, $2, $3, $4, $5, $6, 'US', $7, false, $8)`,
      [r.name, r.address_line1, r.address_line2, r.city, r.state, r.zip, r.county, SEED_TAG]
    )
  }
  console.log(`OK — inserted ${RA_ROWS.length} registered_agent rows`)

  // TD office — kind=business_legal
  await client.query(
    `INSERT INTO addresses
       (kind, name, address_line1, address_line2, city, state, zip, country, county, is_td_provided, created_by)
     VALUES ('business_legal', $1, $2, $3, $4, $5, $6, 'US', $7, true, $8)`,
    [TD_OFFICE.name, TD_OFFICE.address_line1, TD_OFFICE.address_line2,
     TD_OFFICE.city, TD_OFFICE.state, TD_OFFICE.zip, TD_OFFICE.county, SEED_TAG]
  )
  console.log('OK — inserted 1 business_legal row (TD office)')

  // TD office — kind=business_mailing
  await client.query(
    `INSERT INTO addresses
       (kind, name, address_line1, address_line2, city, state, zip, country, county, is_td_provided, created_by)
     VALUES ('business_mailing', $1, $2, $3, $4, $5, $6, 'US', $7, true, $8)`,
    [TD_OFFICE.name, TD_OFFICE.address_line1, TD_OFFICE.address_line2,
     TD_OFFICE.city, TD_OFFICE.state, TD_OFFICE.zip, TD_OFFICE.county, SEED_TAG]
  )
  console.log('OK — inserted 1 business_mailing row (TD office)')

  // ── Verify ──────────────────────────────────────────────────────────────
  const rows = await client.query(
    `SELECT kind, name, address_line1, address_line2, city, state, zip, county, is_td_provided
     FROM addresses
     WHERE created_by = $1
     ORDER BY kind, name`,
    [SEED_TAG]
  )
  console.log(`\nSeeded rows (${rows.rows.length} total):`)
  console.log('-'.repeat(110))
  rows.rows.forEach(r => {
    const line2 = r.address_line2 ? ` ${r.address_line2}` : ''
    const td = r.is_td_provided ? ' [TD]' : ''
    console.log(`  ${r.kind.padEnd(18)} ${r.name.padEnd(42)} ${r.address_line1}${line2}, ${r.city} ${r.state} ${r.zip}  county=${r.county}${td}`)
  })

  const counts = await client.query(
    `SELECT kind, COUNT(*)::int AS n
     FROM addresses WHERE created_by = $1
     GROUP BY kind ORDER BY kind`,
    [SEED_TAG]
  )
  console.log('\nCounts by kind:')
  counts.rows.forEach(r => console.log(`  ${r.kind.padEnd(20)} ${r.n}`))

  await client.end()
  console.log('\n✅ Phase A3 — addresses registry seeded in sandbox.')
})().catch(e => { console.error(e); process.exit(1) })
