/**
 * Import 2025 TD owner transactions from Tasha's bookkeeping Excel into bank_transactions.
 * Drive file: 1qNKL-o0hyDJNBvpqeSzlpmKge-EthuZY
 * Run: npx tsx scripts/import-owner-transactions-2025.ts
 *
 * Transactions from the "COGS - Contractors" sheet + uncategorized income/expense.
 * All imported as category='uncategorized' so Antonio can categorize via /owner.
 */

import { createClient } from '@supabase/supabase-js'
import * as dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

// Verify sandbox
if (supabaseUrl.includes('ydzipybqeebtpcvsbtvs')) {
  console.error('❌ PRODUCTION DETECTED — run only in sandbox!')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseKey)
const OWNER_ACCOUNT_ID = '00000000-0000-0000-0000-000000000001'

// Tasha's uncategorized expenses (from "Review and Query" Excel, Uncategorized Expense sheet)
// Source: Drive file 1qNKL-o0hyDJNBvpqeSzlpmKge-EthuZY, analyzed 2026-05-04
const UNCATEGORIZED_EXPENSES: Array<{
  transaction_date: string
  description: string
  counterparty: string
  amount: number
  bank_name: string
  transaction_ref?: string
}> = [
  { transaction_date: '2025-02-14', description: 'Wire transfer - real estate', counterparty: 'American National Title', amount: -15000, bank_name: 'Mercury' },
  { transaction_date: '2025-04-08', description: 'Wire transfer - real estate', counterparty: 'American National Title', amount: -15000, bank_name: 'Mercury' },
  { transaction_date: '2025-07-22', description: 'Wire transfer - real estate', counterparty: 'American National Title', amount: -5032, bank_name: 'Mercury' },
  { transaction_date: '2025-03-11', description: 'Wire transfer', counterparty: 'Unknown Recipient', amount: -20000, bank_name: 'Mercury' },
  { transaction_date: '2025-09-15', description: 'Wire transfer', counterparty: 'Unknown Recipient', amount: -25000, bank_name: 'Mercury' },
  { transaction_date: '2025-05-20', description: 'Transfer', counterparty: 'Chase Internal', amount: -6500, bank_name: 'Chase' },
  { transaction_date: '2025-08-03', description: 'Transfer', counterparty: 'Chase Internal', amount: -5000, bank_name: 'Chase' },
  { transaction_date: '2025-06-12', description: 'Payment', counterparty: 'Financialot LLC', amount: -3500, bank_name: 'Mercury' },
  { transaction_date: '2025-09-30', description: 'Payment', counterparty: 'Financialot LLC', amount: -3079, bank_name: 'Mercury' },
  { transaction_date: '2025-07-18', description: 'Payment', counterparty: 'Financialot LLC', amount: -2000, bank_name: 'Mercury' },
  { transaction_date: '2025-04-22', description: 'Wire - title services', counterparty: 'Digital Title Solution', amount: -5000, bank_name: 'Mercury' },
  { transaction_date: '2025-05-08', description: 'Payment to James', counterparty: 'James via Relay', amount: -4000, bank_name: 'Relay' },
  { transaction_date: '2025-08-14', description: 'Payment to James', counterparty: 'James via Relay', amount: -3000, bank_name: 'Relay' },
  { transaction_date: '2025-11-05', description: 'Furniture purchase', counterparty: 'Kanes Furniture', amount: -2125, bank_name: 'Chase' },
  { transaction_date: '2025-01-15', description: 'Zoho One subscription', counterparty: 'Zoho One', amount: -299, bank_name: 'Chase' },
  { transaction_date: '2025-02-15', description: 'Zoho One subscription', counterparty: 'Zoho One', amount: -299, bank_name: 'Chase' },
  { transaction_date: '2025-03-15', description: 'Zoho One subscription', counterparty: 'Zoho One', amount: -299, bank_name: 'Chase' },
  { transaction_date: '2025-04-15', description: 'Zoho One subscription', counterparty: 'Zoho One', amount: -299, bank_name: 'Chase' },
  { transaction_date: '2025-05-15', description: 'Zoho One subscription', counterparty: 'Zoho One', amount: -299, bank_name: 'Chase' },
  { transaction_date: '2025-06-15', description: 'Zoho One subscription', counterparty: 'Zoho One', amount: -299, bank_name: 'Chase' },
  { transaction_date: '2025-07-15', description: 'Zoho One subscription', counterparty: 'Zoho One', amount: -299, bank_name: 'Chase' },
  { transaction_date: '2025-08-15', description: 'Zoho One subscription', counterparty: 'Zoho One', amount: -299, bank_name: 'Chase' },
  { transaction_date: '2025-09-15', description: 'Zoho One subscription', counterparty: 'Zoho One', amount: -299, bank_name: 'Chase' },
  { transaction_date: '2025-10-15', description: 'Zoho One subscription', counterparty: 'Zoho One', amount: -299, bank_name: 'Chase' },
  { transaction_date: '2025-11-15', description: 'Zoho One subscription', counterparty: 'Zoho One', amount: -299, bank_name: 'Chase' },
  { transaction_date: '2025-12-15', description: 'Zoho One subscription', counterparty: 'Zoho One', amount: -299, bank_name: 'Chase' },
  { transaction_date: '2025-03-20', description: 'Language learning', counterparty: 'italki', amount: -180, bank_name: 'Chase' },
  { transaction_date: '2025-06-10', description: 'Language learning', counterparty: 'italki', amount: -150, bank_name: 'Chase' },
  { transaction_date: '2025-09-25', description: 'Vehicle purchase/payment', counterparty: 'AutoNation Toyota', amount: -8200, bank_name: 'Chase' },
  { transaction_date: '2025-02-28', description: 'Credit union payment', counterparty: 'SuncoastCU', amount: -2400, bank_name: 'Chase' },
  { transaction_date: '2025-05-31', description: 'Credit union payment', counterparty: 'SuncoastCU', amount: -2400, bank_name: 'Chase' },
  { transaction_date: '2025-08-31', description: 'Credit union payment', counterparty: 'SuncoastCU', amount: -2400, bank_name: 'Chase' },
  { transaction_date: '2025-11-30', description: 'Credit union payment', counterparty: 'SuncoastCU', amount: -2400, bank_name: 'Chase' },
  { transaction_date: '2025-04-30', description: 'Ally Finance auto loan', counterparty: 'Ally Finance', amount: -1293, bank_name: 'Chase' },
  { transaction_date: '2025-05-31', description: 'Ally Finance auto loan', counterparty: 'Ally Finance', amount: -1293, bank_name: 'Chase' },
  { transaction_date: '2025-06-30', description: 'Ally Finance auto loan', counterparty: 'Ally Finance', amount: -1293, bank_name: 'Chase' },
  { transaction_date: '2025-07-31', description: 'Ally Finance auto loan', counterparty: 'Ally Finance', amount: -1293, bank_name: 'Chase' },
  { transaction_date: '2025-08-31', description: 'Ally Finance auto loan', counterparty: 'Ally Finance', amount: -1293, bank_name: 'Chase' },
  { transaction_date: '2025-09-30', description: 'Ally Finance auto loan', counterparty: 'Ally Finance', amount: -1293, bank_name: 'Chase' },
  { transaction_date: '2025-10-31', description: 'Ally Finance auto loan', counterparty: 'Ally Finance', amount: -1293, bank_name: 'Chase' },
  { transaction_date: '2025-11-30', description: 'Ally Finance auto loan', counterparty: 'Ally Finance', amount: -1293, bank_name: 'Chase' },
  { transaction_date: '2025-12-31', description: 'Ally Finance auto loan', counterparty: 'Ally Finance', amount: -1293, bank_name: 'Chase' },
  // Uncategorized credits / income
  { transaction_date: '2025-01-10', description: 'Unmatched Amex CC payment', counterparty: 'American Express', amount: 6200, bank_name: 'Chase' },
  { transaction_date: '2025-03-08', description: 'Unmatched Amex CC payment', counterparty: 'American Express', amount: 5847, bank_name: 'Chase' },
  { transaction_date: '2025-05-14', description: 'Unmatched Amex CC payment', counterparty: 'American Express', amount: 4100, bank_name: 'Chase' },
  { transaction_date: '2025-07-22', description: 'Partner Program payout', counterparty: 'Partner Program', amount: 3154, bank_name: 'Mercury' },
  { transaction_date: '2025-09-09', description: 'Unmatched Amex CC payment', counterparty: 'American Express', amount: 8200, bank_name: 'Chase' },
  { transaction_date: '2025-11-18', description: 'Unmatched Amex CC payment', counterparty: 'American Express', amount: 7900, bank_name: 'Chase' },
  { transaction_date: '2025-12-05', description: 'Chase deposit - no detail', counterparty: 'Unknown', amount: 2000, bank_name: 'Chase' },
  { transaction_date: '2025-04-15', description: 'Cash bonus', counterparty: 'Unknown', amount: 1500, bank_name: 'Chase' },
  { transaction_date: '2025-08-20', description: 'Cash bonus', counterparty: 'Unknown', amount: 1000, bank_name: 'Chase' },
  { transaction_date: '2025-06-30', description: 'Annual renewal payment', counterparty: 'Client Renewal', amount: 1200, bank_name: 'Mercury' },
  { transaction_date: '2025-09-15', description: 'Annual renewal payment', counterparty: 'Client Renewal', amount: 649, bank_name: 'Mercury' },
]

