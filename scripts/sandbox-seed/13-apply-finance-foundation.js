#!/usr/bin/env node
/**
 * Finance foundation sync — sandbox only.
 *
 * Inputs:
 *   /tmp/finance-match-final.json  — 170 managed clients matched to sandbox accounts
 *   /tmp/finance-full-plan.json    — classification (create / soft update / leave)
 *
 * Rules (agreed with Antonio 2026-04-20):
 *   - 92 creates for accounts that have NO existing 2026 Installment 1 (Jan) row
 *   - 11 soft updates (overwrite) where existing sandbox row has NO real-money evidence
 *     (no stripe_payment_id, whop_payment_id, payment_method, paid_by_name)
 *   - QB invoice id + portal invoice id are NOT payment evidence
 *   - Partner Alliance LLC: keep existing $2000, add note (combined payment)
 *   - Morgan & Taylor International LLC: status Waived→Paid, add note linking to Partner Alliance
 *   - Currency USD, period January, year 2026
 *   - Paid: status=Paid, paid_date=2026-02-15, foundation-sync note
 *   - Overdue: status=Overdue, due_date=2026-01-31
 *   - Invoice numbers: sequential INV-###### starting at next available in sandbox
 *
 * Usage:
 *   node scripts/sandbox-seed/13-apply-finance-foundation.js           # dry run
 *   node scripts/sandbox-seed/13-apply-finance-foundation.js --apply
 */

require('dotenv').config({ path: '.env.sandbox' });
const { Client } = require('pg');
const fs = require('fs');

const APPLY = process.argv.includes('--apply');
const FOUND_NOTE = 'Foundation sync 2026-04-20 — placeholder paid_date, to be reconciled against bank feed';
const PAID_DATE = '2026-02-15';
const DUE_DATE = '2026-01-31';

const YBR = 'YBR Consulting LLC'; // excluded

const PARTNER_ALLIANCE_NAME = 'Partner Alliance LLC';
const MORGAN_TAYLOR_NAME = 'Morgan & Taylor International LLC';

