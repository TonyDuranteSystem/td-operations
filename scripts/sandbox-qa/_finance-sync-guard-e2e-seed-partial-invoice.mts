import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes('xjcxlmlpeywtwkhstjlw')) {
  console.error('NOT SANDBOX — abort')
  process.exit(1)
}
const UXIO_ID = '30c2cd96-03e4-43cf-9536-81d961b18b1d'
async function main() {
  const { supabaseAdmin } = await import('../../lib/supabase-admin')
  const { generateInvoiceNumber } = await import('../../lib/portal/invoice-number')
  const today = new Date().toISOString().slice(0, 10)
  const num = await generateInvoiceNumber()
  const { data, error } = await supabaseAdmin
    .from('payments')
    .insert({
      account_id: UXIO_ID,
      description: 'QA-SYNCGUARD-E2E plain partial payment target',
      amount: 10,
      amount_currency: 'USD',
      status: 'Pending',
      invoice_number: num,
      invoice_status: 'Sent',
      issue_date: today,
      subtotal: 10,
      discount: 0,
      total: 10,
      amount_due: 10,
      amount_paid: 0,
      is_test: false,
    })
    .select('id, invoice_number')
    .single()
  console.log(JSON.stringify({ data, error }))
  if (data) {
    await supabaseAdmin.from('payment_items').insert([
      { payment_id: data.id, description: 'QA line', quantity: 1, unit_price: 10, amount: 10, sort_order: 0 },
    ])
  }
}
main().catch(e => { console.error('FAILED:', e); process.exit(1) })
