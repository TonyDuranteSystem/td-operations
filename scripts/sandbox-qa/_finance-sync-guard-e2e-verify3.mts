import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes('xjcxlmlpeywtwkhstjlw')) {
  console.error('NOT SANDBOX — abort')
  process.exit(1)
}
async function main() {
  const { supabaseAdmin } = await import('../../lib/supabase-admin')
  const { data: inv } = await supabaseAdmin.from('payments').select('id, invoice_number, amount_paid, amount_due, total, status, invoice_status, notes').eq('invoice_number', 'INV-002580').maybeSingle()
  console.log('Invoice:', JSON.stringify(inv))
  const { data: items } = await supabaseAdmin.from('payment_items').select('description, amount, sort_order').eq('payment_id', inv!.id).order('sort_order')
  console.log('Line items (must be UNCHANGED, $250 + $150):', JSON.stringify(items))
  const { data: feed } = await supabaseAdmin.from('td_bank_feeds').select('id, status, matched_payment_id').eq('id', '18847739-447a-4879-8a1f-17f68620a9a0').maybeSingle()
  console.log('Feed:', JSON.stringify(feed))
}
main().catch(e => { console.error('FAILED:', e); process.exit(1) })
