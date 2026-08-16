import { config as loadEnv } from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
loadEnv({ path: path.resolve(__dirname, '../../.env.local') })
import { createClient } from '@supabase/supabase-js'

const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const sbServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
if (sbUrl.includes('ydzipybqeebtpcvsbtvs')) throw new Error('REFUSING production')
const db = createClient(sbUrl, sbServiceKey)

const accountId = process.argv[2]
if (!accountId) throw new Error('usage: _runner-cli-fixture-teardown.mts <accountId>')

async function main() {
  const { count: txCount } = await db.from('bank_transactions').select('id', { count: 'exact', head: true }).eq('account_id', accountId)
  const { data: sub } = await db.from('tax_return_submissions').select('submitted_data').eq('account_id', accountId).single()
  console.log(`Verify before teardown — remaining transactions: ${txCount} (expect 0)`)
  console.log(`Verify before teardown — statement keys: ${JSON.stringify((sub as { submitted_data: Record<string, unknown> })?.submitted_data?.bank_accounts_0_statements)} (expect [])`)

  await db.from('bank_transactions').delete().eq('account_id', accountId)
  await db.from('tax_return_submissions').delete().eq('account_id', accountId)
  await db.from('accounts').delete().eq('id', accountId)
  console.log('Fixture cleaned up.')
}
main()
