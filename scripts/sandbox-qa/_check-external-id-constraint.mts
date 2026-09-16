import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })
if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.includes('xjcxlmlpeywtwkhstjlw')) {
  console.error('NOT SANDBOX — abort')
  process.exit(1)
}
async function main() {
  const { supabaseAdmin } = await import('../../lib/supabase-admin')
  const { data, error } = await supabaseAdmin.rpc('exec_sql' as never, {
    sql: `SELECT conname, contype, pg_get_constraintdef(oid) as def
          FROM pg_constraint
          WHERE conrelid = 'td_bank_feeds'::regclass
          AND pg_get_constraintdef(oid) ILIKE '%external_id%'`
  } as never)
  if (error) {
    console.log('rpc exec_sql not available, trying direct approach:', JSON.stringify(error))
    return
  }
  console.log(JSON.stringify(data))
}
main()
