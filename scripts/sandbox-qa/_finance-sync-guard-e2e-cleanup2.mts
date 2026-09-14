import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes('xjcxlmlpeywtwkhstjlw')) {
  console.error('NOT SANDBOX — abort')
  process.exit(1)
}
async function main() {
  const { supabaseAdmin } = await import('../../lib/supabase-admin')

  const invoiceNumbers = ['INV-002579', 'INV-002580', 'INV-002581', 'INV-002582']
  const { data: invoices } = await supabaseAdmin.from('payments').select('id, invoice_number').in('invoice_number', invoiceNumbers)
  const invoiceIds = (invoices ?? []).map(i => i.id)

  const feedIds = [
    '57d3c42b-a9d1-4d4f-9aa9-d9ac9cf7796c',
    '18847739-447a-4879-8a1f-17f68620a9a0',
    '5657166e-b7ea-447c-a2d1-30c4c38a928e',
    'f175d843-e09e-441e-a494-cc719ce2d202',
    '4dad4487-69e4-46e0-abf2-0cff758e718b',
  ]

  const { error: appErr1 } = await supabaseAdmin.from('payment_applications').delete().in('feed_id', feedIds)
  const { error: appErr2 } = await supabaseAdmin.from('payment_applications').delete().in('payment_id', invoiceIds)
  console.log('payment_applications delete errors:', JSON.stringify({ appErr1, appErr2 }))

  const { error: feedErr } = await supabaseAdmin.from('td_bank_feeds').delete().in('id', feedIds)
  console.log('td_bank_feeds delete error:', JSON.stringify(feedErr))

  for (const id of invoiceIds) await supabaseAdmin.from('payment_items').delete().eq('payment_id', id)
  const { error: payErr } = await supabaseAdmin.from('payments').delete().in('id', invoiceIds)
  console.log('payments delete error:', JSON.stringify(payErr))

  const { data: leftoverInv } = await supabaseAdmin.from('payments').select('id').ilike('description', '%QA-SYNCGUARD-E2E%')
  const { data: leftoverInv2 } = await supabaseAdmin.from('payments').select('id').ilike('description', '%QA-LINKWRITEOFF%')
  const { data: leftoverFeeds } = await supabaseAdmin.from('td_bank_feeds').select('id, sender_name, memo').or('memo.ilike.%QA-LINKWRITEOFF%,memo.ilike.%QA-SYNCGUARD%,sender_name.ilike.%QA%')
  const { data: leftoverTx } = await supabaseAdmin.from('td_books_transactions').select('id').ilike('description', '%QA-LINKWRITEOFF%')
  console.log('FINAL leftover check:', JSON.stringify({
    invoices: leftoverInv?.length, invoices2: leftoverInv2?.length,
    feeds: leftoverFeeds, tx: leftoverTx?.length,
  }))
}
main().catch(e => { console.error('FAILED:', e); process.exit(1) })
