import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes('xjcxlmlpeywtwkhstjlw')) {
  console.error('NOT SANDBOX — abort')
  process.exit(1)
}
async function main() {
  const { supabaseAdmin } = await import('../../lib/supabase-admin')

  const { data: invoices } = await supabaseAdmin
    .from('payments')
    .select('id, invoice_number')
    .ilike('description', '%QA-LINKWRITEOFF%')
  const invoiceIds = (invoices ?? []).map(i => i.id)
  console.log('Deleting invoices:', JSON.stringify(invoices))

  if (invoiceIds.length > 0) {
    const { error: e1 } = await supabaseAdmin.from('payment_applications').delete().in('payment_id', invoiceIds)
    console.log('payment_applications deleted:', JSON.stringify(e1))
    const { error: e2 } = await supabaseAdmin.from('payment_items').delete().in('payment_id', invoiceIds)
    console.log('payment_items deleted:', JSON.stringify(e2))
    const { error: e3 } = await supabaseAdmin.from('client_expenses').delete().in('td_payment_id', invoiceIds)
    console.log('client_expenses mirror deleted:', JSON.stringify(e3))
    const { error: e4 } = await supabaseAdmin.from('payments').delete().in('id', invoiceIds)
    console.log('payments deleted:', JSON.stringify(e4))
  }

  const { data: feeds } = await supabaseAdmin
    .from('td_bank_feeds')
    .select('id, sender_name')
    .ilike('sender_name', '%QA LINKWRITEOFF%')
  console.log('Deleting feeds:', JSON.stringify(feeds))
  const { error: e5 } = await supabaseAdmin.from('td_bank_feeds').delete().ilike('sender_name', '%QA LINKWRITEOFF%')
  console.log('td_bank_feeds deleted:', JSON.stringify(e5))

  const { data: tx } = await supabaseAdmin
    .from('td_books_transactions')
    .select('id, description')
    .ilike('description', '%QA-LINKWRITEOFF%')
  console.log('Deleting books transactions:', JSON.stringify(tx))
  const { error: e6 } = await supabaseAdmin.from('td_books_transactions').delete().ilike('description', '%QA-LINKWRITEOFF%')
  console.log('td_books_transactions deleted:', JSON.stringify(e6))
}
main()
