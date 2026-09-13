import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes('xjcxlmlpeywtwkhstjlw')) {
  console.error('NOT SANDBOX — abort')
  process.exit(1)
}
async function main() {
  const { supabaseAdmin } = await import('../../lib/supabase-admin')
  const { error: e1 } = await supabaseAdmin.from('td_bank_feeds').delete().ilike('sender_name', '%QA LINKWRITEOFF%')
  console.log('feeds deleted:', JSON.stringify(e1))
  const { error: e2 } = await supabaseAdmin.from('td_books_transactions').delete().ilike('description', '%QA-LINKWRITEOFF%')
  console.log('books tx deleted:', JSON.stringify(e2))
  // Final confirmation
  const { data: c1 } = await supabaseAdmin.from('td_bank_feeds').select('id').ilike('sender_name', '%QA LINKWRITEOFF%')
  const { data: c2 } = await supabaseAdmin.from('td_books_transactions').select('id').ilike('description', '%QA-LINKWRITEOFF%')
  const { data: c3 } = await supabaseAdmin.from('payments').select('id').ilike('description', '%QA-LINKWRITEOFF%')
  console.log('final check, all must be empty:', JSON.stringify({ feeds: c1, tx: c2, payments: c3 }))
}
main()
