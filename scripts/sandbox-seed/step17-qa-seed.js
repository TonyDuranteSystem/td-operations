#!/usr/bin/env node
/**
 * Step 17 QA seed — sandbox only.
 *
 * Creates synthetic data so the 18-scenario browser walkthrough can exercise:
 *   - Scenario 13 (A1 false-positive): a fresh SMLLC client with paid Inst-2
 *     AND a same-amount one-off invoice that should NOT be matched.
 *   - Scenarios 14–18: 5 td_bank_feeds rows pinned to varied existing clients,
 *     plus a Plaid-Mercury duplicate pair.
 *   - Scenario 12 reuses the existing TEST Onboarding MMLLC LLC and adds a
 *     signed 2026 annual_agreement so the billing checklist fires.
 *
 * Cleanup: run scripts/sandbox-seed/step17-qa-cleanup.js. Everything is
 * tagged so cleanup is idempotent.
 *
 * Refuses to run if NEXT_PUBLIC_SUPABASE_URL points to production.
 */
require('dotenv').config({ path: '.env.local' })
const { Client } = require('pg')
const { randomUUID } = require('crypto')

const SANDBOX_REF = 'xjcxlmlpeywtwkhstjlw'
const PROD_REF = 'ydzipybqeebtpcvsbtvs'
const QA_TAG = 'QA-STEP17'
const QA_TEST_ACCT_NAME = 'QA-Step17 SMLLC LLC'
const ONBOARDED_TEST_ACCT_ID = 'fd33ed53-b820-4a1a-9c11-6708ffae81b6' // TEST Onboarding MMLLC LLC

