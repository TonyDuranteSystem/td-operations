/* eslint-disable no-console, no-restricted-syntax -- QA script: console output is the deliverable; direct sandbox fixture inserts/teardown are intentional (this is not a production write path) */
import { config as loadEnv } from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
loadEnv({ path: path.resolve(__dirname, '../../.env.local') })

const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
if (sbUrl.includes('ydzipybqeebtpcvsbtvs')) throw new Error('REFUSING production')

const contactId = process.argv[2]
const authUserId = process.argv[3]
if (!contactId || !authUserId) throw new Error('usage: _verify-payment-pdf-contact-scope-teardown.mts <contactId> <authUserId>')

async function main() {
  const { supabaseAdmin } = await import('../../lib/supabase-admin')

  const SB_URL = sbUrl
  const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
  await fetch(`${SB_URL}/auth/v1/admin/users/${authUserId}`, {
    method: 'DELETE',
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  })

  const { data: payments } = await supabaseAdmin.from('payments').select('id').eq('contact_id', contactId)
  const paymentIds = (payments ?? []).map((p) => p.id)
  if (paymentIds.length) {
    await supabaseAdmin.from('payment_items').delete().in('payment_id', paymentIds)
    await supabaseAdmin.from('payments').delete().in('id', paymentIds)
  }
  const { data: expenses } = await supabaseAdmin.from('client_expenses').select('id').eq('contact_id', contactId)
  const expenseIds = (expenses ?? []).map((e) => e.id)
  if (expenseIds.length) {
    await supabaseAdmin.from('client_expense_items').delete().in('expense_id', expenseIds)
    await supabaseAdmin.from('client_expenses').delete().in('id', expenseIds)
  }
  await supabaseAdmin.from('contacts').delete().eq('id', contactId)
  console.log('Fixture cleaned up (auth user, payments, expenses, contact).')
}
main().catch((e) => { console.error(e); process.exit(1) })
