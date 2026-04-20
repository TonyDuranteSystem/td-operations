#!/usr/bin/env node
/**
 * Phase 2 area 1 — Contracts backfill AUDIT (read-only).
 *
 * For each of the 57 contracts in sandbox, propose values for:
 *   - contact_id  (via offer.lead_id→leads.converted_to_contact_id,
 *                  else offer.client_email→contacts.email)
 *   - account_id  (via offer.account_id)
 *   - invoice_id  (via matching payment: same account or contact,
 *                  amount ~== annual_fee, within 30 days of signed_at)
 *   - payment_type (derived from offer.contract_type)
 *   - selected_services (copied from offer.services)
 *
 * Output: /tmp/21-phase2a-contracts-proposal.csv with a confidence tag
 * on every proposed value so Antonio can spot-check the uncertain rows.
 *
 * NO writes. Companion apply script will run after Antonio reviews.
 */

require('dotenv').config({ path: '.env.sandbox' });
const { Client } = require('pg');
const fs = require('fs');

const PAYMENT_TYPE_MAP = {
  formation: 'Setup Fee',
  onboarding: 'Setup Fee',
  renewal: 'Installments',        // default for renewal — some may actually be Annual Payment (manual review)
  tax_return: 'One-Time Service',
  itin: 'One-Time Service',
  custom: 'Custom',
};

