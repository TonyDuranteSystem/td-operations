// One-off: create a fixture account+submission+transactions to test the
// tax-account-reset-runner.mts CLI against, print its id, then wait for
// manual teardown via _runner-cli-fixture-teardown.mts.
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

async function main() {
  const { data: account } = await db.from('accounts').insert({ company_name: 'QA CLI Runner Test LLC', entity_type: 'Multi Member LLC' }).select('id').single()
  const accountId = account!.id as string
  await db.from('tax_return_submissions').insert({
    account_id: accountId, tax_year: 2025, entity_type: 'Multi Member LLC', status: 'completed',
    submitted_data: { company_name: 'QA CLI Runner Test LLC', bank_accounts_0_statements: ['a.csv'] },
    financials_meta: {}, token: `qa-cli-runner-${Date.now()}`,
  })
  const rows = Array.from({ length: 5 }, (_, i) => ({
    account_id: accountId, tax_year: 2025, transaction_date: '2025-01-01', amount: 1,
    description: `row ${i}`, bank_name: 'Chase', account_type: 'USD', transaction_ref: `qa-cli-runner-${Date.now()}-${i}`,
  }))
  await db.from('bank_transactions').insert(rows)
  console.log(accountId)
}
main()
