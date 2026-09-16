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
    .select('invoice_number, total, amount_paid, amount_due, status, invoice_status, paid_date, notes')
    .eq('invoice_number', 'INV-002581')
    .single()
  console.log('Invoice C after write-off:', JSON.stringify(inv))

  const { data: items } = await supabaseAdmin
    .from('payment_items')
    .select('description, amount')
    .eq('payment_id', (await supabaseAdmin.from('payments').select('id').eq('invoice_number', 'INV-002581').single()).data?.id)
  console.log('Line items (must be UNCHANGED — 2 rows, 700+500):', JSON.stringify(items))

  const { data: feed } = await supabaseAdmin
    .from('td_bank_feeds')
    .select('id, status, matched_payment_id, match_confidence, matched_at, matched_by')
    .ilike('sender_name', '%SENDER C%')
    .single()
  console.log('Feed-C after link:', JSON.stringify(feed))

  const { data: apps } = await supabaseAdmin
    .from('payment_applications')
    .select('feed_id, payment_id, amount')
    .eq('feed_id', feed?.id)
  console.log('payment_applications row:', JSON.stringify(apps))
}
main()
