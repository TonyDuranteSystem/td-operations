#!/usr/bin/env node
/**
 * Sandbox validation test for MMLLC Area A (backend).
 *
 * Simulates what createOffer does at the database level:
 *   1. INSERT an offer into sandbox with entity_type set to each of the three
 *      canonical values (Single Member LLC / Multi Member LLC / C-Corp Elected).
 *   2. SELECT each row back and verify entity_type round-trips correctly.
 *   3. Attempt an INSERT with a bogus entity_type to prove the enum rejects it.
 *   4. DELETE all test rows.
 *
 * This does NOT exercise the createOffer TypeScript code directly — that's
 * covered by the unit tests (mocks). This proves the schema accepts the real
 * values and the database enforces the enum constraint.
 *
 * Usage:
 *   node scripts/sandbox-seed/_test-mmllc-area-a-backend.js
 *
 * Safety: refuses to run against any non-sandbox project.
 */

require('dotenv').config({ path: '.env.sandbox' })
const { Client } = require('pg')

const TEST_TOKEN_PREFIX = 'mmllc-area-a-test-'

;(async () => {
  const c = new Client({
    connectionString: process.env.SUPABASE_DB_URL,
    ssl: { rejectUnauthorized: false },
  })
  await c.connect()

  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim()
  if (!url.includes('xjcxlmlpeywtwkhstjlw')) {
    console.error('REFUSED: not sandbox (' + url + ')')
    await c.end()
    process.exit(2)
  }

  console.log('MMLLC Area A backend sandbox test')
  console.log('==================================')

  const results = []
  const cases = [
    { label: 'Single Member LLC', value: 'Single Member LLC' },
    { label: 'Multi Member LLC', value: 'Multi Member LLC' },
    { label: 'C-Corp Elected', value: 'C-Corp Elected' },
    { label: 'null (unspecified)', value: null },
  ]

  try {
    // ─── 1. Insert valid entity_type values ───
    for (let i = 0; i < cases.length; i++) {
      const kase = cases[i]
      const token = `${TEST_TOKEN_PREFIX}${i}-${Date.now()}`

      await c.query(
        `INSERT INTO offers (token, client_name, language, offer_date, entity_type, contract_type, payment_type, services, cost_summary, view_count)
         VALUES ($1, $2, 'en', CURRENT_DATE, $3, 'formation', 'bank_transfer',
                 '[{"name":"Test","price":"$100"}]'::jsonb,
                 '[{"label":"Total","total":"$100"}]'::jsonb,
                 0)`,
        [token, `MMLLC Test ${i}`, kase.value]
      )

      const read = await c.query(
        `SELECT token, entity_type::text AS entity_type, contract_type FROM offers WHERE token = $1`,
        [token]
      )

      if (read.rows.length !== 1) {
        results.push({ case: kase.label, status: 'FAIL', reason: 'row not found after insert' })
        continue
      }

      const stored = read.rows[0].entity_type
      const expected = kase.value
      if (stored === expected) {
        results.push({ case: kase.label, status: 'PASS', stored })
      } else {
        results.push({ case: kase.label, status: 'FAIL', stored, expected })
      }
    }

    // ─── 2. Try an invalid enum value — should be rejected ───
    const badToken = `${TEST_TOKEN_PREFIX}bad-${Date.now()}`
    try {
      await c.query(
        `INSERT INTO offers (token, client_name, language, offer_date, entity_type, contract_type, payment_type, services, cost_summary, view_count)
         VALUES ($1, 'Bad Test', 'en', CURRENT_DATE, 'LLP'::company_type, 'formation', 'bank_transfer',
                 '[{"name":"Test","price":"$100"}]'::jsonb,
                 '[{"label":"Total","total":"$100"}]'::jsonb,
                 0)`,
        [badToken]
      )
      results.push({
        case: 'invalid enum "LLP"',
        status: 'FAIL',
        reason: 'enum incorrectly accepted unknown value',
      })
      // Clean up if it was accepted
      await c.query(`DELETE FROM offers WHERE token = $1`, [badToken])
    } catch (e) {
      if (/invalid input value for enum/i.test(e.message)) {
        results.push({
          case: 'invalid enum "LLP"',
          status: 'PASS',
          reason: 'enum correctly rejected unknown value',
        })
      } else {
        results.push({
          case: 'invalid enum "LLP"',
          status: 'FAIL',
          reason: 'wrong error type: ' + e.message,
        })
      }
    }

    // ─── 3. Verify backfill distribution is still intact ───
    const dist = await c.query(
      `SELECT entity_type::text AS entity_type, COUNT(*)::int AS n
       FROM offers
       WHERE token NOT LIKE $1
       GROUP BY entity_type
       ORDER BY n DESC`,
      [`${TEST_TOKEN_PREFIX}%`]
    )

    console.log('\nCurrent backfill distribution (excluding test rows):')
    for (const row of dist.rows) {
      console.log(`  ${row.entity_type || '(null)'}: ${row.n}`)
    }

    // ─── Results ───
    console.log('\nResults:')
    for (const r of results) {
      const mark = r.status === 'PASS' ? '✓' : '✗'
      console.log(`  ${mark} ${r.case}: ${r.status}${r.reason ? ' — ' + r.reason : ''}${r.stored !== undefined ? ' (stored: ' + r.stored + ')' : ''}`)
    }

    const failed = results.filter(r => r.status === 'FAIL').length
    console.log('\n' + (failed === 0 ? '✅ ALL PASS' : `❌ ${failed} FAILURE(S)`))
  } finally {
    // ─── Cleanup: delete every test row ───
    const cleanup = await c.query(
      `DELETE FROM offers WHERE token LIKE $1`,
      [`${TEST_TOKEN_PREFIX}%`]
    )
    console.log(`\nCleanup: removed ${cleanup.rowCount} test row(s).`)
    await c.end()
  }
})().catch((e) => {
  console.error('FATAL:', e.message)
  process.exit(1)
})
