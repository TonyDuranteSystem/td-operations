import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes('xjcxlmlpeywtwkhstjlw')) {
  console.error('NOT SANDBOX — abort')
  process.exit(1)
}
async function main() {
  const { supabaseAdmin } = await import('../../lib/supabase-admin')
  const { data: tx } = await supabaseAdmin
    .from('td_books_transactions')
    .select('id, moved_to_feed_id')
    .eq('id', '523fb0ca-d5fd-4cc7-839f-b51084506421')
    .single()
  console.log('Source My-Finances row:', JSON.stringify(tx))
  const { data: feed } = await supabaseAdmin
    .from('td_bank_feeds')
    .select('id, status, source, amount, sender_name, review_metadata')
    .eq('id', tx?.moved_to_feed_id)
    .single()
  console.log('New Finance-side row:', JSON.stringify(feed))
}
main()
