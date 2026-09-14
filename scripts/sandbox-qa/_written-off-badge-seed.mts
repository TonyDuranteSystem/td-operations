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
      description: 'QA-WRITTENOFF-BADGE fixture',
      amount: 500, amount_currency: 'USD', status: 'Paid',
      invoice_number: num, invoice_status: 'Paid', issue_date: today, paid_date: today,
      subtotal: 500, discount: 0, total: 500, amount_due: 0, amount_paid: 300,
      notes: `${today}: QA test — settlement agreed at $300 to close a $500 invoice, case closed.`,
      is_test: false,
    })
    .select('id, invoice_number').single()
  console.log(JSON.stringify({ data, error }))
}
main().catch(e => { console.error('FAILED:', e); process.exit(1) })
