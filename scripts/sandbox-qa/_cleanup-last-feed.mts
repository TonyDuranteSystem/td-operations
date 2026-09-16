import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes('xjcxlmlpeywtwkhstjlw')) {
  console.error('NOT SANDBOX — abort')
  process.exit(1)
}
async function main() {
  const { supabaseAdmin } = await import('../../lib/supabase-admin')
  const { error } = await supabaseAdmin.from('td_bank_feeds').delete().eq('id', '36623c90-cf33-4141-8d76-9ca0ce24418f')
  console.log('deleted:', JSON.stringify(error))
  const { data } = await supabaseAdmin.from('td_bank_feeds').select('id').ilike('sender_name', '%QA LINKWRITEOFF%')
  console.log('final check, must be empty:', JSON.stringify(data))
}
main()
