import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes('xjcxlmlpeywtwkhstjlw')) {
  console.error('NOT SANDBOX — abort')
  process.exit(1)
}
async function main() {
  const { supabaseAdmin } = await import('../../lib/supabase-admin')
  const { data } = await supabaseAdmin
    .from('td_books_transactions')
    .select('id, description, category, moved_to_feed_id, tax_year')
    .not('moved_to_feed_id', 'is', null)
    .limit(5)
  console.log(JSON.stringify(data))
}
main().catch(e => { console.error('FAILED:', e); process.exit(1) })
