import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes('xjcxlmlpeywtwkhstjlw')) {
  console.error('NOT SANDBOX — abort')
  process.exit(1)
}
async function main() {
  const { supabaseAdmin } = await import('../../lib/supabase-admin')
  const { data: tx } = await supabaseAdmin.from('td_books_transactions').select('id, moved_to_feed_id, linked_payment_id, category').eq('id', '1bc28ef8-1252-4c28-b5bd-a6a30c84ca8a').maybeSingle()
  console.log('TX-A after send:', JSON.stringify(tx))
  const { data: feed } = await supabaseAdmin.from('td_bank_feeds').select('id, status, amount, sender_name').eq('id', tx!.moved_to_feed_id).maybeSingle()
  console.log('New Finance-side feed row:', JSON.stringify(feed))
}
main().catch(e => { console.error('FAILED:', e); process.exit(1) })
