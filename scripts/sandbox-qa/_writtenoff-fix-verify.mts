import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes('xjcxlmlpeywtwkhstjlw')) {
  console.error('NOT SANDBOX — abort')
  process.exit(1)
}
async function main() {
  const { supabaseAdmin } = await import('../../lib/supabase-admin')
  const { data } = await supabaseAdmin
    .from('payments')
    .select('id, invoice_number, total, amount_paid, invoice_status')
    .eq('invoice_status', 'Paid')
    .is('amount_paid', null)
    .gt('total', 0)
    .limit(3)
  console.log('Existing null-amount_paid Paid invoices in sandbox:', JSON.stringify(data))
}
main().catch(e => { console.error('FAILED:', e); process.exit(1) })
