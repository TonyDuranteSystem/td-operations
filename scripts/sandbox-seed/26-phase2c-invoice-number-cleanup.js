#!/usr/bin/env node
/**
 * Phase 2c — Invoice-number cleanup + uniqueness guardrail (sandbox).
 *
 * Scope (Antonio-approved, session 2026-04-20 evening):
 *
 *  A. NULL the invoice_number on 19 suffix-scar rows in payments
 *     (invoice_number matching `INV-NNNNNN-XXXXXXXX` — April-12 fallback-generator
 *     artifacts on the Whop-batch paid invoices). Rows are PRESERVED — they
 *     represent real client payments with real money, real client_expenses
 *     portal mirrors, and real contract linkages. Only the broken invoice-number
 *     string is blanked.
 *
 *  B. NULL the invoice_number on:
 *     - 6 plain-plain collision rows (INV-001332 ×2, INV-001373 ×2, INV-001378 ×2)
 *     - 13 legacy rows all labeled "1.0" (pre-unification leftovers per session-context)
 *     Same treatment — preserve rows, blank the invoice_number only.
 *
 *  C. ADD partial unique index on payments.invoice_number WHERE invoice_number IS NOT NULL.
 *  D. ADD partial unique index on client_invoices.invoice_number WHERE invoice_number IS NOT NULL.
 *
 * No row deletions. Preserves the accounting ledger, contract invoice linkages,
 * client_expenses mirrors. Everything executes in ONE transaction.
 * Rollback on any error. Sandbox only.
 *
 * Usage:
 *   node scripts/sandbox-seed/26-phase2c-invoice-number-cleanup.js           # dry-run
 *   node scripts/sandbox-seed/26-phase2c-invoice-number-cleanup.js --apply   # executes
 */

require('dotenv').config({ path: '.env.sandbox' });
const { Client } = require('pg');

const APPLY = process.argv.includes('--apply');

const PLAIN_PLAIN_COLLISIONS = ['INV-001332', 'INV-001373', 'INV-001378'];
const LEGACY_VALUE = '1.0';

