// PR 2 sandbox QA setup — resets the PR3 test contact to formation-gap
// state, sets a known password on the auth user, and inserts a Draft TD
// invoice attached to the contact (no account_id) so we can verify the
// portal Expenses tab + action items widget for formation-gap clients.
//
// Usage: npx tsx scripts/sandbox-qa/_pr2-setup-test-contact.mts

import { config as loadEnv } from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
loadEnv({ path: path.resolve(__dirname, '../../.env.local') })
import { Client as PgClient } from 'pg'
import { createClient as createSb } from '@supabase/supabase-js'

const CONTACT_ID = '92fc7378-efc5-426e-acf8-c0ae00deaded'
const TEST_EMAIL = 'pr3-qa-fresh@sandbox.test'
const TEST_PASSWORD = 'PR2qa-2026!'

async function main() {
  const dbUrl = process.env.SUPABASE_DB_URL
  const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const sbServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!dbUrl) throw new Error('SUPABASE_DB_URL not set')
  if (!sbUrl || !sbServiceKey) throw new Error('Supabase URL or service key not set')

  // Refuse to run against production
  if (sbUrl.includes('ydzipybqeebtpcvsbtvs')) {
    throw new Error('REFUSING to run against production. .env.local must point at sandbox.')
  }

  const pg = new PgClient({ connectionString: dbUrl })
  await pg.connect()
  const sb = createSb(sbUrl, sbServiceKey, { auth: { autoRefreshToken: false, persistSession: false } })

  try {
    console.log('1. Tearing down materialized state...')
    // Find the auth user
    const { rows: authRows } = await pg.query(
      `SELECT id FROM auth.users WHERE raw_app_meta_data->>'contact_id' = $1`,
      [CONTACT_ID],
    )
    const authUserId = authRows[0]?.id as string | undefined
    if (!authUserId) throw new Error('No auth user found for contact')
    console.log(`   auth user: ${authUserId}`)

    // Find any non-cancelled account linked
    const { rows: links } = await pg.query(
      `SELECT account_id FROM account_contacts WHERE contact_id = $1`,
      [CONTACT_ID],
    )
    const accountIds = links.map(l => l.account_id as string)
    console.log(`   linked account_ids: ${accountIds.join(', ') || '(none)'}`)

    // Soft-cancel the linked account(s) instead of deleting (action_log
    // FK + other audit references make hard delete impractical).
    // materializeFormationCompany skips Cancelled accounts when checking
    // for existing non-cancelled material, so cancelling unblocks re-test.
    if (accountIds.length > 0) {
      await pg.query(`DELETE FROM account_contacts WHERE contact_id = $1`, [CONTACT_ID])
      // Cancel any in-flight SDs on those accounts
      await pg.query(
        `UPDATE service_deliveries SET status = 'cancelled', updated_at = now()
         WHERE account_id = ANY($1) AND status NOT IN ('completed', 'cancelled')`,
        [accountIds],
      )
      // Cancel the accounts
      await pg.query(
        `UPDATE accounts SET status = 'Cancelled', updated_at = now() WHERE id = ANY($1)`,
        [accountIds],
      )
      console.log(`   cancelled ${accountIds.length} account(s) + unlinked + cancelled SDs`)
    }

    // Delete any TD invoices on those accounts (sandbox QA fixture only).
    // Order matters: client_expenses.td_payment_id has FK → payments.id, so
    // delete the mirror first.
    if (accountIds.length > 0) {
      const { rowCount: en } = await pg.query(`DELETE FROM client_expenses WHERE account_id = ANY($1)`, [accountIds])
      const { rowCount: pn } = await pg.query(`DELETE FROM payments WHERE account_id = ANY($1)`, [accountIds])
      console.log(`   removed ${en} client_expenses + ${pn} payments on those accounts`)
    }

    // Also delete prior contact-scoped TD invoices we may have left from
    // previous QA runs. Same FK ordering — client_expenses first.
    const { rowCount: ecn } = await pg.query(
      `DELETE FROM client_expenses WHERE contact_id = $1 AND account_id IS NULL`,
      [CONTACT_ID],
    )
    const { rowCount: pcn } = await pg.query(
      `DELETE FROM payments WHERE contact_id = $1 AND account_id IS NULL`,
      [CONTACT_ID],
    )
    console.log(`   removed ${ecn} prior contact-scoped client_expenses + ${pcn} payments`)

    // Reset contact's portal_tier to formation (re-seed)
    await pg.query(`UPDATE contacts SET portal_tier = 'formation', drive_folder_id = NULL WHERE id = $1`, [CONTACT_ID])

    console.log('2. Resetting auth user password...')
    const { error: pwErr } = await sb.auth.admin.updateUserById(authUserId, {
      password: TEST_PASSWORD,
      email_confirm: true,
      app_metadata: {
        role: 'client',
        contact_id: CONTACT_ID,
        portal_tier: 'formation',
      },
    })
    if (pwErr) throw new Error(`Password update failed: ${pwErr.message}`)
    console.log(`   password set to: ${TEST_PASSWORD}`)

    console.log('3. Inserting Draft TD invoice on the contact (account_id=null)...')
    const invoiceNumber = `INV-PR2QA${String(Date.now()).slice(-4)}`
    const { rows: invRows } = await pg.query(
      `INSERT INTO payments (
        contact_id, account_id, description, amount, total, amount_currency,
        invoice_number, invoice_status, status, issue_date, due_date,
        created_at, updated_at
      ) VALUES (
        $1, NULL, 'Formation Service — PR2 QA',
        2500, 2500, 'USD',
        $2, 'Sent', 'Pending',
        CURRENT_DATE, CURRENT_DATE + 14,
        now(), now()
      ) RETURNING id, invoice_number`,
      [CONTACT_ID, invoiceNumber],
    )
    console.log(`   created invoice: ${JSON.stringify(invRows[0])}`)

    // Mirror to client_expenses (matches what createTDInvoice would do)
    await pg.query(
      `INSERT INTO client_expenses (
        contact_id, account_id, vendor_name, invoice_number, description,
        currency, total, subtotal, source, status, issue_date, due_date,
        td_payment_id, created_at, updated_at
      ) VALUES (
        $1, NULL, 'Tony Durante LLC', $2, 'Formation Service — PR2 QA',
        'USD', 2500, 2500, 'td_invoice', 'Pending', CURRENT_DATE, CURRENT_DATE + 14,
        $3, now(), now()
      )`,
      [CONTACT_ID, invoiceNumber, invRows[0].id],
    )
    console.log('   mirrored to client_expenses')

    // Insert a wizard_progress so the action items widget has something
    // to surface (formation form in progress).
    await pg.query(
      `INSERT INTO wizard_progress (contact_id, account_id, wizard_type, status, data, created_at, updated_at)
       VALUES ($1, NULL, 'formation', 'in_progress', '{}'::jsonb, now() - interval '5 days', now())`,
      [CONTACT_ID],
    )
    console.log('   inserted in_progress formation wizard_progress')

    console.log('\n✅ Setup complete')
    console.log(`   Email: ${TEST_EMAIL}`)
    console.log(`   Password: ${TEST_PASSWORD}`)
    console.log(`   Contact: ${CONTACT_ID}`)
    console.log(`   Invoice: ${invoiceNumber}`)
    console.log(`\n   Login at: https://td-operations-sandbox.vercel.app/portal/login`)
  } finally {
    await pg.end()
  }
}

main().catch(err => {
  console.error('FAILED:', err)
  process.exit(1)
})
