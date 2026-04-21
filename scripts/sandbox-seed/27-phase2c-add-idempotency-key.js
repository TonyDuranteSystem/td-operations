#!/usr/bin/env node
/**
 * Phase 2c — Add idempotency_key column to payments + client_invoices (sandbox).
 *
 * Purpose: content-level deduplication for invoice creation. The invoice_number
 * uniqueness guardrail (script 26) prevents two rows sharing a number; the
 * idempotency_key prevents two rows being created for the same logical operation
 * (e.g. offer-signed webhook firing twice, concurrent Whop batch callers,
 * double-click on "Create Invoice").
 *
 * Adds:
 *  - payments.idempotency_key TEXT (nullable)
 *  - client_invoices.idempotency_key TEXT (nullable)
 *  - Partial unique index on each WHERE idempotency_key IS NOT NULL
 *
 * Callers that want idempotency pass a natural key (e.g. `offer-signed:TOKEN:CONTACT_ID`,
 * `annual-installments:ACCT:INSTALLMENT:YEAR`, `manual-crm:ACCT:LINE_ITEMS_HASH`).
 * Callers without a natural key leave it null and get no dedup (one-off invoices).
 *
 * Idempotent — safe to re-run.
 *
 * Usage:
 *   node scripts/sandbox-seed/27-phase2c-add-idempotency-key.js           # dry-run
 *   node scripts/sandbox-seed/27-phase2c-add-idempotency-key.js --apply   # executes
 */

require('dotenv').config({ path: '.env.sandbox' });
const { Client } = require('pg');

const APPLY = process.argv.includes('--apply');

(async () => {
  const c = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();

  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim();
  if (!url.includes('xjcxlmlpeywtwkhstjlw')) { console.error('REFUSED: not sandbox.'); process.exit(2); }

  // PRE-STATE: check columns and indexes
  console.log('=== PRE-STATE ===');
  const colCheck = (await c.query(`
    SELECT table_name, column_name, data_type
    FROM information_schema.columns
    WHERE (table_name = 'payments' OR table_name = 'client_invoices')
      AND column_name = 'idempotency_key'
    ORDER BY table_name
  `)).rows;
  console.log('Existing idempotency_key columns:', colCheck.length ? colCheck : '(none)');

  const idxCheck = (await c.query(`
    SELECT indexname, tablename FROM pg_indexes
    WHERE indexname IN ('uq_payments_idempotency_key', 'uq_client_invoices_idempotency_key')
  `)).rows;
  console.log('Existing idempotency-key indexes:', idxCheck.length ? idxCheck : '(none)');

  if (!APPLY) {
    console.log('\n--- DRY RUN — planned operations ---');
    console.log('A. ALTER TABLE payments ADD COLUMN IF NOT EXISTS idempotency_key TEXT');
    console.log('B. ALTER TABLE client_invoices ADD COLUMN IF NOT EXISTS idempotency_key TEXT');
    console.log('C. CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_idempotency_key ON payments (idempotency_key) WHERE idempotency_key IS NOT NULL');
    console.log('D. CREATE UNIQUE INDEX IF NOT EXISTS uq_client_invoices_idempotency_key ON client_invoices (idempotency_key) WHERE idempotency_key IS NOT NULL');
    console.log('\nRerun with --apply to execute.');
    await c.end();
    return;
  }

  await c.query('BEGIN');
  try {
    await c.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS idempotency_key TEXT`);
    console.log('A. payments.idempotency_key added (or already existed)');

    await c.query(`ALTER TABLE client_invoices ADD COLUMN IF NOT EXISTS idempotency_key TEXT`);
    console.log('B. client_invoices.idempotency_key added (or already existed)');

    await c.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_idempotency_key
        ON payments (idempotency_key) WHERE idempotency_key IS NOT NULL
    `);
    console.log('C. uq_payments_idempotency_key created (or already existed)');

    await c.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_client_invoices_idempotency_key
        ON client_invoices (idempotency_key) WHERE idempotency_key IS NOT NULL
    `);
    console.log('D. uq_client_invoices_idempotency_key created (or already existed)');

    await c.query('COMMIT');
    console.log('\nCOMMIT — all done.');

    // POST-STATE verification
    const postCols = (await c.query(`
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE (table_name = 'payments' OR table_name = 'client_invoices')
        AND column_name = 'idempotency_key'
      ORDER BY table_name
    `)).rows;
    console.log('\nColumns in place:');
    console.table(postCols);

    const postIdx = (await c.query(`
      SELECT indexname, tablename FROM pg_indexes
      WHERE indexname IN ('uq_payments_idempotency_key', 'uq_client_invoices_idempotency_key')
    `)).rows;
    console.log('Indexes in place:');
    console.table(postIdx);
  } catch (e) {
    await c.query('ROLLBACK');
    console.error('\nROLLBACK — FAIL:', e.message);
    process.exit(1);
  }

  await c.end();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
