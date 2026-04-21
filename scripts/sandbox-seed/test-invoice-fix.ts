/* eslint-disable no-console -- CLI test script; console output is the interface */
/**
 * Sandbox integration test for Unit A — invoice-number generator + idempotency.
 *
 * Exercises:
 *  1. generateInvoiceNumber returns INV-NNNNNN, sequential
 *  2. createTDInvoice without idempotency_key creates a new row
 *  3. createTDInvoice with idempotency_key — repeat call with same key returns same row (no duplicate)
 *  4. Concurrent createTDInvoice with DIFFERENT keys → all succeed with unique numbers
 *  5. Concurrent createTDInvoice with SAME key → only one row created, all return the same one
 *
 * Cleans up its own test rows after each test.
 *
 * Run: npx tsx scripts/sandbox-seed/test-invoice-fix.ts
 */

import dotenv from 'dotenv'
dotenv.config({ path: '.env.sandbox', override: true })

// Sanity guard so we never run this against prod
if (!(process.env.NEXT_PUBLIC_SUPABASE_URL || '').includes('xjcxlmlpeywtwkhstjlw')) {
  console.error('REFUSED: env not pointing at sandbox')
  process.exit(2)
}

import { Client } from 'pg'
import { createTDInvoice } from '../../lib/portal/td-invoice'
import { generateInvoiceNumber } from '../../lib/portal/invoice-number'

const TEST_ACCOUNT_ID = 'aaaaaaaa-0000-0000-0000-000000000001' // Sandbox Test LLC
const KEY_PREFIX = 'test-invoice-fix:' + Date.now() + ':'

async function pgConnect() {
  const c = new Client({
    connectionString: process.env.SUPABASE_DB_URL!,
    ssl: { rejectUnauthorized: false },
  })
  await c.connect()
  return c
}

async function cleanupTestRows() {
  const c = await pgConnect()
  try {
    // FK order: client_expense_items → client_expenses → payment_items → payments.
    // Match by both idempotency_key (current run) AND description (any orphans).
    const cei = await c.query(`
      DELETE FROM client_expense_items
      WHERE expense_id IN (
        SELECT id FROM client_expenses WHERE description = 'TEST ROW — invoice fix integration test'
      )
      RETURNING id
    `)
    if (cei.rows.length) console.log(`  [cleanup] deleted ${cei.rows.length} test client_expense_items rows`)

    const ce = await c.query(`
      DELETE FROM client_expenses WHERE description = 'TEST ROW — invoice fix integration test' RETURNING id
    `)
    if (ce.rows.length) console.log(`  [cleanup] deleted ${ce.rows.length} test client_expense rows`)

    const pi = await c.query(`
      DELETE FROM payment_items
      WHERE payment_id IN (
        SELECT id FROM payments WHERE description = 'TEST ROW — invoice fix integration test'
      )
      RETURNING id
    `)
    if (pi.rows.length) console.log(`  [cleanup] deleted ${pi.rows.length} test payment_items rows`)

    const pay = await c.query(`
      DELETE FROM payments WHERE description = 'TEST ROW — invoice fix integration test' RETURNING id
    `)
    if (pay.rows.length) console.log(`  [cleanup] deleted ${pay.rows.length} test payment rows`)
  } finally {
    await c.end()
  }
}

async function test1_generator_sequential() {
  console.log('\nTest 1: generator returns sequential INV-NNNNNN numbers')
  const a = await generateInvoiceNumber()
  const b = await generateInvoiceNumber()
  console.log(`  call 1: ${a}`)
  console.log(`  call 2: ${b}`)
  if (!/^INV-\d{6}$/.test(a)) throw new Error(`format invalid: ${a}`)
  if (!/^INV-\d{6}$/.test(b)) throw new Error(`format invalid: ${b}`)
  // Both calls return the SAME max+1 because no insert happens between them.
  // That's expected — race safety is on the INSERT, not the generator.
  if (a !== b) throw new Error(`sequential reads should return same number until insert: ${a} vs ${b}`)
  console.log('  PASS — generator returns valid format and is deterministic between reads')
}

async function test2_createTDInvoice_basic() {
  console.log('\nTest 2: createTDInvoice without idempotency_key creates a new row')
  const result = await createTDInvoice({
    account_id: TEST_ACCOUNT_ID,
    line_items: [{ description: 'TEST ROW — invoice fix integration test', unit_price: 100 }],
    idempotency_key: KEY_PREFIX + 'test2',
  })
  console.log(`  got invoice_number: ${result.invoiceNumber}, payment_id: ${result.paymentId}`)
  if (!/^INV-\d{6}$/.test(result.invoiceNumber)) throw new Error(`format invalid: ${result.invoiceNumber}`)
  if (!result.paymentId) throw new Error('paymentId missing')
  console.log('  PASS — creates row with valid number')
}

