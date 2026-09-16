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
  console.log('Invoices to delete:', JSON.stringify(invoices))
  for (const inv of invoices ?? []) {
    await supabaseAdmin.from('payment_items').delete().eq('payment_id', inv.id)
  }
  const { error: payErr } = await supabaseAdmin.from('payments').delete().in('invoice_number', invoiceNumbers)
  console.log('payments delete error:', JSON.stringify(payErr))

  const feedIds = [
    '57d3c42b-a9d1-4d4f-9aa9-d9ac9cf7796c', // Feed-B
    '18847739-447a-4879-8a1f-17f68620a9a0', // Feed-C
    '5657166e-b7ea-447c-a2d1-30c4c38a928e', // Feed-D
    'f175d843-e09e-441e-a494-cc719ce2d202', // Feed-Partial
    '4dad4487-69e4-46e0-abf2-0cff758e718b', // round-trip feed (created by send-to-finance)
  ]
  const { error: feedErr } = await supabaseAdmin.from('td_bank_feeds').delete().in('id', feedIds)
  console.log('td_bank_feeds delete error:', JSON.stringify(feedErr))

  const { error: txErr } = await supabaseAdmin.from('td_books_transactions').delete().eq('id', '1bc28ef8-1252-4c28-b5bd-a6a30c84ca8a')
  console.log('td_books_transactions delete error:', JSON.stringify(txErr))

  // Verify empty
  const { data: leftoverInv } = await supabaseAdmin.from('payments').select('id').ilike('description', '%QA-SYNCGUARD-E2E%')
  const { data: leftoverFeeds } = await supabaseAdmin.from('td_bank_feeds').select('id').ilike('memo', '%QA-LINKWRITEOFF%')
  const { data: leftoverFeeds2 } = await supabaseAdmin.from('td_bank_feeds').select('id').ilike('sender_name', '%QA%')
  console.log('Leftover check — invoices:', leftoverInv?.length, 'feeds(memo):', leftoverFeeds?.length, 'feeds(sender):', leftoverFeeds2?.length)
}
main().catch(e => { console.error('FAILED:', e); process.exit(1) })