(async () => {
  const c = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();

  // Sandbox guard
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim();
  const ref = (process.env.EXPECTED_SUPABASE_REF || '').trim();
  if (!url.includes('xjcxlmlpeywtwkhstjlw') || ref !== 'xjcxlmlpeywtwkhstjlw') {
    console.error('REFUSED: not pointed at sandbox.'); process.exit(2);
  }

  const match = JSON.parse(fs.readFileSync('/tmp/finance-match-final.json', 'utf8'));
  const workingSet = match.matched.filter(m => m.sandbox_name !== YBR);

  // pull fresh existing rows + classify real-matched vs soft
  const ids = workingSet.map(m => m.sandbox_account_id);
  const existing = await c.query(
    `SELECT id, account_id, status::text AS status, amount, invoice_number,
            stripe_payment_id, whop_payment_id, payment_method, paid_by_name, notes
       FROM payments
      WHERE installment = 'Installment 1 (Jan)' AND year = 2026
        AND account_id = ANY($1::uuid[])`,
    [ids]
  );
  const byAcct = new Map(existing.rows.map(r => [r.account_id, r]));

  const isReal = (r) => !!(r.stripe_payment_id || r.whop_payment_id || r.payment_method || r.paid_by_name);

  const toCreate = [];
  const toUpdate = [];
  const leaveAlone = [];
  const noOp = [];

  for (const m of workingSet) {
    const e = byAcct.get(m.sandbox_account_id);
    const desiredStatus = m.paid_status === 'paid' ? 'Paid' : 'Overdue';
    if (!e) {
      // CREATE
      if (m.amount == null) {
        // Skip creates with null amount (not-NULL constraint). Surface as leaveAlone-ish.
        leaveAlone.push({ reason: 'null amount in file, cannot create', company: m.sandbox_name });
        continue;
      }
      toCreate.push({
        account_id: m.sandbox_account_id,
        company: m.sandbox_name,
        amount: m.amount,
        status: desiredStatus,
      });
      continue;
    }
    if (isReal(e)) { leaveAlone.push({ reason: 'real payment evidence', company: m.sandbox_name }); continue; }

    // Soft row — decide update vs no-op
    const wantStatus = desiredStatus;
    let wantAmount = null;
    let addNote = null;
    let statusChange = e.status !== wantStatus;
    let amountChange = false;

    // Partner Alliance exception: never overwrite amount; add combined-payment note
    if (m.sandbox_name === PARTNER_ALLIANCE_NAME) {
      statusChange = false; // leave whatever status is there alone for this one
      addNote = '$2000 paid by Rodrigo Di Lauro — covers $1000 for Partner Alliance + $1000 for Morgan & Taylor International';
    } else if (m.sandbox_name === MORGAN_TAYLOR_NAME) {
      addNote = 'Paid via combined $2000 transaction on Partner Alliance LLC (same owner Rodrigo Di Lauro)';
    } else if (m.amount != null && Number(e.amount) !== Number(m.amount)) {
      wantAmount = m.amount;
      amountChange = true;
    }

    if (statusChange || amountChange || addNote) {
      toUpdate.push({
        payment_id: e.id,
        company: m.sandbox_name,
        status_change: statusChange ? [e.status, wantStatus] : null,
        amount_change: amountChange ? [e.amount, wantAmount] : null,
        note: addNote,
        file_paid_status: m.paid_status,
      });
    } else {
      noOp.push(m.sandbox_name);
    }
  }

  // Assign INV numbers to creates in deterministic order (by company name)
  const maxInv = await c.query(`SELECT MAX(invoice_number) AS m FROM payments WHERE invoice_number ~ '^INV-[0-9]+$'`);
  const nextN = parseInt((maxInv.rows[0].m || 'INV-000000').replace('INV-', ''), 10) + 1;
  toCreate.sort((a, b) => a.company.localeCompare(b.company));
  for (let i = 0; i < toCreate.length; i++) toCreate[i].invoice_number = 'INV-' + String(nextN + i).padStart(6, '0');

  console.log(APPLY ? 'APPLY' : 'DRY-RUN');
  console.log('============================================');
  console.log(`create      : ${toCreate.length}`);
  console.log(`update      : ${toUpdate.length}`);
  console.log(`leave alone : ${leaveAlone.length}`);
  console.log(`no-op       : ${noOp.length}`);
  console.log(`next INV    : ${toCreate[0]?.invoice_number || '(none)'} .. ${toCreate[toCreate.length - 1]?.invoice_number || '(none)'}`);
  console.log();

  if (!APPLY) {
    console.log('--- sample creates (first 10 of ' + toCreate.length + ') ---');
    for (const x of toCreate.slice(0, 10)) {
      console.log(`  ${x.invoice_number}  ${x.company.padEnd(40)}  $${x.amount}  ${x.status}`);
    }
    console.log();
    console.log('--- updates ---');
    for (const u of toUpdate) {
      const parts = [];
      if (u.status_change) parts.push('status ' + u.status_change[0] + ' -> ' + u.status_change[1]);
      if (u.amount_change) parts.push('amount ' + u.amount_change[0] + ' -> ' + u.amount_change[1]);
      if (u.note) parts.push('note++');
      console.log(`  ${u.company.padEnd(42)} ${parts.join(' | ')}`);
    }
    console.log();
    console.log('Dry run. Re-run with --apply to write.');
  } else {
    // APPLY MODE
    await c.query('BEGIN');
    try {
      // inserts
      for (const x of toCreate) {
        const isPaid = x.status === 'Paid';
        await c.query(
          `INSERT INTO payments
             (account_id, amount, amount_currency, period, year, installment, status,
              paid_date, due_date, description, invoice_number, notes, issue_date, is_test)
           VALUES ($1, $2, 'USD', 'January', 2026, 'Installment 1 (Jan)', $3::payment_status,
                   $4, $5, 'First Installment 2026', $6, $7, '2026-01-01', false)`,
          [
            x.account_id, x.amount, x.status,
            isPaid ? PAID_DATE : null,
            isPaid ? null : DUE_DATE,
            x.invoice_number,
            FOUND_NOTE,
          ]
        );
      }

      for (const u of toUpdate) {
        const sets = [];
        const vals = [];
        if (u.status_change) { sets.push('status = $' + (vals.length + 1) + '::payment_status'); vals.push(u.status_change[1]); }
        if (u.amount_change) { sets.push('amount = $' + (vals.length + 1)); vals.push(u.amount_change[1]); }
        if (u.note) {
          sets.push("notes = CASE WHEN notes IS NULL OR notes = '' THEN $" + (vals.length + 1) + " ELSE notes || chr(10) || $" + (vals.length + 1) + " END");
          vals.push(u.note);
        }
        sets.push('updated_at = now()');
        vals.push(u.payment_id);
        await c.query(`UPDATE payments SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
      }
      await c.query('COMMIT');
      console.log(`Applied ${toCreate.length} creates + ${toUpdate.length} updates.`);
    } catch (e) {
      await c.query('ROLLBACK');
      console.error('ROLLBACK — FAIL:', e.message);
      process.exit(1);
    }
  }

  await c.end();
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
