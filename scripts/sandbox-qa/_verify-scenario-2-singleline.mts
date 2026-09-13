import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes('xjcxlmlpeywtwkhstjlw')) {
  console.error('NOT SANDBOX — abort')
  process.exit(1)
}
async function main() {
  const { supabaseAdmin } = await import('../../lib/supabase-admin')
  const { data: inv } = await supabaseAdmin
    .from('payments')
    .select('invoice_number, total, amount_paid, amount_due, status, invoice_status, notes')
    .eq('invoice_number', 'INV-002580')
    .single()
  console.log('Invoice B after single-line write-off:', JSON.stringify(inv))
}
main()
