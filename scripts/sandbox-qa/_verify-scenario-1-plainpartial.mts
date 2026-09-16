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
    .eq('invoice_number', 'INV-002579')
    .single()
  console.log('Invoice A after plain partial payment (must stay PARTIAL, not Paid):', JSON.stringify(inv))
  const { data: exp } = await supabaseAdmin
    .from('client_expenses')
    .select('status, amount_due, amount_paid')
    .eq('td_payment_id', (await supabaseAdmin.from('payments').select('id').eq('invoice_number','INV-002579').single()).data?.id)
    .eq('source', 'td_invoice')
    .maybeSingle()
  console.log('client_expenses mirror (via DB trigger, not app code):', JSON.stringify(exp))
}
main()