(async () => {
  const c = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();

  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim();
  if (!url.includes('xjcxlmlpeywtwkhstjlw')) { console.error('REFUSED: not sandbox.'); process.exit(2); }

  // PRE-STATE
  console.log('=== PRE-STATE ===');
  const pre = (await c.query(`
    SELECT 'suffix-scar' AS k, COUNT(*)::int AS n FROM payments
      WHERE invoice_number ~ '^INV-[0-9]{6}-[A-Z0-9]+$'
    UNION ALL SELECT 'plain-plain-collisions', COUNT(*)::int FROM payments
      WHERE invoice_number = ANY($1)
    UNION ALL SELECT 'legacy-1.0', COUNT(*)::int FROM payments
      WHERE invoice_number = $2
    UNION ALL SELECT 'payments-total-nonnull', COUNT(*)::int FROM payments
      WHERE invoice_number IS NOT NULL
    UNION ALL SELECT 'client_invoices-total-nonnull', COUNT(*)::int FROM client_invoices
      WHERE invoice_number IS NOT NULL
  `, [PLAIN_PLAIN_COLLISIONS, LEGACY_VALUE])).rows;
  console.table(pre);

  if (!APPLY) {
    console.log('\n--- DRY RUN — planned operations ---');
    console.log('A. UPDATE payments SET invoice_number = NULL WHERE invoice_number ~ \'^INV-[0-9]{6}-[A-Z0-9]+$\'  (expect 19 rows)');
    console.log(`B1. UPDATE payments SET invoice_number = NULL WHERE invoice_number IN (${PLAIN_PLAIN_COLLISIONS.map(v => `'${v}'`).join(', ')})  (expect 6 rows)`);
    console.log(`B2. UPDATE payments SET invoice_number = NULL WHERE invoice_number = '${LEGACY_VALUE}'  (expect 13 rows)`);
    console.log('C. CREATE UNIQUE INDEX uq_payments_invoice_number ON payments (invoice_number) WHERE invoice_number IS NOT NULL');
    console.log('D. CREATE UNIQUE INDEX uq_client_invoices_invoice_number ON client_invoices (invoice_number) WHERE invoice_number IS NOT NULL');
    console.log('\nTotal rows touched: 38. No deletions. All rows preserved.');
    console.log('\nRerun with --apply to execute.');
    await c.end();
    return;
  }

  await c.query('BEGIN');
  try {
    // A. Null suffix-scar invoice_numbers
    const aRes = await c.query(`
      UPDATE payments SET invoice_number = NULL, updated_at = now()
      WHERE invoice_number ~ '^INV-[0-9]{6}-[A-Z0-9]+$'
      RETURNING id
    `);
    console.log(`\nA. Nulled invoice_number on ${aRes.rows.length} suffix-scar rows`);
    if (aRes.rows.length !== 19) throw new Error(`Expected 19, got ${aRes.rows.length} — aborting`);

    // B1. Null plain-plain collision invoice_numbers
    const b1Res = await c.query(`
      UPDATE payments SET invoice_number = NULL, updated_at = now()
      WHERE invoice_number = ANY($1)
      RETURNING id
    `, [PLAIN_PLAIN_COLLISIONS]);
    console.log(`B1. Nulled invoice_number on ${b1Res.rows.length} plain-plain collision rows`);
    if (b1Res.rows.length !== 6) throw new Error(`Expected 6, got ${b1Res.rows.length} — aborting`);

    // B2. Null legacy "1.0" rows
    const b2Res = await c.query(`
      UPDATE payments SET invoice_number = NULL, updated_at = now()
      WHERE invoice_number = $1
      RETURNING id
    `, [LEGACY_VALUE]);
    console.log(`B2. Nulled invoice_number on ${b2Res.rows.length} legacy "1.0" rows`);
    if (b2Res.rows.length !== 13) throw new Error(`Expected 13, got ${b2Res.rows.length} — aborting`);

    // C. Unique partial index on payments
    await c.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_invoice_number
        ON payments (invoice_number) WHERE invoice_number IS NOT NULL
    `);
    console.log(`C. Created unique partial index on payments.invoice_number`);

    // D. Unique partial index on client_invoices
    await c.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_client_invoices_invoice_number
        ON client_invoices (invoice_number) WHERE invoice_number IS NOT NULL
    `);
    console.log(`D. Created unique partial index on client_invoices.invoice_number`);

    await c.query('COMMIT');
    console.log('\nCOMMIT — all done.');

    // POST-STATE
    console.log('\n=== POST-STATE ===');
    const post = (await c.query(`
      SELECT 'suffix-scar' AS k, COUNT(*)::int AS n FROM payments
        WHERE invoice_number ~ '^INV-[0-9]{6}-[A-Z0-9]+$'
      UNION ALL SELECT 'plain-plain-collisions', COUNT(*)::int FROM payments
        WHERE invoice_number = ANY($1)
      UNION ALL SELECT 'legacy-1.0', COUNT(*)::int FROM payments
        WHERE invoice_number = $2
      UNION ALL SELECT 'payments-total-nonnull', COUNT(*)::int FROM payments
        WHERE invoice_number IS NOT NULL
      UNION ALL SELECT 'payments-total-rows', COUNT(*)::int FROM payments
      UNION ALL SELECT 'client_invoices-total-nonnull', COUNT(*)::int FROM client_invoices
        WHERE invoice_number IS NOT NULL
    `, [PLAIN_PLAIN_COLLISIONS, LEGACY_VALUE])).rows;
    console.table(post);

    const idxCheck = (await c.query(`
      SELECT indexname, tablename
      FROM pg_indexes
      WHERE indexname IN ('uq_payments_invoice_number', 'uq_client_invoices_invoice_number')
    `)).rows;
    console.log('Unique indexes now in place:');
    console.table(idxCheck);
  } catch (e) {
    await c.query('ROLLBACK');
    console.error('\nROLLBACK — FAIL:', e.message);
    process.exit(1);
  }

  await c.end();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
