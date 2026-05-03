#!/usr/bin/env node
/**
 * Step 17 QA cleanup — sandbox only.
 * Removes everything created by step17-qa-seed.js. Idempotent.
 */
require('dotenv').config({ path: '.env.local' })
const { Client } = require('pg')

const SANDBOX_REF = 'xjcxlmlpeywtwkhstjlw'
const PROD_REF = 'ydzipybqeebtpcvsbtvs'
const QA_TAG = 'QA-STEP17'
const QA_TEST_ACCT_NAME = 'QA-Step17 SMLLC LLC'
const ONBOARDED_TEST_ACCT_ID = 'fd33ed53-b820-4a1a-9c11-6708ffae81b6'

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
    // 1. Delete seeded bank feeds (by external_id prefix)
    const f = await c.query(
      `DELETE FROM td_bank_feeds WHERE external_id LIKE $1 RETURNING id`,
      [`${QA_TAG}-%`],
    )
    console.log(`🗑  deleted ${f.rowCount} bank feed rows`)

    // 2. Find QA SMLLC test account
    const acct = await c.query(
      `SELECT id FROM accounts WHERE company_name=$1 AND notes LIKE $2`,
      [QA_TEST_ACCT_NAME, `%${QA_TAG}%`],
    )

    if (acct.rows[0]) {
      const acctId = acct.rows[0].id
      // 2a. Delete payments by idempotency_key prefix
      const p = await c.query(
        `DELETE FROM payments WHERE idempotency_key LIKE $1 RETURNING id`,
        [`${QA_TAG}:%`],
      )
      console.log(`🗑  deleted ${p.rowCount} payments`)
      // 2b. Delete annual_agreements for the QA account
      const a = await c.query(
        `DELETE FROM annual_agreements WHERE account_id=$1 RETURNING id`,
        [acctId],
      )
      console.log(`🗑  deleted ${a.rowCount} annual_agreement rows for QA SMLLC`)
      // 2c. Delete the QA account
      await c.query(`DELETE FROM accounts WHERE id=$1`, [acctId])
      console.log(`🗑  deleted QA account ${acctId}`)
    } else {
      console.log(`ℹ️  QA SMLLC test account not found — already cleaned`)
    }

    // 3. Remove the signed 2026 agreement we added to the existing onboarded test account.
    //    Identify it by its `qa-step17-onb-` token prefix so we don't touch any pre-existing one.
    const ag = await c.query(
      `DELETE FROM annual_agreements WHERE account_id=$1 AND token LIKE 'qa-step17-onb-%' RETURNING id`,
      [ONBOARDED_TEST_ACCT_ID],
    )
    console.log(`🗑  deleted ${ag.rowCount} qa-step17 agreement rows on onboarded test account`)

    console.log(`\n✅ cleanup complete`)
  } finally {
    await c.end()
  }
})().catch(e => { console.error(e); process.exit(1) })
