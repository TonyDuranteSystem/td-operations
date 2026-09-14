import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes('xjcxlmlpeywtwkhstjlw')) {
  console.error('NOT SANDBOX — abort')
  process.exit(1)
}
async function main() {
  const { supabaseAdmin } = await import('../../lib/supabase-admin')
  const { data } = await supabaseAdmin.from('payments').select('invoice_number, is_test, invoice_status, status').eq('invoice_number', 'INV-002578').maybeSingle()
  console.log(JSON.stringify(data))
}
main().catch(e => { console.error('FAILED:', e); process.exit(1) })
