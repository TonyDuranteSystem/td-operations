import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes('xjcxlmlpeywtwkhstjlw')) {
  console.error('NOT SANDBOX — abort')
  process.exit(1)
}
const TD_ENTITY_ID = '00000000-0000-0000-0000-000000000001'
async function main() {
  const { supabaseAdmin } = await import('../../lib/supabase-admin')
  const today = new Date().toISOString().slice(0, 10)
  const { data, error } = await supabaseAdmin
    .from('td_books_transactions')
    .insert({
      entity_id: TD_ENTITY_ID,
      transaction_date: today,
      amount: 175,
      currency: 'USD',
      description: 'QA-LINKWRITEOFF fixture — Chrome round-trip test',
      counterparty: 'QA LINKWRITEOFF ROUNDTRIP SENDER',
      bank_name: 'QA Test Bank',
      account_type: 'checking',
      category: 'uncategorized',
      tax_year: new Date(today).getFullYear(),
      transaction_ref: `qa-linkwriteoff-roundtrip-${Date.now()}`,
    })
    .select('id')
    .single()
  console.log('Round-trip fixture:', JSON.stringify({ data, error }))
}
main()
