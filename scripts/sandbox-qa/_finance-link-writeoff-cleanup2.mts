import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes('xjcxlmlpeywtwkhstjlw')) {
  console.error('NOT SANDBOX — abort')
  process.exit(1)
}
async function main() {
  const { supabaseAdmin } = await import('../../lib/supabase-admin')
  const invoiceIds = ['00bf4e71-32e3-47b2-b399-39e20540c5b0','40c216b2-c1cb-4af8-988e-367dceeb4f70','a3f6b3e7-059a-4676-af5e-764a70397895']

  const { data: expenses } = await supabaseAdmin.from('client_expenses').select('id').in('td_payment_id', invoiceIds)
  const expenseIds = (expenses ?? []).map(e => e.id)
  console.log('client_expenses to remove:', JSON.stringify(expenses))

  if (expenseIds.length > 0) {
    const { error: eItems } = await supabaseAdmin.from('client_expense_items').delete().in('expense_id', expenseIds)
    console.log('client_expense_items deleted:', JSON.stringify(eItems))
  }
  const { error: eExp } = await supabaseAdmin.from('client_expenses').delete().in('td_payment_id', invoiceIds)
  console.log('client_expenses deleted:', JSON.stringify(eExp))
  const { error: ePay } = await supabaseAdmin.from('payments').delete().in('id', invoiceIds)
  console.log('payments deleted:', JSON.stringify(ePay))

  // Final confirmation everything is gone
  const { data: check1 } = await supabaseAdmin.from('payments').select('id').ilike('description', '%QA-LINKWRITEOFF%')
  const { data: check2 } = await supabaseAdmin.from('td_bank_feeds').select('id').ilike('sender_name', '%QA LINKWRITEOFF%')
  const { data: check3 } = await supabaseAdmin.from('td_books_transactions').select('id').ilike('description', '%QA-LINKWRITEOFF%')
  console.log('Final check — all must be empty:', JSON.stringify({ payments: check1, feeds: check2, tx: check3 }))
}
main()
