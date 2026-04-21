#!/usr/bin/env node
/**
 * Phase 2 area 1 APPLY — contracts backfill + decided corrections.
 *
 * Writes:
 *  A. 5 offers: contract_type 'renewal' -> 'formation' (mis-labeled per Antonio)
 *     (tokens: renewal-ag-group-2026, renewal-mdl-advisory-llc-2026,
 *      renewal-outriders-2026, renewal-ptbt-holding-llc-2026,
 *      renewal-stay-legit-llc-2026)
 *  B. 1 contract: Valerio Siclari annual_fee '200010001000' -> '2000'
 *     (string-concat bug fix; token: valerio-siclari-2026)
 *  C. 44 contracts (non-duplicate-token): backfill contact_id,
 *     account_id, invoice_id, payment_type, selected_services per the
 *     audit logic — payment_type is DERIVED AFTER the (A) retags, so
 *     the 5 retagged rows get 'Setup Fee' not 'Installments'.
 *     For Ahmed Sayed / UC Marketing we pin contact_id to the active
 *     Feb-23 record (55447ad9-8b92-4c45-a623-887696866331).
 *  D. 13 duplicate-token rows are SKIPPED (area 6 handles those).
 *
 * All writes in ONE transaction; rollback on any error.
 * Sandbox only (EXPECTED_SUPABASE_REF enforced).
 *
 * Usage:
 *   node scripts/sandbox-seed/22-phase2a-contracts-apply.js           # dry-run (prints every write, no DB changes)
 *   node scripts/sandbox-seed/22-phase2a-contracts-apply.js --apply   # executes
 */

require('dotenv').config({ path: '.env.sandbox' });
const { Client } = require('pg');

const APPLY = process.argv.includes('--apply');

const RETAG_TOKENS = [
  'renewal-ag-group-2026',
  'renewal-mdl-advisory-llc-2026',
  'renewal-outriders-2026',
  'renewal-ptbt-holding-llc-2026',
  'renewal-stay-legit-llc-2026',
];

const VALERIO_TOKEN = 'valerio-siclari-2026';
const AHMED_UC_TOKEN = 'renewal-uc-marketing-llc-2026';
const AHMED_FEB_CONTACT_ID = '55447ad9-8b92-4c45-a623-887696866331';

// contracts.payment_type = the type of the FIRST payment this contract produces.
// A renewal contract spans two installments; the first is 'Installment 1 (Jan)'.
// The second installment gets its own row with 'Installment 2 (Jun)' in June.
const PAYMENT_TYPE_MAP = {
  formation: 'Setup Fee',
  onboarding: 'Setup Fee',
  renewal: 'Installment 1 (Jan)',
  tax_return: 'One-Time Service',
  itin: 'One-Time Service',
  custom: 'Custom',
};

