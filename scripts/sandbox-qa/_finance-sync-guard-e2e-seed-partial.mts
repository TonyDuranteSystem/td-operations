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
      external_id: 'qa-syncguard-e2e-partial-' + Date.now(),
      transaction_date: new Date().toISOString().slice(0, 10),
      amount: 6,
      currency: 'USD',
      source: 'manual',
      sender_name: 'QA SYNCGUARD E2E PARTIAL SENDER',
      memo: 'QA-SYNCGUARD-E2E fixture — plain partial payment (no write-off)',
      status: 'unmatched',
    })
    .select('id')
    .single()
  console.log('Feed-Partial:', JSON.stringify({ data, error }))
}
main().catch(e => { console.error('FAILED:', e); process.exit(1) })
