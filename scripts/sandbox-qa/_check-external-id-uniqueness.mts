import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes('xjcxlmlpeywtwkhstjlw')) {
  console.error('NOT SANDBOX — abort')
  process.exit(1)
}
async function main() {
  const { supabaseAdmin } = await import('../../lib/supabase-admin')
  const testExtId = `qa-uniqueness-probe-${Date.now()}`
  const row = {
    external_id: testExtId,
    transaction_date: '2026-01-01',
    amount: 1,
    currency: 'USD',
    source: 'manual',
    status: 'unmatched',
  }
  const { data: d1, error: e1 } = await (supabaseAdmin as any).from('td_bank_feeds').insert(row).select('id')
  console.log('First insert:', JSON.stringify({ data: d1, error: e1 }))
  const { data: d2, error: e2 } = await (supabaseAdmin as any).from('td_bank_feeds').insert(row).select('id')
  console.log('Second insert with SAME external_id:', JSON.stringify({ data: d2, error: e2 }))
  // cleanup
  await supabaseAdmin.from('td_bank_feeds').delete().eq('external_id', testExtId)
  console.log('cleaned up')
}
main()
