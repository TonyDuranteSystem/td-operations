import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes('xjcxlmlpeywtwkhstjlw')) {
  console.error('NOT SANDBOX — abort')
  process.exit(1)
}
const IDS = [
  '5edfde12-ba80-41b0-8530-9f53466cb62a',
  '09366e2f-8c2d-48ad-aa76-aa17817420eb',
  '48d8ac35-fc63-4a08-b0ba-96598eae477a',
]
async function main() {
  const { supabaseAdmin } = await import('../../lib/supabase-admin')
  const { data } = await supabaseAdmin
    .from('payments')
    .select('id, invoice_number, invoice_status, status, total, amount_paid, amount_due, updated_at')
    .in('id', IDS)
  console.log(JSON.stringify(data, null, 2))
}
main()
