/* eslint-disable no-console, no-restricted-syntax -- QA script: console output is the deliverable; direct sandbox fixture inserts/teardown are intentional (this is not a production write path) */
// One-off: create a formation-gap fixture (contact with NO account) plus a
// real TD invoice for it via the real createTDInvoice() helper, plus a
// matching sandbox portal login, to browser-verify dev job 3e4b490c (contact-
// scoped clients get 403 downloading their own invoice PDF). Prints the
// login + invoice number, then waits for manual browser verification via
// _verify-payment-pdf-contact-scope-teardown.mts.
import { config as loadEnv } from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
loadEnv({ path: path.resolve(__dirname, '../../.env.local') })

const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
if (sbUrl.includes('ydzipybqeebtpcvsbtvs')) throw new Error('REFUSING production')

async function main() {
  const { supabaseAdmin } = await import('../../lib/supabase-admin')
  const { createTDInvoice } = await import('../../lib/portal/td-invoice')

  const tag = `QA-PDFSCOPE-${Date.now()}`
  const email = `qa+pdfscope+${Date.now()}@example.com`

  const { data: contact, error: cErr } = await supabaseAdmin
    .from('contacts')
    .insert({ first_name: 'QA', last_name: tag, full_name: `QA ${tag}`, email, is_test: true, portal_tier: 'formation' })
    .select('id')
    .single()
  if (cErr || !contact) throw new Error(`contact insert failed: ${cErr?.message}`)

  const invoice = await createTDInvoice({
    contact_id: contact.id,
    line_items: [{ description: 'LLC Formation', unit_price: 250, quantity: 1 }],
    currency: 'USD',
    mark_as_paid: true,
    is_test: true,
  })

  const SB_URL = sbUrl
  const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
  const SANDBOX_PASSWORD = 'TDsandbox-2026!'
  const res = await fetch(`${SB_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password: SANDBOX_PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: `QA ${tag}`, contact_id: contact.id, portal_language: 'en' },
      app_metadata: { contact_id: contact.id, portal_tier: 'formation', role: 'client' },
    }),
  })
  if (!res.ok) throw new Error(`create auth user failed: ${res.status} ${(await res.text()).slice(0, 300)}`)
  const authUser = await res.json()

  console.log('--- FIXTURE READY ---')
  console.log('contact_id:', contact.id)
  console.log('auth_user_id:', authUser.id)
  console.log('payment_id (invoice):', invoice.paymentId)
  console.log('invoice_number:', invoice.invoiceNumber)
  console.log('login email:', email)
  console.log('login password:', SANDBOX_PASSWORD)
  console.log('portal login URL: https://td-operations-sandbox.vercel.app/portal/login')
  console.log('')
  console.log(`Teardown after verifying: npx tsx scripts/sandbox-qa/_verify-payment-pdf-contact-scope-teardown.mts ${contact.id} ${authUser.id}`)
}
main().catch((e) => { console.error(e); process.exit(1) })
