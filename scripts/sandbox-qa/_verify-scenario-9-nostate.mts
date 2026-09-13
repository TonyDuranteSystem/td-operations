import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes('xjcxlmlpeywtwkhstjlw')) {
  console.error('NOT SANDBOX — abort')
  process.exit(1)
}
async function main() {
  const { supabaseAdmin } = await import('../../lib/supabase-admin')
  const { data: feedE } = await supabaseAdmin
    .from('td_bank_feeds')
    .select('status, matched_payment_id')
    .ilike('sender_name', '%SENDER E%')
    .single()
  console.log('Feed-E — must still be unmatched:', JSON.stringify(feedE))
  const { data: invA } = await supabaseAdmin
    .from('payments')
    .select('amount_paid, amount_due, notes')
    .eq('invoice_number', 'INV-002579')
    .single()
  console.log('Invoice A — must be UNCHANGED from the earlier $300 partial (note must NOT contain "should NOT be saved"):', JSON.stringify(invA))
}
main()
