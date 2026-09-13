import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes('xjcxlmlpeywtwkhstjlw')) {
  console.error('NOT SANDBOX — abort')
  process.exit(1)
}
async function main() {
  const { supabaseAdmin } = await import('../../lib/supabase-admin')
  const today = new Date().toISOString().slice(0, 10)
  const { data, error } = await (supabaseAdmin as any)
    .from('td_bank_feeds')
    .insert({
      external_id: `qa-linkwriteoff-a2-${Date.now()}`,
      transaction_date: today,
      amount: 300,
      currency: 'USD',
      source: 'manual',
      sender_name: 'QA LINKWRITEOFF SENDER A2',
      memo: 'QA-LINKWRITEOFF fixture — plain partial, no write-off',
      status: 'unmatched',
      review_metadata: { client_payment_claim: { by: 'qa-script', at: new Date().toISOString() } },
    })
    .select('id')
    .single()
  console.log('Feed-A2:', JSON.stringify({ data, error }))
}
main()
