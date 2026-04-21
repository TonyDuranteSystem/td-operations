#!/usr/bin/env node
/**
 * Phase 2 area 3 — TARGETED FIXES (Antonio-approved).
 *
 * Scope of this script is NOT the full area 3 backfill (deferred to the
 * post-build case review). It applies only the two fixes Antonio explicitly
 * approved/directed in session 2026-04-20 evening:
 *
 *  A. Xecom Consulting LLC — apply clean setup fee data:
 *     accounts.setup_fee_amount        = 2350
 *     accounts.setup_fee_paid_date     = 2026-04-12
 *     accounts.setup_fee_currency      = 'USD'
 *     accounts.services_bundle_detail  = verbatim contracts.selected_services
 *     Source: contract 815bec79 (offer gabriele-sartori-2026),
 *             payment 7122db2c (INV-002040-MNWDW48T, $2350 Whop, paid 2026-04-12).
 *
 *  B. ATCOACHING LLC — fix string-concat corruption on the signed contract:
 *     contracts.annual_fee  '2.5001' -> '2500'
 *     (contract c12f7c76, offer antonio-truocchio-2026).
 *     Root cause documented separately: see investigation notes in refactor plan
 *     sysdoc — bug in app/offer/[token]/contract/page.tsx lines 480-492
 *     (parseFloat on multi-dot European prices + label-keyword fallback mis-assigns).
 *     Phase 3 fixes the bug itself.
 *
 * Usage:
 *   node scripts/sandbox-seed/25-phase2c-targeted-fixes.js           # dry-run
 *   node scripts/sandbox-seed/25-phase2c-targeted-fixes.js --apply   # executes
 */

require('dotenv').config({ path: '.env.sandbox' });
const { Client } = require('pg');

const APPLY = process.argv.includes('--apply');

const XECOM_ACCOUNT_ID = '89d13729-1714-4244-b124-c5372b926297';
const XECOM_CONTRACT_ID = '815bec79-b9e8-4410-9bc7-d5fb79819bea';
const ATCOACHING_CONTRACT_ID = 'c12f7c76-c3b5-4be7-9bb5-8d46b984c24c';

(async () => {
  const c = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();

  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim();
  if (!url.includes('xjcxlmlpeywtwkhstjlw')) { console.error('REFUSED: not sandbox.'); process.exit(2); }

  // Pre-read current state
  const pre = await c.query(`
    SELECT 'xecom_account' AS k, jsonb_build_object(
      'setup_fee_amount', setup_fee_amount,
      'setup_fee_paid_date', setup_fee_paid_date,
      'setup_fee_currency', setup_fee_currency,
      'services_bundle_detail', services_bundle_detail IS NOT NULL
    ) AS v FROM accounts WHERE id = $1
    UNION ALL
    SELECT 'atcoaching_contract', jsonb_build_object(
      'annual_fee', annual_fee,
      'installments', installments
    ) FROM contracts WHERE id = $2
  `, [XECOM_ACCOUNT_ID, ATCOACHING_CONTRACT_ID]);
  console.log('PRE-STATE:');
  for (const r of pre.rows) console.log(`  ${r.k}:`, JSON.stringify(r.v));

  // Pull Xecom's bundle source-of-truth
  const bundleSrc = await c.query(`SELECT selected_services FROM contracts WHERE id = $1`, [XECOM_CONTRACT_ID]);
  const xecomBundle = bundleSrc.rows[0].selected_services;
  console.log(`\nXecom bundle source: contract ${XECOM_CONTRACT_ID} — ${Array.isArray(xecomBundle) ? xecomBundle.length : '?'} items`);

  if (!APPLY) {
    console.log('\n--- DRY RUN — planned writes ---');
    console.log('A. accounts (Xecom Consulting LLC):');
    console.log(`   setup_fee_amount = 2350`);
    console.log(`   setup_fee_paid_date = 2026-04-12`);
    console.log(`   setup_fee_currency = USD`);
    console.log(`   services_bundle_detail = <${Array.isArray(xecomBundle) ? xecomBundle.length : 0}-item JSONB array from contract>`);
    console.log('B. contracts (ATCOACHING / antonio-truocchio-2026):');
    console.log(`   annual_fee = '2500'  (was '2.5001')`);
    console.log('\nRerun with --apply to execute.');
    await c.end();
    return;
  }

  await c.query('BEGIN');
  try {
    // A. Xecom
    const a = await c.query(`
      UPDATE accounts SET
        setup_fee_amount = 2350,
        setup_fee_paid_date = '2026-04-12',
        setup_fee_currency = 'USD',
        services_bundle_detail = $1::jsonb,
        updated_at = now()
      WHERE id = $2
      RETURNING setup_fee_amount, setup_fee_paid_date, setup_fee_currency::text, services_bundle_detail IS NOT NULL AS sbd_set
    `, [JSON.stringify(xecomBundle), XECOM_ACCOUNT_ID]);
    console.log('\nA. Xecom updated:', a.rows[0]);

    // B. ATCOACHING
    const b = await c.query(`
      UPDATE contracts SET
        annual_fee = '2500',
        updated_at = now()
      WHERE id = $1
      RETURNING id, annual_fee, installments
    `, [ATCOACHING_CONTRACT_ID]);
    console.log('B. ATCOACHING contract updated:', b.rows[0]);

    await c.query('COMMIT');
    console.log('\nCOMMIT — done.');
  } catch (e) {
    await c.query('ROLLBACK');
    console.error('\nROLLBACK — FAIL:', e.message);
    process.exit(1);
  }

  await c.end();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
