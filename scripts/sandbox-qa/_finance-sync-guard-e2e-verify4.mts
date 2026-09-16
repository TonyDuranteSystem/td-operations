import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes('xjcxlmlpeywtwkhstjlw')) {
  console.error('NOT SANDBOX — abort')
  process.exit(1)
}
async function main() {
  const { supabaseAdmin } = await import('../../lib/supabase-admin')
  const { data: feed } = await supabaseAdmin.from('td_bank_feeds').select('id, status, matched_payment_id').eq('id', 'a199fae7-e85b-41c6-a9f8-e74694ad3083').maybeSingle()
  console.log('LUSSIGNOLI feed (must still be unmatched, no match):', JSON.stringify(feed))
  const { data: inv } = await supabaseAdmin.from('payments').select('invoice_number, amount_paid, amount_due, invoice_status, notes').eq('invoice_number', 'INV-002557').maybeSingle()
  console.log('INV-002557 (must be UNTOUCHED):', JSON.stringify(inv))
}
main().catch(e => { console.error('FAILED:', e); process.exit(1) })
