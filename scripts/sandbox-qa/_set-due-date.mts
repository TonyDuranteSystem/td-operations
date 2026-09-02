import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes('xjcxlmlpeywtwkhstjlw')) {
  console.error('NOT SANDBOX — abort')
  process.exit(1)
}
async function main() {
  const { supabaseAdmin } = await import('../../lib/supabase-admin')
  const { error } = await supabaseAdmin
    .from('payments')
    .update({ due_date: '2020-01-01' })
    .eq('id', '48d8ac35-fc63-4a08-b0ba-96598eae477a')
  console.log('error:', error)
}
main()