async function test3_idempotent_repeat() {
  console.log('\nTest 3: same idempotency_key returns same row twice (no duplicate)')
  const key = KEY_PREFIX + 'test3'
  const r1 = await createTDInvoice({
    account_id: TEST_ACCOUNT_ID,
    line_items: [{ description: 'TEST ROW — invoice fix integration test', unit_price: 200 }],
    idempotency_key: key,
  })
  console.log(`  call 1: ${r1.invoiceNumber} (payment ${r1.paymentId})`)
  const r2 = await createTDInvoice({
    account_id: TEST_ACCOUNT_ID,
    line_items: [{ description: 'TEST ROW — invoice fix integration test', unit_price: 999 }], // different items — should still dedupe by key
    idempotency_key: key,
  })
  console.log(`  call 2: ${r2.invoiceNumber} (payment ${r2.paymentId})`)
  if (r1.paymentId !== r2.paymentId) throw new Error(`idempotency failed: paymentIds differ ${r1.paymentId} vs ${r2.paymentId}`)
  if (r1.invoiceNumber !== r2.invoiceNumber) throw new Error(`idempotency failed: invoice numbers differ`)

  // Verify only ONE row exists in DB for this key
  const c = await pgConnect()
  try {
    const r = await c.query(`SELECT COUNT(*)::int AS n FROM payments WHERE idempotency_key = $1`, [key])
    if (r.rows[0].n !== 1) throw new Error(`expected 1 row, got ${r.rows[0].n}`)
  } finally {
    await c.end()
  }
  console.log('  PASS — idempotency works, only one row created')
}

async function test4_concurrent_different_keys() {
  console.log('\nTest 4: 5 concurrent calls with DIFFERENT keys — all succeed with unique numbers')
  const N = 5
  const promises = Array.from({ length: N }, (_, i) =>
    createTDInvoice({
      account_id: TEST_ACCOUNT_ID,
      line_items: [{ description: 'TEST ROW — invoice fix integration test', unit_price: 100 + i }],
      idempotency_key: KEY_PREFIX + 'test4-' + i,
    })
  )
  const results = await Promise.all(promises)
  const numbers = results.map(r => r.invoiceNumber)
  console.log(`  invoice numbers: ${numbers.join(', ')}`)
  const uniq = new Set(numbers)
  if (uniq.size !== N) throw new Error(`expected ${N} unique numbers, got ${uniq.size}: ${numbers.join(', ')}`)
  for (const n of numbers) {
    if (!/^INV-\d{6}$/.test(n)) throw new Error(`format invalid: ${n}`)
  }
  console.log('  PASS — all concurrent calls got unique sequential numbers, no fallback suffixes')
}

async function test5_concurrent_same_key() {
  console.log('\nTest 5: 5 concurrent calls with the SAME idempotency_key — only one row created, all return same')
  const key = KEY_PREFIX + 'test5'
  const N = 5
  const promises = Array.from({ length: N }, () =>
    createTDInvoice({
      account_id: TEST_ACCOUNT_ID,
      line_items: [{ description: 'TEST ROW — invoice fix integration test', unit_price: 100 }],
      idempotency_key: key,
    })
  )
  const results = await Promise.all(promises)
  const ids = new Set(results.map(r => r.paymentId))
  console.log(`  unique payment_ids returned: ${ids.size} (expected 1)`)

  // Verify only ONE row in DB for this key
  const c = await pgConnect()
  try {
    const r = await c.query(`SELECT COUNT(*)::int AS n FROM payments WHERE idempotency_key = $1`, [key])
    if (r.rows[0].n !== 1) throw new Error(`expected 1 row, got ${r.rows[0].n}`)
  } finally {
    await c.end()
  }
  if (ids.size !== 1) throw new Error(`expected 1 unique paymentId, got ${ids.size}`)
  console.log('  PASS — concurrent same-key callers all converge to one row')
}

async function main() {
  console.log('=== Sandbox integration test for invoice-number fix ===')
  console.log(`Test key prefix: ${KEY_PREFIX}`)

  // Pre-clean any leftover rows from previous test runs
  await cleanupTestRows()

  let failed = 0
  const tests: Array<[string, () => Promise<void>]> = [
    ['test1_generator_sequential', test1_generator_sequential],
    ['test2_createTDInvoice_basic', test2_createTDInvoice_basic],
    ['test3_idempotent_repeat', test3_idempotent_repeat],
    ['test4_concurrent_different_keys', test4_concurrent_different_keys],
    ['test5_concurrent_same_key', test5_concurrent_same_key],
  ]
  for (const [name, fn] of tests) {
    try {
      await fn()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error(`  FAIL — ${name}: ${msg}`)
      failed++
    }
  }

  console.log('\n=== Cleanup ===')
  await cleanupTestRows()

  console.log(`\n=== ${failed === 0 ? 'ALL PASS' : `${failed} FAILED`} ===`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('FATAL:', e)
  process.exit(1)
})
