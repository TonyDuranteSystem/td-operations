import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes('xjcxlmlpeywtwkhstjlw')) {
  console.error('NOT SANDBOX — abort')
  process.exit(1)
}
async function main() {
  const { supabaseAdmin } = await import('../../lib/supabase-admin')
  const { error } = await supabaseAdmin.from('td_bank_feeds').delete().eq('id', '9b4f53b0-8a1f-482d-8bdf-8e1f5a9d6a9c')
  console.log('feed delete error:', JSON.stringify(error))
}
main().catch(e => { console.error('FAILED:', e); process.exit(1) })