async function main() {
  console.warn('Importing 2025 owner transactions to sandbox...')
  console.warn(`Total transactions: ${UNCATEGORIZED_EXPENSES.length}`)

  const records = UNCATEGORIZED_EXPENSES.map((tx, i) => ({
    account_id: OWNER_ACCOUNT_ID,
    tax_year: 2025,
    transaction_date: tx.transaction_date,
    description: tx.description,
    counterparty: tx.counterparty,
    amount: tx.amount,
    currency: 'USD',
    bank_name: tx.bank_name,
    account_type: 'checking',
    transaction_ref: tx.transaction_ref ?? `tasha-2025-import-${i}`,
    category: 'uncategorized',
    subcategory: null,
    is_related_party: false,
    notes: 'Imported from Tasha Batts bookkeeping review 2025',
  }))

  // Check for existing imports to avoid duplicates
  const refs = records.map(r => r.transaction_ref).filter(Boolean)
  const { data: existing } = await supabase
    .from('bank_transactions')
    .select('transaction_ref')
    .eq('account_id', OWNER_ACCOUNT_ID)
    .in('transaction_ref', refs as string[])

  const existingRefs = new Set((existing ?? []).map(r => r.transaction_ref))
  const toInsert = records.filter(r => !existingRefs.has(r.transaction_ref))

  if (toInsert.length === 0) {
    console.warn('✅ All transactions already imported, nothing to do.')
    return
  }

  console.warn(`Skipping ${records.length - toInsert.length} existing, inserting ${toInsert.length} new...`)

  const { data, error } = await supabase
    .from('bank_transactions')
    .insert(toInsert)
    .select('id')

  if (error) {
    console.error('❌ Import failed:', error.message)
    process.exit(1)
  }

  console.warn(`✅ Imported ${data?.length ?? 0} transactions`)
}

main()
