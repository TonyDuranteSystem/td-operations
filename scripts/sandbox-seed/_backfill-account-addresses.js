#!/usr/bin/env node
/**
 * Phase A4 — SS-4 Path 2 / Client Audit master plan.
 *
 * Backfills accounts FKs to the seeded addresses registry:
 *   - registered_agent_id           via token-match on accounts.registered_agent_address
 *                                   against the 8 canonical RA rows
 *                                   (logic mirrors lib/ra/county-from-ra-address.ts)
 *   - business_mailing_address_id   when accounts.physical_address matches the
 *                                   CURRENT TD office (10225 Ulmerton Rd, Largo FL)
 *   - business_legal_address_id     stays NULL (no historical source, per master plan §4)
 *
 * Scope: account_type='Client' AND status NOT IN ('Cancelled','Closed').
 *
 * Verified flags (legal_link_verified, mailing_link_verified, ra_link_verified)
 * are NEVER flipped here — they default false, Antonio confirms each during audit.
 *
 * Idempotent: skips accounts where the target FK is already non-NULL. Re-runs
 * safely; never overwrites a manual edit.
 *
 * SANDBOX ONLY (ref xjcxlmlpeywtwkhstjlw). NEVER run against production.
 *
 * Usage:
 *   node _backfill-account-addresses.js              # apply
 *   node _backfill-account-addresses.js --dry-run    # preview counts only
 *
 * Master plan: sysdoc 'client-audit-ss4-path2-master-plan' (§5 step A4)
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

const DRY_RUN = process.argv.includes('--dry-run')

// Token-match config for the 8 canonical RA addresses.
// Mirrors `requiredTokens` from lib/ra/county-from-ra-address.ts.
// `match` resolves the registry row by (address_line1, city, state, zip).
const RA_MATCHERS = [
  { tokens: ['30',    'gould',    'sheridan'],     line1: '30 N Gould St',           city: 'Sheridan',       state: 'WY', zip: '82801' },
  { tokens: ['1095',  'sugar',    'sheridan'],     line1: '1095 Sugar View Dr',      city: 'Sheridan',       state: 'WY', zip: '82801' },
  { tokens: ['1507',  'lampman',  'cheyenne'],     line1: '1507 Lampman Ct',         city: 'Cheyenne',       state: 'WY', zip: '82007' },
  { tokens: ['7901',  'petersburg'],               line1: '7901 4th St N',           city: 'St. Petersburg', state: 'FL', zip: '33702' },
  { tokens: ['1200',  'plantation'],               line1: '1200 S Pine Island Rd',   city: 'Plantation',     state: 'FL', zip: '33324' },
  { tokens: ['16192', 'lewes'],                    line1: '16192 Coastal Highway',   city: 'Lewes',          state: 'DE', zip: '19958' },
  { tokens: ['1209',  'mountain', 'albuquerque'],  line1: '1209 Mountain Road Pl NE', city: 'Albuquerque',   state: 'NM', zip: '87110' },
  { tokens: ['2929',  'coors',    'albuquerque'],  line1: '2929 Coors Blvd NW',      city: 'Albuquerque',    state: 'NM', zip: '87120' },
]

// TD current office (Ulmerton). Matches the seeded business_mailing row.
const TD_MAILING_TOKENS = ['10225', 'ulmerton']
const TD_MAILING_LOOKUP = { line1: '10225 Ulmerton Rd', city: 'Largo', state: 'FL', zip: '33771' }

function normalize(s) {
  if (!s) return ''
  return s
    .toLowerCase()
    .replace(/[.,/#!$%^&*;:{}=\-_`~()'"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function allTokensPresent(normalized, tokens) {
  return tokens.every(t => new RegExp(`(^|\\s)${t}(\\s|$)`).test(normalized))
}

;(async () => {
  const client = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } })
  await client.connect()
  console.log('Connected to sandbox:', DB_URL.replace(/:[^@]+@/, ':***@'))
  console.log(DRY_RUN ? 'MODE: dry-run (no writes)' : 'MODE: apply')

  // ── Resolve registry IDs ────────────────────────────────────────────────
  const raIds = {}
  for (const m of RA_MATCHERS) {
    const r = await client.query(
      `SELECT id FROM addresses
       WHERE kind='registered_agent' AND address_line1=$1 AND city=$2 AND state=$3 AND zip=$4`,
      [m.line1, m.city, m.state, m.zip]
    )
    if (r.rows.length !== 1) {
      console.error(`ABORT — expected 1 registry row for RA ${m.line1}, got ${r.rows.length}`)
      await client.end()
      process.exit(1)
    }
    raIds[m.line1] = r.rows[0].id
  }
  const mailingRow = await client.query(
    `SELECT id FROM addresses
     WHERE kind='business_mailing' AND address_line1=$1 AND city=$2 AND state=$3 AND zip=$4`,
    [TD_MAILING_LOOKUP.line1, TD_MAILING_LOOKUP.city, TD_MAILING_LOOKUP.state, TD_MAILING_LOOKUP.zip]
  )
  if (mailingRow.rows.length !== 1) {
    console.error(`ABORT — expected 1 registry row for TD mailing, got ${mailingRow.rows.length}`)
    await client.end()
    process.exit(1)
  }
  const tdMailingId = mailingRow.rows[0].id
  console.log(`Resolved 8 RA registry ids + TD mailing id (${tdMailingId})`)

  // ── Load candidate accounts ─────────────────────────────────────────────
  const accts = await client.query(`
    SELECT id, company_name, registered_agent_address, physical_address,
           registered_agent_id, business_mailing_address_id
    FROM accounts
    WHERE account_type = 'Client'
      AND status NOT IN ('Cancelled','Closed')
  `)
  console.log(`Loaded ${accts.rows.length} active Client accounts`)

  // ── Plan changes ────────────────────────────────────────────────────────
  const raPlanned = []        // { acct_id, ra_id, source_text, matched_line1 }
  const mailingPlanned = []   // { acct_id, mailing_id, source_text }
  let raSkippedAlreadySet = 0
  let raSkippedNoMatch = 0
  let raSkippedNoSource = 0
  let mailingSkippedAlreadySet = 0
  let mailingSkippedNoMatch = 0
  let mailingSkippedNoSource = 0

  for (const a of accts.rows) {
    // RA
    if (a.registered_agent_id) {
      raSkippedAlreadySet++
    } else if (!a.registered_agent_address || !a.registered_agent_address.trim()) {
      raSkippedNoSource++
    } else {
      const norm = normalize(a.registered_agent_address)
      const m = RA_MATCHERS.find(mm => allTokensPresent(norm, mm.tokens))
      if (m) {
        raPlanned.push({ acct_id: a.id, ra_id: raIds[m.line1], source_text: a.registered_agent_address, matched_line1: m.line1 })
      } else {
        raSkippedNoMatch++
      }
    }
    // Mailing
    if (a.business_mailing_address_id) {
      mailingSkippedAlreadySet++
    } else if (!a.physical_address || !a.physical_address.trim()) {
      mailingSkippedNoSource++
    } else {
      const norm = normalize(a.physical_address)
      if (allTokensPresent(norm, TD_MAILING_TOKENS)) {
        mailingPlanned.push({ acct_id: a.id, mailing_id: tdMailingId, source_text: a.physical_address })
      } else {
        mailingSkippedNoMatch++
      }
    }
  }

  console.log('\n── RA backfill plan ──')
  console.log(`  to update:           ${raPlanned.length}`)
  console.log(`  skip — already set:  ${raSkippedAlreadySet}`)
  console.log(`  skip — no source:    ${raSkippedNoSource}`)
  console.log(`  skip — no match:     ${raSkippedNoMatch}`)

  // Per-canonical RA breakdown
  const byRA = {}
  raPlanned.forEach(p => { byRA[p.matched_line1] = (byRA[p.matched_line1] || 0) + 1 })
  Object.entries(byRA).sort((a,b) => b[1]-a[1]).forEach(([line1, n]) =>
    console.log(`    ${String(n).padStart(4)}  ${line1}`)
  )

  console.log('\n── Mailing backfill plan ──')
  console.log(`  to update:           ${mailingPlanned.length}  (TD Ulmerton)`)
  console.log(`  skip — already set:  ${mailingSkippedAlreadySet}`)
  console.log(`  skip — no source:    ${mailingSkippedNoSource}`)
  console.log(`  skip — no match:     ${mailingSkippedNoMatch}  (non-Ulmerton mailing — left NULL for manual audit)`)

  if (DRY_RUN) {
    console.log('\nDry-run — no writes performed.')
    await client.end()
    return
  }

  // ── Apply in a transaction ──────────────────────────────────────────────
  await client.query('BEGIN')
  try {
    for (const p of raPlanned) {
      await client.query(
        `UPDATE accounts SET registered_agent_id = $1
         WHERE id = $2 AND registered_agent_id IS NULL`,
        [p.ra_id, p.acct_id]
      )
    }
    for (const p of mailingPlanned) {
      await client.query(
        `UPDATE accounts SET business_mailing_address_id = $1
         WHERE id = $2 AND business_mailing_address_id IS NULL`,
        [p.mailing_id, p.acct_id]
      )
    }
    await client.query('COMMIT')
    console.log(`\nApplied: ${raPlanned.length} RA links + ${mailingPlanned.length} mailing links.`)
  } catch (e) {
    await client.query('ROLLBACK')
    console.error('ROLLBACK on error:', e.message)
    await client.end()
    process.exit(1)
  }

  // ── Verify final state ──────────────────────────────────────────────────
  const finalCounts = await client.query(`
    SELECT
      COUNT(*)                                                         AS total_active,
      COUNT(registered_agent_id)                                       AS ra_linked,
      COUNT(business_mailing_address_id)                               AS mailing_linked,
      COUNT(business_legal_address_id)                                 AS legal_linked,
      SUM(CASE WHEN ra_link_verified THEN 1 ELSE 0 END)::int           AS ra_verified,
      SUM(CASE WHEN mailing_link_verified THEN 1 ELSE 0 END)::int      AS mailing_verified,
      SUM(CASE WHEN legal_link_verified THEN 1 ELSE 0 END)::int        AS legal_verified
    FROM accounts
    WHERE account_type='Client' AND status NOT IN ('Cancelled','Closed')
  `)
  const f = finalCounts.rows[0]
  console.log('\n── Final state (active Client accounts) ──')
  console.log(`  total                    ${f.total_active}`)
  console.log(`  registered_agent_id      ${f.ra_linked} linked / ${f.ra_verified} verified`)
  console.log(`  business_mailing_address_id  ${f.mailing_linked} linked / ${f.mailing_verified} verified`)
  console.log(`  business_legal_address_id    ${f.legal_linked} linked / ${f.legal_verified} verified  (expected 0 — manual)`)

  await client.end()
  console.log('\n✅ Phase A4 — backfill complete in sandbox.')
})().catch(e => { console.error(e); process.exit(1) })
