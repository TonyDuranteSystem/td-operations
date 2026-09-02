import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes('xjcxlmlpeywtwkhstjlw')) {
  console.error('NOT SANDBOX — abort')
  process.exit(1)
}
async function main() {
  const { supabaseAdmin } = await import('../../lib/supabase-admin')
  const { data } = await supabaseAdmin
    .from('payments')
    .select('id, description, account_id, invoice_status, status, invoice_number, due_date')
    .is('invoice_status', null)
    .eq('status', 'Overdue')
    .limit(10)
  console.log(JSON.stringify(data, null, 2))
}
main()
