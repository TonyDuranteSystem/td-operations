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
  const { data: txA, error: txAErr } = await supabaseAdmin
    .from('td_books_transactions')
    .insert({
      entity_id: TD_ENTITY_ID,
      transaction_date: today,
      amount: 300,
      currency: 'USD',
      description: 'QA-LINKWRITEOFF fixture — plain partial payment round trip',
      counterparty: 'QA LINKWRITEOFF SENDER A',
      bank_name: 'QA Test Bank',
      account_type: 'checking',
      category: 'uncategorized',
      tax_year: new Date(today).getFullYear(),
      transaction_ref: `qa-linkwriteoff-a-${Date.now()}`,
    })
    .select('id')
    .single()
  console.log('TX-A (native, not yet sent):', JSON.stringify({ data: txA, error: txAErr }))
}
main()
