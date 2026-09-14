import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
async function main() {
  const { supabaseAdmin } = await import('../../lib/supabase-admin')
  const { data } = await supabaseAdmin.from('td_books_transactions').select('*').eq('id', '20cde530-52ba-4d6f-98b2-ddef234d8680').maybeSingle()
  console.log(JSON.stringify(data))
}
main()
