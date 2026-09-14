import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes('xjcxlmlpeywtwkhstjlw')) {
  console.error('NOT SANDBOX — abort')
  process.exit(1)
}
async function main() {
  const { supabaseAdmin } = await import('../../lib/supabase-admin')
  const { data, error } = await supabaseAdmin
    .from('td_bank_feeds')
    .insert({
      external_id: 'qa-writtenoff-badge-feed-' + Date.now(),
      transaction_date: new Date().toISOString().slice(0, 10),
      amount: 300, currency: 'USD', source: 'manual',
      sender_name: 'QA WRITTENOFF BADGE SENDER',
      memo: 'QA-WRITTENOFF-BADGE fixture — verify MatchedRow tag',
      status: 'matched',
      matched_payment_id: '7df0645f-4fa9-46a2-818b-068690f81761',
      match_confidence: 'manual',
      matched_at: new Date().toISOString(),
      matched_by: 'qa-script',
    })
    .select('id').single()
  console.log(JSON.stringify({ data, error }))
}
main().catch(e => { console.error('FAILED:', e); process.exit(1) })
