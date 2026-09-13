import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes('xjcxlmlpeywtwkhstjlw')) {
  console.error('NOT SANDBOX — abort')
  process.exit(1)
}
async function main() {
  const { supabaseAdmin } = await import('../../lib/supabase-admin')
  const { data: invB } = await supabaseAdmin
    .from('payments')
    .select('invoice_number, amount_paid, amount_due, status')
    .eq('invoice_number', 'INV-002580')
    .single()
  console.log('Invoice B — must be UNTOUCHED by the replay attempt:', JSON.stringify(invB))
  const { count } = await supabaseAdmin
    .from('payment_applications')
    .select('id', { count: 'exact', head: true })
    .eq('feed_id', '40c87871-bca6-4672-8d9e-3fdf57b39d6d')
  console.log('payment_applications rows for feed-C — must still be exactly 1:', count)
}
main()
