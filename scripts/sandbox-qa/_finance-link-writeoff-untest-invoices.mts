import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes('xjcxlmlpeywtwkhstjlw')) {
  console.error('NOT SANDBOX — abort')
  process.exit(1)
}
async function main() {
  const { supabaseAdmin } = await import('../../lib/supabase-admin')
  const { data, error } = await supabaseAdmin
    .from('payments')
    .update({ is_test: false })
    .ilike('description', '%QA-LINKWRITEOFF%')
    .select('invoice_number, is_test')
  console.log(JSON.stringify({ data, error }))
}
main()
