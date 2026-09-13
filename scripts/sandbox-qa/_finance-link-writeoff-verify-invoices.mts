import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes('xjcxlmlpeywtwkhstjlw')) {
  console.error('NOT SANDBOX — abort')
  process.exit(1)
}
async function main() {
  const { supabaseAdmin } = await import('../../lib/supabase-admin')
  const { data: invoices } = await supabaseAdmin
    .from('payments')
    .select('id, invoice_number, total, amount_due, amount_paid, status, invoice_status, account_id')
    .ilike('description', '%QA-LINKWRITEOFF%')
    .order('created_at', { ascending: true })
  for (const inv of invoices ?? []) {
    const { data: items } = await supabaseAdmin
      .from('payment_items')
      .select('description, amount')
      .eq('payment_id', inv.id)
      .order('sort_order')
    console.log(JSON.stringify({ ...inv, items }))
  }
}
main()