(async () => {
  const c = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();

  // Pull every contract + its offer + related lookups
  const contracts = await c.query(`
    SELECT
      ct.id AS contract_id,
      ct.offer_token,
      ct.client_name,
      ct.client_email,
      ct.llc_type,
      ct.annual_fee,
      ct.signed_at,
      ct.status AS contract_status,
      o.contract_type,
      o.account_id AS offer_account_id,
      o.lead_id    AS offer_lead_id,
      o.services   AS offer_services,
      l.converted_to_contact_id
    FROM contracts ct
    LEFT JOIN offers o ON o.token = ct.offer_token
    LEFT JOIN leads  l ON l.id = o.lead_id
    ORDER BY ct.signed_at
  `);

  // Pre-fetch contacts by email for fallback resolution
  const emails = [...new Set(contracts.rows.map(r => r.client_email).filter(Boolean))];
  const contactsByEmail = new Map();
  if (emails.length) {
    const r = await c.query(`SELECT id, email, full_name FROM contacts WHERE email = ANY($1::text[])`, [emails]);
    for (const row of r.rows) {
      const k = (row.email || '').toLowerCase();
      if (!contactsByEmail.has(k)) contactsByEmail.set(k, []);
      contactsByEmail.get(k).push(row);
    }
  }

  // Pre-fetch candidate payments (any Paid/Pending row for the relevant accounts or contacts)
  const acctIds = [...new Set(contracts.rows.map(r => r.offer_account_id).filter(Boolean))];
  const paymentsByAcct = new Map();
  if (acctIds.length) {
    const r = await c.query(`
      SELECT id, account_id, contact_id, amount, invoice_number, status::text AS status, paid_date, issue_date, due_date, installment, description
      FROM payments
      WHERE account_id = ANY($1::uuid[])
    `, [acctIds]);
    for (const row of r.rows) {
      if (!paymentsByAcct.has(row.account_id)) paymentsByAcct.set(row.account_id, []);
      paymentsByAcct.get(row.account_id).push(row);
    }
  }

  const proposals = [];
  for (const r of contracts.rows) {
    // --- CONTACT ---
    let contactId = null;
    let contactSource = null;
    let contactConfidence = 'LOW';
    if (r.converted_to_contact_id) {
      contactId = r.converted_to_contact_id;
      contactSource = 'lead.converted_to_contact_id';
      contactConfidence = 'HIGH';
    } else if (r.client_email) {
      const matches = contactsByEmail.get(r.client_email.toLowerCase()) || [];
      if (matches.length === 1) {
        contactId = matches[0].id;
        contactSource = 'contacts.email (exact)';
        contactConfidence = 'HIGH';
      } else if (matches.length > 1) {
        contactId = null;
        contactSource = `contacts.email AMBIGUOUS (${matches.length} matches)`;
        contactConfidence = 'LOW';
      } else {
        contactSource = 'no contact match';
      }
    } else {
      contactSource = 'no email, no lead';
    }

    // --- ACCOUNT ---
    const accountId = r.offer_account_id || null;
    const accountSource = accountId ? 'offer.account_id' : '(none — contact-only contract)';

    // --- PAYMENT TYPE ---
    const ct = (r.contract_type || '').toLowerCase();
    const paymentType = PAYMENT_TYPE_MAP[ct] || 'Custom';
    const paymentTypeReason = PAYMENT_TYPE_MAP[ct] ? `contract_type='${ct}' -> ${paymentType}` : `contract_type='${ct}' unknown -> Custom`;

    // --- INVOICE MATCH ---
    let invoiceId = null;
    let invoiceReason = 'no account to match against';
    if (accountId && paymentsByAcct.has(accountId)) {
      const candidates = paymentsByAcct.get(accountId);
      const feeNum = Number(r.annual_fee) || null;
      const signed = r.signed_at ? new Date(r.signed_at) : null;
      // score: amount match + within 30 days of signed
      let best = null;
      for (const p of candidates) {
        const pDate = p.paid_date || p.issue_date || p.due_date;
        const pAmt = Number(p.amount);
        let score = 0;
        const reasons = [];
        if (feeNum && pAmt && Math.abs(pAmt - feeNum) < 1) { score += 5; reasons.push('amount-match'); }
        else if (feeNum && pAmt && Math.abs(pAmt - feeNum) / feeNum < 0.05) { score += 3; reasons.push('amount-close'); }
        if (signed && pDate) {
          const daysApart = Math.abs((new Date(pDate) - signed) / 86400000);
          if (daysApart < 7) { score += 3; reasons.push('date-same-week'); }
          else if (daysApart < 30) { score += 1; reasons.push('date-same-month'); }
        }
        if (score > 0 && (!best || score > best.score)) {
          best = { p, score, reasons };
        }
      }
      if (best && best.score >= 3) {
        invoiceId = best.p.id;
        invoiceReason = `matched ${best.p.invoice_number} (${best.reasons.join(', ')})`;
      } else {
        invoiceReason = 'no confident payment match';
      }
    } else if (!accountId) {
      invoiceReason = '(none — contract pre-account)';
    }

    // --- SELECTED SERVICES ---
    let selectedServicesCount = 0;
    let selectedServicesSource = 'offer.services missing';
    if (Array.isArray(r.offer_services)) {
      selectedServicesCount = r.offer_services.length;
      selectedServicesSource = `from offer.services (${selectedServicesCount} items)`;
    }

    proposals.push({
      contract_id: r.contract_id,
      offer_token: r.offer_token,
      signed_at: r.signed_at ? new Date(r.signed_at).toISOString().slice(0, 10) : null,
      client_email: r.client_email,
      contract_type: r.contract_type,
      proposed_contact_id: contactId,
      contact_source: contactSource,
      contact_confidence: contactConfidence,
      proposed_account_id: accountId,
      account_source: accountSource,
      proposed_invoice_id: invoiceId,
      invoice_reason: invoiceReason,
      proposed_payment_type: paymentType,
      payment_type_reason: paymentTypeReason,
      selected_services_count: selectedServicesCount,
      selected_services_source: selectedServicesSource,
    });
  }

  // Write CSV
  const header = Object.keys(proposals[0]);
  const lines = [header.join(',')];
  for (const p of proposals) {
    lines.push(header.map(h => {
      const v = p[h];
      if (v == null) return '';
      const s = String(v);
      return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(','));
  }
  const outPath = '/tmp/21-phase2a-contracts-proposal.csv';
  fs.writeFileSync(outPath, lines.join('\n'));

  // Summary on stdout
  console.log(`contracts audited: ${proposals.length}`);
  const distCC = {}; for (const p of proposals) distCC[p.contact_confidence] = (distCC[p.contact_confidence] || 0) + 1;
  console.log('contact confidence:', distCC);
  const distAcct = { yes: 0, no: 0 }; for (const p of proposals) distAcct[p.proposed_account_id ? 'yes' : 'no']++;
  console.log('has account:', distAcct);
  const distInv = {}; for (const p of proposals) distInv[p.invoice_reason] = (distInv[p.invoice_reason] || 0) + 1;
  console.log('invoice reasons:');
  for (const [k, v] of Object.entries(distInv).sort((a,b)=>b[1]-a[1])) console.log(`  ${v}  ${k}`);
  const distPT = {}; for (const p of proposals) distPT[p.proposed_payment_type] = (distPT[p.proposed_payment_type] || 0) + 1;
  console.log('payment_type:', distPT);
  console.log('');
  console.log(`CSV written → ${outPath}`);
  await c.end();
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
