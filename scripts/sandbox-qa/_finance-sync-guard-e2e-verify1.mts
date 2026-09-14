import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes('xjcxlmlpeywtwkhstjlw')) {
  console.error('NOT SANDBOX — abort')
  process.exit(1)
}
async function main() {
  const { supabaseAdmin } = await import('../../lib/supabase-admin')
  const { data } = await supabaseAdmin.from('payments').select('invoice_number, amount_paid, amount_due, total, status, invoice_status, notes').eq('invoice_number', 'INV-002581').maybeSingle()
  console.log('Invoice:', JSON.stringify(data))
  const { data: feed } = await supabaseAdmin.from('td_bank_feeds').select('id, status, matched_payment_id, match_confidence').eq('id', 'f175d843-e09e-441e-a494-cc719ce2d202').maybeSingle()
  console.log('Feed:', JSON.stringify(feed))
}
main().catch(e => { console.error('FAILED:', e); process.exit(1) })