(async () => {
  const c = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();

  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim();
  if (!url.includes('xjcxlmlpeywtwkhstjlw')) { console.error('REFUSED: not sandbox.'); process.exit(2); }

  // Identify duplicate-token contracts (SKIP in this pass)
  const dupTokens = new Set();
  const d = await c.query(`SELECT offer_token FROM contracts GROUP BY offer_token HAVING COUNT(*) > 1`);
  for (const row of d.rows) dupTokens.add(row.offer_token);

  // Pull contracts + offers (AFTER applying retag in-memory so payment_type derives correctly)
  const contracts = await c.query(`
    SELECT
      ct.id AS contract_id, ct.offer_token, ct.client_name, ct.client_email,
      ct.annual_fee, ct.signed_at,
      o.contract_type AS offer_contract_type, o.account_id, o.lead_id, o.services,
      l.converted_to_contact_id
    FROM contracts ct
    LEFT JOIN offers o ON o.token = ct.offer_token
    LEFT JOIN leads l ON l.id = o.lead_id
  `);

  // Preload contacts by email
  const emails = [...new Set(contracts.rows.map(r => r.client_email).filter(Boolean))];
  const byEmail = new Map();
  if (emails.length) {
    const r = await c.query(`SELECT id, email FROM contacts WHERE email = ANY($1::text[])`, [emails]);
    for (const row of r.rows) {
      const k = (row.email || '').toLowerCase();
      if (!byEmail.has(k)) byEmail.set(k, []);
      byEmail.get(k).push(row.id);
    }
  }

  // Preload candidate payments per account
  const acctIds = [...new Set(contracts.rows.map(r => r.account_id).filter(Boolean))];
  const paymentsByAcct = new Map();
  if (acctIds.length) {
    const r = await c.query(`
      SELECT id, account_id, amount, paid_date, issue_date, due_date
      FROM payments WHERE account_id = ANY($1::uuid[])
    `, [acctIds]);
    for (const row of r.rows) {
      if (!paymentsByAcct.has(row.account_id)) paymentsByAcct.set(row.account_id, []);
      paymentsByAcct.get(row.account_id).push(row);
    }
  }

  // Plan the writes for each non-duplicate contract
  const writes = [];
  for (const r of contracts.rows) {
    if (dupTokens.has(r.offer_token)) continue;

    // Derive effective contract type (after in-memory retag)
    let effectiveType = (r.offer_contract_type || '').toLowerCase();
    if (RETAG_TOKENS.includes(r.offer_token)) effectiveType = 'formation';

    const paymentType = PAYMENT_TYPE_MAP[effectiveType] || 'Custom';

    // Contact resolution
    let contactId = null;
    if (r.offer_token === AHMED_UC_TOKEN) {
      contactId = AHMED_FEB_CONTACT_ID;
    } else if (r.converted_to_contact_id) {
      contactId = r.converted_to_contact_id;
    } else if (r.client_email) {
      const matches = byEmail.get(r.client_email.toLowerCase()) || [];
      if (matches.length === 1) contactId = matches[0];
    }
    if (!contactId) continue; // skip rows without confident contact (shouldn't happen for non-dup set after manual fixes)

    // Account resolution
    const accountId = r.account_id || null;

    // Invoice match (same logic as audit — only write if confident)
    let invoiceId = null;
    if (accountId && paymentsByAcct.has(accountId)) {
      const fee = Number(r.annual_fee) || null;
      const signed = r.signed_at ? new Date(r.signed_at) : null;
      let best = null;
      for (const p of paymentsByAcct.get(accountId)) {
        const pAmt = Number(p.amount);
        let score = 0;
        if (fee && pAmt && Math.abs(pAmt - fee) < 1) score += 5;
        else if (fee && pAmt && fee > 0 && Math.abs(pAmt - fee) / fee < 0.05) score += 3;
        const pDate = p.paid_date || p.issue_date || p.due_date;
        if (signed && pDate) {
          const days = Math.abs((new Date(pDate) - signed) / 86400000);
          if (days < 7) score += 3; else if (days < 30) score += 1;
        }
        if (score >= 3 && (!best || score > best.score)) best = { p, score };
      }
      if (best) invoiceId = best.p.id;
    }

    // selected_services from offer.services
    const selectedServices = Array.isArray(r.services) ? r.services : null;

    writes.push({
      contract_id: r.contract_id,
      contact_id: contactId,
      account_id: accountId,
      invoice_id: invoiceId,
      payment_type: paymentType,
      selected_services: selectedServices,
      meta: { token: r.offer_token, client: r.client_name, effectiveType },
    });
  }

  console.log(APPLY ? 'APPLY MODE' : 'DRY-RUN');
  console.log('=====================================');
  console.log(`A. Offers to retag renewal->formation: ${RETAG_TOKENS.length}`);
  for (const t of RETAG_TOKENS) console.log('   ' + t);
  console.log();
  console.log(`B. Valerio annual_fee fix: ${VALERIO_TOKEN} -> '2000'`);
  console.log();
  console.log(`C. Contract backfill writes: ${writes.length}`);
  const byType = {};
  for (const w of writes) byType[w.payment_type] = (byType[w.payment_type] || 0) + 1;
  console.log('   payment_type distribution:', byType);
  console.log(`   with invoice match: ${writes.filter(w => w.invoice_id).length}`);
  console.log(`   with account:      ${writes.filter(w => w.account_id).length}`);
  console.log(`   contact-only:      ${writes.filter(w => !w.account_id).length}`);
  console.log();
  console.log(`D. Duplicate-token contracts SKIPPED: ${dupTokens.size} tokens`);
  console.log();

  if (!APPLY) {
    console.log('--- sample of 10 writes ---');
    for (const w of writes.slice(0, 10)) {
      console.log(`  ${w.meta.client.padEnd(32)} ${w.meta.token.padEnd(44)} payment_type=${w.payment_type.padEnd(18)} acct=${w.account_id ? 'yes' : 'no '} inv=${w.invoice_id ? 'matched' : '---'}`);
    }
    console.log('\nDry run — rerun with --apply to execute.');
    await c.end();
    return;
  }

  // APPLY
  await c.query('BEGIN');
  try {
    // A. retag offers
    const retagRes = await c.query(
      `UPDATE offers SET contract_type = 'formation', updated_at = now() WHERE token = ANY($1::text[]) AND contract_type = 'renewal' RETURNING token`,
      [RETAG_TOKENS]
    );
    console.log(`A. retagged ${retagRes.rows.length} offers: ${retagRes.rows.map(x=>x.token).join(', ')}`);

    // B. Valerio annual_fee
    const vRes = await c.query(
      `UPDATE contracts SET annual_fee = '2000', updated_at = now() WHERE offer_token = $1 RETURNING id, annual_fee`,
      [VALERIO_TOKEN]
    );
    console.log(`B. Valerio annual_fee updated on ${vRes.rows.length} contract(s)`);

    // C. backfill each contract
    let appliedCount = 0;
    for (const w of writes) {
      const sql = `
        UPDATE contracts SET
          contact_id = $1,
          account_id = $2,
          invoice_id = $3,
          payment_type = $4::payment_type_enum,
          selected_services = $5::jsonb,
          updated_at = now()
        WHERE id = $6
      `;
      await c.query(sql, [
        w.contact_id,
        w.account_id,
        w.invoice_id,
        w.payment_type,
        w.selected_services ? JSON.stringify(w.selected_services) : null,
        w.contract_id,
      ]);
      appliedCount++;
    }
    console.log(`C. contract backfill writes applied: ${appliedCount}`);

    await c.query('COMMIT');
    console.log('\nCOMMIT — all done.');
  } catch (e) {
    await c.query('ROLLBACK');
    console.error('ROLLBACK — FAIL:', e.message);
    process.exit(1);
  }

  await c.end();
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
