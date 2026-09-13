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
    .select('external_id')
    .not('external_id', 'is', null)
    .limit(5000)
  if (error) { console.log('error', JSON.stringify(error)); return }
  const counts = new Map<string, number>()
  for (const row of data ?? []) {
    const k = row.external_id as string
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  const dupes = Array.from(counts.entries()).filter(([, c]) => c > 1)
  console.log('total non-null external_id rows checked:', data?.length)
  console.log('distinct duplicated external_id values:', dupes.length)
  console.log('sample duplicates:', JSON.stringify(dupes.slice(0, 10)))
  const { count: nullCount } = await supabaseAdmin
    .from('td_bank_feeds')
    .select('id', { count: 'exact', head: true })
    .is('external_id', null)
  console.log('rows with NULL external_id:', nullCount)
}
main()
