#!/usr/bin/env node
/**
 * Sandbox reconciliation — 4 clients confirmed paid via prod bank feed.
 * (Invictus Equity deferred to Phase 1 per Antonio's call — Setup Fee vocabulary needed.)
 *
 *   1. Next To Prime LLC  — CREATE Paid row ($1250, 2026-04-16, Mercury)
 *   3. Ambition Holding LLC — UPDATE paid_date 2026-02-15 -> 2026-01-16, replace note
 *   4. Unique Commerce LLC  — UPDATE Overdue -> Paid, paid_date 2026-03-11, note about INV-001272
 *   5. Maria Augusta LLC    — UPDATE paid_date to 2026-03-26, note about final invoice + $1718.60 total
 *
 * Usage:
 *   node scripts/sandbox-seed/14-bank-feed-reconcile-batch1.js           # dry run
 *   node scripts/sandbox-seed/14-bank-feed-reconcile-batch1.js --apply
 */

require('dotenv').config({ path: '.env.sandbox' });
const { Client } = require('pg');

const APPLY = process.argv.includes('--apply');

(async () => {
  const c = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();

  // Sandbox guard
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim();
  if (!url.includes('xjcxlmlpeywtwkhstjlw')) { console.error('REFUSED: not sandbox'); process.exit(2); }

  // Lookups
  const acc = await c.query(
    `SELECT id, company_name FROM accounts WHERE company_name IN
       ('Next To Prime LLC','Ambition Holding LLC','Unique Commerce LLC','Maria Augusta LLC')`
  );
  const acctByName = Object.fromEntries(acc.rows.map(r => [r.company_name, r.id]));
  console.log('accounts:', acctByName);

  // Existing payment rows for 3 updates
  const existing = await c.query(
    `SELECT p.id, a.company_name, p.status::text, p.amount, p.paid_date, p.invoice_number, p.notes
       FROM payments p JOIN accounts a ON a.id = p.account_id
      WHERE p.installment = 'Installment 1 (Jan)' AND p.year = 2026
        AND a.company_name IN ('Ambition Holding LLC','Unique Commerce LLC','Maria Augusta LLC')`
  );
  const rowByName = Object.fromEntries(existing.rows.map(r => [r.company_name, r]));
  console.log('existing rows:');
  for (const [n, r] of Object.entries(rowByName)) console.log(' ', n, 'id=' + r.id, 'status=' + r.status, 'amount=' + r.amount, 'paid_date=' + r.paid_date, 'inv=' + r.invoice_number);

  // next INV number
  const maxInv = await c.query(`SELECT MAX(invoice_number) AS m FROM payments WHERE invoice_number ~ '^INV-[0-9]+$'`);
  const nextN = parseInt((maxInv.rows[0].m || 'INV-000000').replace('INV-', ''), 10) + 1;
  const invForNextToPrime = 'INV-' + String(nextN).padStart(6, '0');
  console.log('\nnext INV:', invForNextToPrime);

  const actions = [
    { kind: 'create', company: 'Next To Prime LLC', invoice: invForNextToPrime, amount: 1250, paid_date: '2026-04-16', note: 'Matched to Mercury transaction 2026-04-16' },
    { kind: 'update_paiddate', company: 'Ambition Holding LLC', new_date: '2026-01-16', new_note: 'Matched to Mercury transaction 2026-01-16' },
    { kind: 'update_status_paiddate', company: 'Unique Commerce LLC', new_status: 'Paid', new_date: '2026-03-11', new_note: 'Matched to Mercury transaction 2026-03-11 referencing INV-001272 (pre-existing invoice)' },
    { kind: 'update_paiddate', company: 'Maria Augusta LLC', new_date: '2026-03-26', new_note: 'Final invoice. Account closes after. Matched to Mercury transaction 2026-03-26 ($1,718.60 total — included final installment + tax return + closure fee)' },
  ];

  console.log('\n---', APPLY ? 'APPLY' : 'DRY-RUN', '---');
  for (const a of actions) {
    console.log('  ' + a.kind.padEnd(28) + ' ' + a.company);
  }

  if (!APPLY) { await c.end(); return; }

  await c.query('BEGIN');
  try {
    for (const a of actions) {
      if (a.kind === 'create') {
        const accId = acctByName[a.company];
        if (!accId) throw new Error('missing account for ' + a.company);
        await c.query(
          `INSERT INTO payments
             (account_id, amount, amount_currency, period, year, installment, status,
              paid_date, description, invoice_number, notes, issue_date, is_test)
           VALUES ($1, $2, 'USD', 'January', 2026, 'Installment 1 (Jan)', 'Paid'::payment_status,
                   $3, 'First Installment 2026', $4, $5, '2026-01-01', false)`,
          [accId, a.amount, a.paid_date, a.invoice, a.note]
        );
      } else if (a.kind === 'update_paiddate') {
        const row = rowByName[a.company];
        if (!row) throw new Error('missing row for ' + a.company);
        await c.query(
          `UPDATE payments SET paid_date = $1,
             notes = CASE WHEN notes IS NULL OR notes = '' THEN $2 ELSE notes || chr(10) || $2 END,
             updated_at = now() WHERE id = $3`,
          [a.new_date, a.new_note, row.id]
        );
      } else if (a.kind === 'update_status_paiddate') {
        const row = rowByName[a.company];
        if (!row) throw new Error('missing row for ' + a.company);
        await c.query(
          `UPDATE payments SET status = $1::payment_status, paid_date = $2,
             notes = CASE WHEN notes IS NULL OR notes = '' THEN $3 ELSE notes || chr(10) || $3 END,
             updated_at = now() WHERE id = $4`,
          [a.new_status, a.new_date, a.new_note, row.id]
        );
      }
    }
    await c.query('COMMIT');
    console.log('\nApplied 1 create + 3 updates.');
  } catch (e) {
    await c.query('ROLLBACK');
    console.error('ROLLBACK — FAIL:', e.message);
    process.exit(1);
  }

  await c.end();
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
