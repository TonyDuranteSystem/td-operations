import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes('xjcxlmlpeywtwkhstjlw')) {
  console.error('NOT SANDBOX — abort')
  process.exit(1)
}
async function main() {
  const { supabaseAdmin } = await import('../../lib/supabase-admin')
  const { data } = await supabaseAdmin
    .from('account_contacts')
    .select('contact_id, contacts(id, full_name)')
    .eq('account_id', '30c2cd96-03e4-43cf-9536-81d961b18b1d')
    .limit(5)
  console.log(JSON.stringify(data, null, 2))
}
main()
