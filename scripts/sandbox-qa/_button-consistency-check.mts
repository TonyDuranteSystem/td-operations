import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes('xjcxlmlpeywtwkhstjlw')) {
  console.error('NOT SANDBOX — abort')
  process.exit(1)
}
async function main() {
  const { supabaseAdmin } = await import('../../lib/supabase-admin')
  const { data: negFeed } = await supabaseAdmin
    .from('td_books_transactions')
    .select('id, amount, transaction_ref, description, category')
    .lt('amount', 0)
    .like('transaction_ref', 'feed:%')
    .limit(3)
  console.log('Negative feed-linked rows (should NOT show button after fix):', JSON.stringify(negFeed))
  const { data: posNative } = await supabaseAdmin
    .from('td_books_transactions')
    .select('id, amount, transaction_ref, description')
    .gt('amount', 0)
    .is('moved_to_feed_id', null)
    .is('linked_payment_id', null)
    .not('transaction_ref', 'like', 'feed:%')
    .limit(1)
  console.log('Positive native row (SHOULD still show button):', JSON.stringify(posNative))
}
main().catch(e => { console.error('FAILED:', e); process.exit(1) })
