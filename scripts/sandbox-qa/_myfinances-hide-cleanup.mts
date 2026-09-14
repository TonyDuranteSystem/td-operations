import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes('xjcxlmlpeywtwkhstjlw')) {
  console.error('NOT SANDBOX — abort')
  process.exit(1)
}
async function main() {
  const { supabaseAdmin } = await import('../../lib/supabase-admin')
  const { data: tx } = await supabaseAdmin.from('td_books_transactions').select('moved_to_feed_id').eq('id', '80cb0239-f452-48ca-942a-2ba1ecff44bd').maybeSingle()
  console.log('feed to also delete:', JSON.stringify(tx))
  if (tx?.moved_to_feed_id) {
    const { error: feedErr } = await supabaseAdmin.from('td_bank_feeds').delete().eq('id', tx.moved_to_feed_id)
    console.log('feed delete error:', JSON.stringify(feedErr))
  }
  const { error: txErr } = await supabaseAdmin.from('td_books_transactions').delete().eq('id', '80cb0239-f452-48ca-942a-2ba1ecff44bd')
  console.log('tx delete error:', JSON.stringify(txErr))
  const { data: leftover } = await supabaseAdmin.from('td_books_transactions').select('id').ilike('description', '%QA-MYFINANCES-HIDE%')
  console.log('leftover:', leftover?.length)
}
main().catch(e => { console.error('FAILED:', e); process.exit(1) })