;(async () => {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes(SANDBOX_REF)) {
    throw new Error('Aborting: NEXT_PUBLIC_SUPABASE_URL does not point to sandbox')
  }
  if (process.env.NEXT_PUBLIC_SUPABASE_URL?.includes(PROD_REF)) {
    throw new Error('Aborting: NEXT_PUBLIC_SUPABASE_URL points to production')
  }

  const c = new Client({ connectionString: process.env.SUPABASE_DB_URL })
  await c.connect()

  try {
    // 1. Create QA-Step17 SMLLC test account (Scenario 1 / 13)
    const acctId = randomUUID()
    await c.query(
      `INSERT INTO accounts (id, company_name, account_type, entity_type, portal_tier,
       installment_1_amount, installment_1_currency, installment_2_amount, installment_2_currency,
       onboarding_date, status, notes)
       VALUES ($1, $2, 'Client', 'Single Member LLC'::company_type, 'active',
       1000, 'USD', 1000, 'USD', '2024-03-15', 'Active'::account_status, $3)
       ON CONFLICT (id) DO NOTHING`,
      [acctId, QA_TEST_ACCT_NAME, `${QA_TAG} test account`],
    )
    console.log(`✅ created account ${acctId} (${QA_TEST_ACCT_NAME})`)

    // 2. Signed 2026 annual_agreement for QA account
    await c.query(
      `INSERT INTO annual_agreements (id, account_id, agreement_year, status, token, signed_at, client_name, client_email)
       VALUES ($1, $2, 2026, 'signed', $3, now(), 'QA Step17', 'qa-step17@sandbox.tonydurante.us')`,
      [randomUUID(), acctId, `qa-step17-${Date.now()}`],
    )

    // 3. Three payments on QA account:
    //    - paid Installment 1 (Jan) 2026 — $1,000
    //    - paid Installment 2 (Jun) 2026 — $1,000
    //    - paid one-off "ITIN application fee" — $1,000 (NO installment label)
    //      ← This is the A1 false-positive bait. Must NOT be matched as Inst-2.
    const inv1Id = randomUUID(), inv2Id = randomUUID(), invOneOffId = randomUUID()
    await c.query(
      `INSERT INTO payments (id, account_id, amount, total, amount_currency, description, installment, invoice_number, invoice_status, status, paid_date, due_date, idempotency_key)
       VALUES
         ($1, $2, 1000, 1000, 'USD', '1st Installment 2026 — Annual LLC Management', 'Installment 1 (Jan)', 'INV-Q1Q1Q1', 'Paid', 'Paid', '2026-01-15', '2026-01-15', $3),
         ($4, $2, 1000, 1000, 'USD', '2nd Installment 2026 — Annual LLC Management', 'Installment 2 (Jun)', 'INV-Q1Q1Q2', 'Paid', 'Paid', '2026-06-10', '2026-06-10', $5),
         ($6, $2, 1000, 1000, 'USD', 'ITIN Application Fee 2026 (one-off)', NULL, 'INV-Q1Q1Q3', 'Paid', 'Paid', '2026-03-20', '2026-03-20', $7)
       ON CONFLICT (id) DO NOTHING`,
      [
        inv1Id, acctId, `${QA_TAG}:inst1:${acctId}`,
        inv2Id, `${QA_TAG}:inst2:${acctId}`,
        invOneOffId, `${QA_TAG}:oneoff:${acctId}`,
      ],
    )
    console.log(`✅ created 3 payments on QA account (inst1, inst2, one-off bait)`)

    // 4. Add signed 2026 annual_agreement for the existing TEST Onboarding MMLLC LLC
    //    so its billing checklist exercises the GREEN path.
    const existing = await c.query(
      `SELECT id FROM annual_agreements WHERE account_id=$1 AND agreement_year=2026`,
      [ONBOARDED_TEST_ACCT_ID],
    )
    if (existing.rows.length === 0) {
      await c.query(
        `INSERT INTO annual_agreements (id, account_id, agreement_year, status, token, signed_at, client_name)
         VALUES ($1, $2, 2026, 'signed', $3, now(), 'QA Step17 Onboarded')`,
        [randomUUID(), ONBOARDED_TEST_ACCT_ID, `qa-step17-onb-${Date.now()}`],
      )
      console.log(`✅ added signed 2026 agreement on existing onboarded account`)
    } else {
      console.log(`ℹ️  onboarded test account already has a 2026 agreement, skipping`)
    }

    // 5. 5 bank feed rows for Scenarios 14–18.
    //    Scenario 14 — Stripe Tier 1 email match (uses Aces Marketing Solutions LLC contact email if present, else generic)
    //    Scenario 15 — mercury_api Tier 2 INV-ref match (memo contains INV-Q1Q1Q1)
    //    Scenario 16 — relay Tier 3 company-name match (memo contains "Aumianna")
    //    Scenario 17 — Stripe EUR currency
    //    Scenario 18 — Plaid-Mercury duplicate pair (mercury + mercury_api same date/amount)

    // Pick attribution targets
    const acesId = '5e7a82fe-1b4b-4399-afcd-dd0d4f6d7c3a' // Aces Marketing Solutions LLC
    const aumiannaId = '8c718ee9-703e-4062-8e0a-af99dc59ef20' // Aumianna LLC

    // Get an email + memo for Aces (Tier 1 + Tier 4)
    const acesContact = await c.query(
      `SELECT c.email, c.full_name FROM contacts c
       JOIN account_contacts ac ON ac.contact_id=c.id
       WHERE ac.account_id=$1 AND c.email IS NOT NULL LIMIT 1`,
      [acesId],
    )
    const acesEmail = acesContact.rows[0]?.email ?? 'unknown@example.com'

    await c.query(
      `INSERT INTO td_bank_feeds (id, source, external_id, transaction_date, amount, currency, sender_name, sender_reference, memo, status, raw_data)
       VALUES
         ($1, 'stripe', $2, '2026-04-15', 1000, 'USD', 'Stripe Charge', 'ch_test_aces', $3, 'unmatched', $4),
         ($5, 'mercury_api', $6, '2026-04-16', 1000, 'USD', 'WIRE INSTRUCTIONS', 'INV-Q1Q1Q1', 'Wire ref INV-Q1Q1Q1 from QA Step17 SMLLC', 'unmatched', '{}'::jsonb),
         ($7, 'relay', $8, '2026-04-17', 1250, 'USD', 'Aumianna Holdings LLC', NULL, 'Wire from Aumianna for annual fees', 'unmatched', '{}'::jsonb),
         ($9, 'stripe', $10, '2026-04-18', 850, 'EUR', 'Stripe EUR Charge', 'ch_test_eur', $11, 'unmatched', $12),
         ($13, 'mercury', $14, '2026-04-19', 1500, 'USD', 'Mercury Plaid Wire', 'plaid-ref', 'Plaid sync mercury duplicate', 'unmatched', '{}'::jsonb),
         ($15, 'mercury_api', $16, '2026-04-19', 1500, 'USD', 'Mercury API Wire', 'mercury-ref', 'Mercury API duplicate twin', 'unmatched', '{}'::jsonb)`,
      [
        randomUUID(), `${QA_TAG}-stripe-tier1`, `Stripe charge for ${acesEmail}`, JSON.stringify({ metadata: { email: acesEmail } }),
        randomUUID(), `${QA_TAG}-mercury-tier2`,
        randomUUID(), `${QA_TAG}-relay-tier3`,
        randomUUID(), `${QA_TAG}-stripe-eur`, `Stripe EUR charge for ${acesEmail}`, JSON.stringify({ metadata: { email: acesEmail } }),
        randomUUID(), `${QA_TAG}-plaid-mercury-dup-A`,
        randomUUID(), `${QA_TAG}-plaid-mercury-dup-B`,
      ],
    )
    console.log(`✅ created 6 bank-feed rows (Tier 1/2/3 orphans + EUR + plaid-mercury duplicate pair)`)

    console.log(`\n📋 Seed complete. Test accounts:`)
    console.log(`   QA SMLLC (Scenarios 1, 13): ${acctId}`)
    console.log(`   Onboarded MMLLC (Scenario 12): ${ONBOARDED_TEST_ACCT_ID}`)
    console.log(`   Aces Marketing (Scenarios 14, 15, 17): ${acesId}`)
    console.log(`   Aumianna (Scenario 16): ${aumiannaId}`)
    console.log(`\nRun cleanup with: node scripts/sandbox-seed/step17-qa-cleanup.js`)
  } finally {
    await c.end()
  }
})().catch(e => { console.error(e); process.exit(1) })
