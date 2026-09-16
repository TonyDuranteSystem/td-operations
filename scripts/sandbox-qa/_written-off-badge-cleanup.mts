import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes('xjcxlmlpeywtwkhstjlw')) {
  console.error('NOT SANDBOX — abort')
  process.exit(1)
}
async function main() {
  const { supabaseAdmin } = await import('../../lib/supabase-admin')
  const { error: feedErr } = await supabaseAdmin.from('td_bank_feeds').delete().eq('id', 'f1fe4954-f8e7-4df1-8e8a-cac2b7e02bf6')
  const { error: payErr } = await supabaseAdmin.from('payments').delete().eq('id', '7df0645f-4fa9-46a2-818b-068690f81761')
  console.log(JSON.stringify({ feedErr, payErr }))
  const { data: leftover } = await supabaseAdmin.from('payments').select('id').ilike('description', '%QA-WRITTENOFF-BADGE%')
  console.log('leftover:', leftover?.length)
}
main().catch(e => { console.error('FAILED:', e); process.exit(1) })
