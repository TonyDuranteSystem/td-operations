import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes('xjcxlmlpeywtwkhstjlw')) {
  console.error('NOT SANDBOX — abort')
  process.exit(1)
}

async function main() {
  const { supabaseAdmin } = await import('../../lib/supabase-admin')

  const accountIds = ['1e0ccd9c-b70c-42d6-82b3-ae6cfb0f87ec', '423f0dd7-8639-4873-88ba-1653a4cf086b']
  const invoiceNumbers = ['INV-002579', 'INV-002580', 'INV-002581']
  const tokens = ['qa-pdfbill-portal-active-1789520750698', 'qa-pdfbill-no-portal-1789520750698']

  const { data: expenseRows } = await supabaseAdmin.from('client_expenses').select('id').in('account_id', accountIds)
  const expenseIds = (expenseRows ?? []).map(r => r.id)
  if (expenseIds.length > 0) {
    const { error: itemErr } = await supabaseAdmin.from('client_expense_items').delete().in('expense_id', expenseIds)
    console.log('client_expense_items deleted:', JSON.stringify({ error: itemErr }))
  }

  const { error: expErr } = await supabaseAdmin.from('client_expenses').delete().in('account_id', accountIds)
  console.log('client_expenses deleted:', JSON.stringify({ error: expErr }))

  const { data: paymentRows } = await supabaseAdmin.from('payments').select('id').in('invoice_number', invoiceNumbers)
  const paymentIds = (paymentRows ?? []).map(r => r.id)
  if (paymentIds.length > 0) {
    const { error: itemsErr } = await supabaseAdmin.from('payment_items').delete().in('payment_id', paymentIds)
    console.log('payment_items deleted:', JSON.stringify({ error: itemsErr }))
  }

  const { error: payErr } = await supabaseAdmin.from('payments').delete().in('invoice_number', invoiceNumbers)
  console.log('payments deleted:', JSON.stringify({ error: payErr }))

  const { error: agErr } = await supabaseAdmin.from('annual_agreements').delete().in('token', tokens)
  console.log('annual_agreements deleted:', JSON.stringify({ error: agErr }))

  const { error: conErr } = await supabaseAdmin.from('contracts').delete().in('offer_token', tokens)
  console.log('contracts deleted:', JSON.stringify({ error: conErr }))

  const { error: acctErr } = await supabaseAdmin.from('accounts').delete().in('id', accountIds)
  console.log('accounts deleted:', JSON.stringify({ error: acctErr }))
}
main().catch(e => { console.error('FAILED:', e); process.exit(1) })
