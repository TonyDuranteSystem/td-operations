/**
 * Import ALL 2025 Tony Durante LLC transactions from Tasha Batts bookkeeping Excel.
 * Source: Drive file 1qNKL-o0hyDJNBvpqeSzlpmKge-EthuZY (Antonio/attachment)
 * Sheets imported:
 *   - COGS - Contractors (61 txs, pre-categorized as cogs/contractor)
 *   - Uncategorized income (25 txs, needs Antonio review)
 *   - Uncategorized expense (96 txs, needs Antonio review)
 *   - Partner Distribution (54 txs, pre-categorized as personal/distribution|contribution)
 *
 * Totals verified against Tasha's file:
 *   COGS: $105,831.18 ✓
 *   Uncategorized income: $53,187.42 ✓
 *
 * Run: npx tsx scripts/import-owner-transactions-2025-full.ts
 * This script REPLACES the earlier approximate import (tasha-2025-import-* refs).
 */

import { createClient } from '@supabase/supabase-js'
import * as dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (supabaseUrl.includes('ydzipybqeebtpcvsbtvs')) {
  console.error('❌ PRODUCTION DETECTED — run only in sandbox!')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseKey)
const OWNER_ACCOUNT_ID = '00000000-0000-0000-0000-000000000001'

const TRANSACTIONS = [
  // ── COGS - Contractors (61 transactions, $105,831.18) ──────────────────────
  { transaction_date: '2025-01-07', description: 'Expense', counterparty: '727 Moving', amount: -427.96, bank_name: 'American Express', category: 'cogs', subcategory: 'contractor', notes: null, ref_key: 'tasha-cogs-0' },
  { transaction_date: '2025-01-09', description: 'Expense', counterparty: 'JODI', amount: -3000.00, bank_name: 'Chase', category: 'cogs', subcategory: 'contractor', notes: null, ref_key: 'tasha-cogs-1' },
  { transaction_date: '2025-01-13', description: 'Expense', counterparty: 'Tello', amount: -6.21, bank_name: 'Chase', category: 'cogs', subcategory: 'contractor', notes: null, ref_key: 'tasha-cogs-2' },
  { transaction_date: '2025-02-03', description: 'Expense', counterparty: 'Luca DeG', amount: -3000.00, bank_name: 'Chase', category: 'cogs', subcategory: 'contractor', notes: null, ref_key: 'tasha-cogs-3' },
  { transaction_date: '2025-02-03', description: 'Expense', counterparty: 'Janet Durate', amount: -1000.00, bank_name: 'Chase', category: 'cogs', subcategory: 'contractor', notes: null, ref_key: 'tasha-cogs-4' },
  { transaction_date: '2025-02-10', description: 'Expense', counterparty: 'JODI', amount: -3000.00, bank_name: 'Chase', category: 'cogs', subcategory: 'contractor', notes: null, ref_key: 'tasha-cogs-5' },
  { transaction_date: '2025-02-18', description: 'Expense', counterparty: 'Janet Durate', amount: -1000.00, bank_name: 'Chase', category: 'cogs', subcategory: 'contractor', notes: null, ref_key: 'tasha-cogs-6' },
  { transaction_date: '2025-02-21', description: 'Expense', counterparty: 'Upwork', amount: -29.99, bank_name: 'Chase', category: 'cogs', subcategory: 'contractor', notes: null, ref_key: 'tasha-cogs-7' },
  { transaction_date: '2025-03-03', description: 'Expense', counterparty: 'JODI', amount: -3000.00, bank_name: 'Chase', category: 'cogs', subcategory: 'contractor', notes: null, ref_key: 'tasha-cogs-8' },
  { transaction_date: '2025-03-03', description: 'Expense', counterparty: 'Luca DeG', amount: -4000.00, bank_name: 'Chase', category: 'cogs', subcategory: 'contractor', notes: null, ref_key: 'tasha-cogs-9' },
  { transaction_date: '2025-03-03', description: 'Expense', counterparty: 'Janet Durate', amount: -1000.00, bank_name: 'Chase', category: 'cogs', subcategory: 'contractor', notes: null, ref_key: 'tasha-cogs-10' },
  { transaction_date: '2025-03-17', description: 'Expense', counterparty: 'Janet Durate', amount: -1000.00, bank_name: 'Chase', category: 'cogs', subcategory: 'contractor', notes: null, ref_key: 'tasha-cogs-11' },
  { transaction_date: '2025-03-26', description: 'Expense', counterparty: 'Tommaso Arcadi', amount: -100.00, bank_name: 'Airwallex', category: 'cogs', subcategory: 'contractor', notes: null, ref_key: 'tasha-cogs-12' },
  { transaction_date: '2025-03-31', description: 'Expense', counterparty: 'Janet Durate', amount: -1000.00, bank_name: 'Chase', category: 'cogs', subcategory: 'contractor', notes: null, ref_key: 'tasha-cogs-13' },
  { transaction_date: '2025-04-01', description: 'Expense', counterparty: 'JODI', amount: -3000.00, bank_name: 'Chase', category: 'cogs', subcategory: 'contractor', notes: null, ref_key: 'tasha-cogs-14' },
  { transaction_date: '2025-04-01', description: 'Expense', counterparty: 'Luca DeG', amount: -4000.00, bank_name: 'Chase', category: 'cogs', subcategory: 'contractor', notes: null, ref_key: 'tasha-cogs-15' },
  { transaction_date: '2025-04-07', description: 'Expense', counterparty: 'JODI', amount: -2000.00, bank_name: 'Chase', category: 'cogs', subcategory: 'contractor', notes: null, ref_key: 'tasha-cogs-16' },
  { transaction_date: '2025-04-14', description: 'Expense', counterparty: 'Janet Durate', amount: -1000.00, bank_name: 'Chase', category: 'cogs', subcategory: 'contractor', notes: null, ref_key: 'tasha-cogs-17' },
  { transaction_date: '2025-04-28', description: 'Expense', counterparty: 'JODI', amount: -3000.00, bank_name: 'Chase', category: 'cogs', subcategory: 'contractor', notes: null, ref_key: 'tasha-cogs-18' },
  { transaction_date: '2025-04-28', description: 'Expense', counterparty: 'Janet Durate', amount: -1000.00, bank_name: 'Chase', category: 'cogs', subcategory: 'contractor', notes: null, ref_key: 'tasha-cogs-19' },
  { transaction_date: '2025-05-01', description: 'Expense', counterparty: 'Luca DeG', amount: -4000.00, bank_name: 'Chase', category: 'cogs', subcategory: 'contractor', notes: null, ref_key: 'tasha-cogs-20' },
  { transaction_date: '2025-05-09', description: 'Expense', counterparty: 'JODI', amount: -2000.00, bank_name: 'Chase', category: 'cogs', subcategory: 'contractor', notes: null, ref_key: 'tasha-cogs-21' },
  { transaction_date: '2025-06-02', description: 'Expense', counterparty: 'JODI', amount: -3000.00, bank_name: 'Chase', category: 'cogs', subcategory: 'contractor', notes: null, ref_key: 'tasha-cogs-22' },
  { transaction_date: '2025-06-02', description: 'Expense', counterparty: 'Luca DeG', amount: -4000.00, bank_name: 'Chase', category: 'cogs', subcategory: 'contractor', notes: null, ref_key: 'tasha-cogs-23' },
  { transaction_date: '2025-06-23', description: 'Expense', counterparty: 'JODI', amount: -1000.00, bank_name: 'Chase', category: 'cogs', subcategory: 'contractor', notes: null, ref_key: 'tasha-cogs-24' },
  { transaction_date: '2025-07-01', description: 'Expense', counterparty: 'Luca DeG', amount: -4000.00, bank_name: 'Chase', category: 'cogs', subcategory: 'contractor', notes: null, ref_key: 'tasha-cogs-25' },
  { transaction_date: '2025-07-07', description: 'Expense', counterparty: 'JODI', amount: -3000.00, bank_name: 'Chase', category: 'cogs', subcategory: 'contractor', notes: null, ref_key: 'tasha-cogs-26' },
  { transaction_date: '2025-07-31', description: 'Expense', counterparty: 'Upwork', amount: -29.99, bank_name: 'American Express', category: 'cogs', subcategory: 'contractor', notes: null, ref_key: 'tasha-cogs-27' },
  { transaction_date: '2025-08-04', description: 'Expense', counterparty: 'Upwork', amount: -29.99, bank_name: 'Chase', category: 'cogs', subcategory: 'contractor', notes: null, ref_key: 'tasha-cogs-28' },
  { transaction_date: '2025-08-04', description: 'Expense', counterparty: 'Luca DeG', amount: -4000.00, bank_name: 'Chase', category: 'cogs', subcategory: 'contractor', notes: null, ref_key: 'tasha-cogs-29' },
  { transaction_date: '2025-08-06', description: 'Expense', counterparty: 'Christopher Dillon', amount: -210.00, bank_name: 'Chase', category: 'cogs', subcategory: 'contractor', notes: null, ref_key: 'tasha-cogs-30' },
  { transaction_date: '2025-08-11', description: 'Expense', counterparty: 'JODI', amount: -3000.00, bank_name: 'Chase', category: 'cogs', subcategory: 'contractor', notes: null, ref_key: 'tasha-cogs-31' },
  { transaction_date: '2025-09-02', description: 'Expense', counterparty: 'Luca DeG', amount: -4000.00, bank_name: 'Chase', category: 'cogs', subcategory: 'contractor', notes: null, ref_key: 'tasha-cogs-32' },
  { transaction_date: '2025-09-03', description: 'Expense', counterparty: 'JODI', amount: -3000.00, bank_name: 'Chase', category: 'cogs', subcategory: 'contractor', notes: null, ref_key: 'tasha-cogs-33' },
  { transaction_date: '2025-09-25', description: 'Expense', counterparty: 'Luca DeG', amount: -122.00, bank_name: 'Chase', category: 'cogs', subcategory: 'contractor', notes: null, ref_key: 'tasha-cogs-34' },
  { transaction_date: '2025-10-01', description: 'Expense', counterparty: 'Luca DeG', amount: -4000.00, bank_name: 'Chase', category: 'cogs', subcategory: 'contractor', notes: null, ref_key: 'tasha-cogs-35' },
  { transaction_date: '2025-10-03', description: 'Expense', counterparty: 'Fiverr', amount: -316.50, bank_name: 'Chase', category: 'cogs', subcategory: 'contractor', notes: null, ref_key: 'tasha-cogs-36' },
  { transaction_date: '2025-10-07', description: 'Expense', counterparty: 'JODI', amount: -3717.92, bank_name: 'Chase', category: 'cogs', subcategory: 'contractor', notes: null, ref_key: 'tasha-cogs-37' },
  { transaction_date: '2025-10-09', description: 'Expense', counterparty: 'Janet Durate', amount: -600.00, bank_name: 'Chase', category: 'cogs', subcategory: 'contractor', notes: null, ref_key: 'tasha-cogs-38' },
  { transaction_date: '2025-10-31', description: 'Expense', counterparty: 'JODI', amount: -8217.92, bank_name: 'Chase', category: 'cogs', subcategory: 'contractor', notes: null, ref_key: 'tasha-cogs-39' },
  { transaction_date: '2025-11-03', description: 'Expense', counterparty: 'Luca DeG', amount: -4000.00, bank_name: 'Chase', category: 'cogs', subcategory: 'contractor', notes: null, ref_key: 'tasha-cogs-40' },
  { transaction_date: '2025-11-05', description: 'Expense', counterparty: 'Luca DeG', amount: -60.99, bank_name: 'Chase', category: 'cogs', subcategory: 'contractor', notes: null, ref_key: 'tasha-cogs-41' },
  { transaction_date: '2025-11-12', description: 'Expense', counterparty: 'Upwork', amount: -1085.31, bank_name: 'Chase', category: 'cogs', subcategory: 'contractor', notes: null, ref_key: 'tasha-cogs-42' },
  { transaction_date: '2025-11-12', description: 'Expense', counterparty: 'Luca DeG', amount: -220.99, bank_name: 'Chase', category: 'cogs', subcategory: 'contractor', notes: null, ref_key: 'tasha-cogs-43' },
  { transaction_date: '2025-11-13', description: 'Expense', counterparty: 'Upwork', amount: -1059.99, bank_name: 'Chase', category: 'cogs', subcategory: 'contractor', notes: null, ref_key: 'tasha-cogs-44' },
  { transaction_date: '2025-11-14', description: 'Expense', counterparty: 'Luca DeG', amount: -10.95, bank_name: 'Chase', category: 'cogs', subcategory: 'contractor', notes: null, ref_key: 'tasha-cogs-45' },
  { transaction_date: '2025-11-17', description: 'Expense', counterparty: 'Upwork', amount: -525.00, bank_name: 'Chase', category: 'cogs', subcategory: 'contractor', notes: null, ref_key: 'tasha-cogs-46' },
  { transaction_date: '2025-11-18', description: 'Expense', counterparty: 'Upwork', amount: -212.12, bank_name: 'Chase', category: 'cogs', subcategory: 'contractor', notes: null, ref_key: 'tasha-cogs-47' },
  { transaction_date: '2025-11-18', description: 'Expense', counterparty: 'Luca DeG', amount: -10.95, bank_name: 'Chase', category: 'cogs', subcategory: 'contractor', notes: null, ref_key: 'tasha-cogs-48' },
  { transaction_date: '2025-11-19', description: 'Expense', counterparty: 'Luca DeG', amount: -221.00, bank_name: 'Chase', category: 'cogs', subcategory: 'contractor', notes: null, ref_key: 'tasha-cogs-49' },
  { transaction_date: '2025-12-01', description: 'Expense', counterparty: 'Luca DeG', amount: -4000.00, bank_name: 'Chase', category: 'cogs', subcategory: 'contractor', notes: null, ref_key: 'tasha-cogs-50' },
  { transaction_date: '2025-12-05', description: 'Expense', counterparty: 'Luca DeG', amount: -61.00, bank_name: 'Chase', category: 'cogs', subcategory: 'contractor', notes: null, ref_key: 'tasha-cogs-51' },
  { transaction_date: '2025-12-09', description: 'Expense', counterparty: 'Upwork', amount: -525.00, bank_name: 'Chase', category: 'cogs', subcategory: 'contractor', notes: null, ref_key: 'tasha-cogs-52' },
  { transaction_date: '2025-12-09', description: 'Expense', counterparty: 'Upwork', amount: -106.24, bank_name: 'Chase', category: 'cogs', subcategory: 'contractor', notes: null, ref_key: 'tasha-cogs-53' },
  { transaction_date: '2025-12-09', description: 'Expense', counterparty: 'JODI', amount: -3217.92, bank_name: 'Chase', category: 'cogs', subcategory: 'contractor', notes: null, ref_key: 'tasha-cogs-54' },
  { transaction_date: '2025-12-12', description: 'Expense', counterparty: 'Luca DeG', amount: -61.00, bank_name: 'Chase', category: 'cogs', subcategory: 'contractor', notes: null, ref_key: 'tasha-cogs-55' },
  { transaction_date: '2025-12-15', description: 'Expense', counterparty: 'Upwork', amount: -366.12, bank_name: 'Chase', category: 'cogs', subcategory: 'contractor', notes: null, ref_key: 'tasha-cogs-56' },
  { transaction_date: '2025-12-16', description: 'Expense', counterparty: 'Janet Durate', amount: -1050.00, bank_name: 'Chase', category: 'cogs', subcategory: 'contractor', notes: null, ref_key: 'tasha-cogs-57' },
  { transaction_date: '2025-12-23', description: 'Expense', counterparty: 'Upwork', amount: -48.12, bank_name: 'Chase', category: 'cogs', subcategory: 'contractor', notes: null, ref_key: 'tasha-cogs-58' },
  { transaction_date: '2025-12-23', description: 'Expense', counterparty: 'Luca DeG', amount: -1092.00, bank_name: 'Chase', category: 'cogs', subcategory: 'contractor', notes: null, ref_key: 'tasha-cogs-59' },
  { transaction_date: '2025-12-29', description: 'Expense', counterparty: 'Luca DeG', amount: -88.00, bank_name: 'Chase', category: 'cogs', subcategory: 'contractor', notes: null, ref_key: 'tasha-cogs-60' },

  // ── Uncategorized Income (25 transactions, $53,187.42) ─────────────────────
  { transaction_date: '2025-02-05', description: 'Deposit', counterparty: 'Wise Inc', amount: 1500.87, bank_name: 'Mercury', category: 'uncategorized', subcategory: null, notes: 'Tax Return', ref_key: 'tasha-uninc-0' },
  { transaction_date: '2025-02-10', description: 'Deposit', counterparty: 'OPENMINDWARE LLC', amount: 250.00, bank_name: 'Mercury', category: 'uncategorized', subcategory: null, notes: 'Cash Bonus', ref_key: 'tasha-uninc-1' },
  { transaction_date: '2025-03-04', description: 'Other Income', counterparty: 'Mercury', amount: 250.00, bank_name: 'Mercury', category: 'uncategorized', subcategory: null, notes: 'Cash Bonus', ref_key: 'tasha-uninc-2' },
  { transaction_date: '2025-03-17', description: 'Deposit', counterparty: 'Bontempo Panico Raffaele LLC', amount: 250.00, bank_name: 'Mercury', category: 'uncategorized', subcategory: null, notes: 'Cash Bonus', ref_key: 'tasha-uninc-3' },
  { transaction_date: '2025-03-18', description: 'Refund/Credit', counterparty: 'American Express', amount: 4952.02, bank_name: 'American Express', category: 'uncategorized', subcategory: null, notes: "We couldn't find the Amex payments in books", ref_key: 'tasha-uninc-4' },
  { transaction_date: '2025-03-22', description: 'Refund/Credit', counterparty: 'CC Payments', amount: 10000.00, bank_name: 'American Express', category: 'uncategorized', subcategory: null, notes: "We couldn't find the Amex payments in books", ref_key: 'tasha-uninc-5' },
  { transaction_date: '2025-03-29', description: 'Refund/Credit', counterparty: 'American Express', amount: 2000.00, bank_name: 'American Express', category: 'uncategorized', subcategory: null, notes: "We couldn't find the Amex payments in books", ref_key: 'tasha-uninc-6' },
  { transaction_date: '2025-04-01', description: 'Other Income', counterparty: 'Mercury', amount: 849.00, bank_name: 'Mercury', category: 'uncategorized', subcategory: null, notes: 'Annual renewal', ref_key: 'tasha-uninc-7' },
  { transaction_date: '2025-04-04', description: 'Deposit', counterparty: 'LU.VI.RO.PE Investments LLC', amount: 34.00, bank_name: 'Relay', category: 'uncategorized', subcategory: null, notes: 'Cash Bonus', ref_key: 'tasha-uninc-8' },
  { transaction_date: '2025-04-10', description: 'Other Income', counterparty: 'Mercury', amount: 1000.00, bank_name: 'Mercury', category: 'uncategorized', subcategory: null, notes: 'Annual renewal', ref_key: 'tasha-uninc-9' },
  { transaction_date: '2025-04-18', description: 'Refund/Credit', counterparty: 'CC Payments', amount: 5773.01, bank_name: 'American Express', category: 'uncategorized', subcategory: null, notes: "We couldn't find the Amex payments in books", ref_key: 'tasha-uninc-10' },
  { transaction_date: '2025-04-29', description: 'Refund/Credit', counterparty: 'CC Payments', amount: 1940.40, bank_name: 'American Express', category: 'uncategorized', subcategory: null, notes: "We couldn't find the Amex payments in books", ref_key: 'tasha-uninc-11' },
  { transaction_date: '2025-05-15', description: 'Refund/Credit', counterparty: 'CC Payments', amount: 5000.00, bank_name: 'American Express', category: 'uncategorized', subcategory: null, notes: "We couldn't find the Amex payments in books", ref_key: 'tasha-uninc-12' },
  { transaction_date: '2025-05-19', description: 'Other Income', counterparty: 'Mercury', amount: 250.00, bank_name: 'Mercury', category: 'uncategorized', subcategory: null, notes: 'Cash Bonus', ref_key: 'tasha-uninc-13' },
  { transaction_date: '2025-06-01', description: 'Refund/Credit', counterparty: 'CC Payments', amount: 4000.00, bank_name: 'American Express', category: 'uncategorized', subcategory: null, notes: "We couldn't find the Amex payments in books", ref_key: 'tasha-uninc-14' },
  { transaction_date: '2025-06-18', description: 'Deposit', counterparty: 'Chase', amount: 2000.00, bank_name: 'Chase', category: 'uncategorized', subcategory: null, notes: 'No payment detail', ref_key: 'tasha-uninc-15' },
  { transaction_date: '2025-06-23', description: 'Other Income', counterparty: 'Mercury', amount: 250.00, bank_name: 'Mercury', category: 'uncategorized', subcategory: null, notes: 'Cash Bonus', ref_key: 'tasha-uninc-16' },
  { transaction_date: '2025-07-03', description: 'Refund/Credit', counterparty: 'American Express', amount: 3000.00, bank_name: 'American Express', category: 'uncategorized', subcategory: null, notes: "We couldn't find the Amex payments in books", ref_key: 'tasha-uninc-17' },
  { transaction_date: '2025-07-23', description: 'Other Income', counterparty: 'Mercury', amount: 250.00, bank_name: 'Mercury', category: 'uncategorized', subcategory: null, notes: 'Cash Bonus', ref_key: 'tasha-uninc-18' },
  { transaction_date: '2025-08-15', description: 'Deposit', counterparty: 'Relay', amount: 3154.21, bank_name: 'Relay', category: 'uncategorized', subcategory: null, notes: 'July 2025 Partner Program payout', ref_key: 'tasha-uninc-19' },
  { transaction_date: '2025-09-16', description: 'Deposit', counterparty: 'Orion Trade Dynamics LLC', amount: 250.00, bank_name: 'Mercury', category: 'uncategorized', subcategory: null, notes: 'Cash Bonus', ref_key: 'tasha-uninc-20' },
  { transaction_date: '2025-09-17', description: 'Refund/Credit', counterparty: 'CC Payments', amount: 3000.00, bank_name: 'American Express', category: 'uncategorized', subcategory: null, notes: "We couldn't find the Amex payments in books", ref_key: 'tasha-uninc-21' },
  { transaction_date: '2025-10-07', description: 'Refund/Credit', counterparty: 'CC Payments', amount: 2733.91, bank_name: 'American Express', category: 'uncategorized', subcategory: null, notes: "We couldn't find the Amex payments in books", ref_key: 'tasha-uninc-22' },
  { transaction_date: '2025-10-17', description: 'Deposit', counterparty: 'AX Consulting LLC', amount: 250.00, bank_name: 'Mercury', category: 'uncategorized', subcategory: null, notes: 'Cash Bonus', ref_key: 'tasha-uninc-23' },
  { transaction_date: '2025-10-21', description: 'Other Income', counterparty: 'Mercury', amount: 250.00, bank_name: 'Mercury', category: 'uncategorized', subcategory: null, notes: 'Cash Bonus', ref_key: 'tasha-uninc-24' },

  // ── Uncategorized Expense (96 transactions, needs review) ──────────────────
  { transaction_date: '2025-01-01', description: 'Refund/Credit', counterparty: 'American Express', amount: 3000.00, bank_name: 'American Express', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-0' },
  { transaction_date: '2025-01-01', description: 'Expense', counterparty: 'Zoho-One', amount: -29.61, bank_name: 'American Express', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-1' },
  { transaction_date: '2025-01-02', description: 'Expense', counterparty: 'Financialot LLC', amount: -1000.00, bank_name: 'Mercury', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-2' },
  { transaction_date: '2025-01-05', description: 'Expense', counterparty: 'Zoho-One', amount: -270.00, bank_name: 'American Express', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-3' },
  { transaction_date: '2025-01-05', description: 'Expense', counterparty: 'Kanes Furniture', amount: -2125.98, bank_name: 'American Express', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-4' },
  { transaction_date: '2025-01-08', description: 'Expense', counterparty: 'GroupOn Inc', amount: -56.69, bank_name: 'American Express', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-5' },
  { transaction_date: '2025-01-20', description: 'Expense', counterparty: 'Financialot LLC', amount: -1000.00, bank_name: 'Mercury', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-6' },
  { transaction_date: '2025-01-22', description: 'Expense', counterparty: 'American Express', amount: -500.00, bank_name: 'Chase', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-7' },
  { transaction_date: '2025-01-27', description: 'Expense', counterparty: 'Chase', amount: -20000.00, bank_name: 'Chase', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-8' },
  { transaction_date: '2025-01-28', description: 'Expense', counterparty: 'EMD Advisory Services', amount: -3177.66, bank_name: 'Mercury', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-9' },
  { transaction_date: '2025-01-31', description: 'Expense', counterparty: 'Financialot LLC', amount: -1860.00, bank_name: 'Mercury', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-10' },
  { transaction_date: '2025-02-02', description: 'Expense', counterparty: 'Linkedin', amount: -490.00, bank_name: 'American Express', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-11' },
  { transaction_date: '2025-02-02', description: 'Expense', counterparty: 'italki HK Limited', amount: -50.55, bank_name: 'American Express', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-12' },
  { transaction_date: '2025-02-03', description: 'Expense Refund', counterparty: 'Mercury', amount: 11.29, bank_name: 'Mercury', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-13' },
  { transaction_date: '2025-02-05', description: 'Expense', counterparty: 'Zoho-One', amount: -216.00, bank_name: 'American Express', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-14' },
  { transaction_date: '2025-02-07', description: 'Expense', counterparty: 'Linkedin', amount: -590.00, bank_name: 'American Express', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-15' },
  { transaction_date: '2025-02-13', description: 'Expense', counterparty: 'Paypal', amount: -300.00, bank_name: 'American Express', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-16' },
  { transaction_date: '2025-02-21', description: 'Expense', counterparty: 'Mercury', amount: -20000.00, bank_name: 'Mercury', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-17' },
  { transaction_date: '2025-02-26', description: 'Expense', counterparty: 'Zoho-One', amount: -36.64, bank_name: 'American Express', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-18' },
  { transaction_date: '2025-02-27', description: 'Expense', counterparty: 'Mercury', amount: -25000.00, bank_name: 'Mercury', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-19' },
  { transaction_date: '2025-02-28', description: 'Expense', counterparty: 'Financialot LLC', amount: -1522.01, bank_name: 'Mercury', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-20' },
  { transaction_date: '2025-02-28', description: 'Expense Refund', counterparty: 'Mercury', amount: 1522.01, bank_name: 'Mercury', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-21' },
  { transaction_date: '2025-03-04', description: 'Expense', counterparty: 'Financialot LLC', amount: -1220.10, bank_name: 'Mercury', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-22' },
  { transaction_date: '2025-03-12', description: 'Expense', counterparty: 'Zoho-One', amount: -9.64, bank_name: 'American Express', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-23' },
  { transaction_date: '2025-03-17', description: 'Expense', counterparty: 'Zoho-One', amount: -432.00, bank_name: 'American Express', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-24' },
  { transaction_date: '2025-03-20', description: 'Expense', counterparty: 'TAX ALCHEMY', amount: -12000.00, bank_name: 'American Express', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-25' },
  { transaction_date: '2025-03-30', description: 'Expense', counterparty: 'Wise', amount: -31.00, bank_name: 'Chase', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-26' },
  { transaction_date: '2025-04-02', description: 'Expense', counterparty: 'Applecard', amount: -1117.31, bank_name: 'Chase', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-27' },
  { transaction_date: '2025-04-06', description: 'Refund/Credit', counterparty: 'Wise', amount: 31.00, bank_name: 'Chase', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-28' },
  { transaction_date: '2025-04-07', description: 'Expense', counterparty: 'American National Title', amount: -3000.00, bank_name: 'Mercury', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-29' },
  { transaction_date: '2025-04-07', description: 'Expense', counterparty: 'Zoho-One', amount: -17.42, bank_name: 'American Express', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-30' },
  { transaction_date: '2025-04-08', description: 'Expense', counterparty: 'American National Title', amount: -3000.00, bank_name: 'Mercury', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-31' },
  { transaction_date: '2025-04-17', description: 'Expense', counterparty: 'Zoho-One', amount: -378.00, bank_name: 'American Express', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-32' },
  { transaction_date: '2025-04-18', description: 'Expense', counterparty: 'Chase', amount: -400.00, bank_name: 'Chase', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-33' },
  { transaction_date: '2025-05-05', description: 'Expense', counterparty: 'Tasca Buick GMC Clearwater', amount: -111.87, bank_name: 'American Express', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-34' },
  { transaction_date: '2025-05-17', description: 'Expense', counterparty: 'Zoho-One', amount: -216.00, bank_name: 'American Express', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-35' },
  { transaction_date: '2025-05-21', description: 'Expense', counterparty: 'American National Title', amount: -29032.53, bank_name: 'Chase', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-36' },
  { transaction_date: '2025-05-27', description: 'Expense', counterparty: 'ATM WIthdrawal', amount: -1000.00, bank_name: 'Chase', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-37' },
  { transaction_date: '2025-05-29', description: 'Expense', counterparty: 'American Express', amount: -149.99, bank_name: 'American Express', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-38' },
  { transaction_date: '2025-05-29', description: 'Expense', counterparty: 'Tobacconist Gran Vía 50', amount: -8.62, bank_name: 'American Express', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-39' },
  { transaction_date: '2025-05-31', description: 'Expense', counterparty: 'American Express', amount: -34.05, bank_name: 'American Express', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-40' },
  { transaction_date: '2025-06-01', description: 'Expense', counterparty: 'Chase', amount: -136.70, bank_name: 'Chase', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-41' },
  { transaction_date: '2025-06-02', description: 'Expense', counterparty: 'Arenal', amount: -22.21, bank_name: 'Chase', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-42' },
  { transaction_date: '2025-06-03', description: 'Expense', counterparty: 'Expendeduria', amount: -94.20, bank_name: 'Chase', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-43' },
  { transaction_date: '2025-06-04', description: 'Expense', counterparty: 'First Citizen Bank', amount: -1000.00, bank_name: 'Chase', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-44' },
  { transaction_date: '2025-06-06', description: 'Expense', counterparty: 'Wise', amount: -31.00, bank_name: 'Chase', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-45' },
  { transaction_date: '2025-06-08', description: 'Refund/Credit', counterparty: 'Chase', amount: 31.00, bank_name: 'Chase', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-46' },
  { transaction_date: '2025-06-12', description: 'Expense', counterparty: 'SockVibe LLC', amount: -64.94, bank_name: 'American Express', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-47' },
  { transaction_date: '2025-06-15', description: 'Expense', counterparty: 'Vettaflo', amount: -125.10, bank_name: 'American Express', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-48' },
  { transaction_date: '2025-06-17', description: 'Expense', counterparty: 'Zoho-One', amount: -216.00, bank_name: 'American Express', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-49' },
  { transaction_date: '2025-06-17', description: 'Refund/Credit', counterparty: 'American Express', amount: 3000.00, bank_name: 'American Express', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-50' },
  { transaction_date: '2025-06-22', description: 'Expense', counterparty: 'Zoho-One', amount: -3.33, bank_name: 'American Express', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-51' },
  { transaction_date: '2025-06-22', description: 'Expense', counterparty: 'Zoho-One', amount: -3.33, bank_name: 'American Express', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-52' },
  { transaction_date: '2025-06-22', description: 'Expense', counterparty: 'Zoho-One', amount: -3.33, bank_name: 'American Express', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-53' },
  { transaction_date: '2025-06-25', description: 'Expense', counterparty: 'Zoho-One', amount: -2.93, bank_name: 'American Express', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-54' },
  { transaction_date: '2025-06-27', description: 'Expense', counterparty: 'First Citizen Bank', amount: -2000.00, bank_name: 'Chase', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-55' },
  { transaction_date: '2025-07-07', description: 'Expense', counterparty: 'American Express', amount: -5.67, bank_name: 'Chase', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-56' },
  { transaction_date: '2025-07-17', description: 'Expense', counterparty: 'Zoho-One', amount: -232.00, bank_name: 'American Express', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-57' },
  { transaction_date: '2025-07-19', description: 'Refund/Credit', counterparty: 'American Express', amount: 69.00, bank_name: 'American Express', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-58' },
  { transaction_date: '2025-07-24', description: 'Expense', counterparty: 'Floor Covering', amount: -2250.30, bank_name: 'Chase', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-59' },
  { transaction_date: '2025-07-26', description: 'Expense', counterparty: 'AutoNation Toyota', amount: -2000.00, bank_name: 'American Express', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-60' },
  { transaction_date: '2025-07-28', description: 'Expense', counterparty: 'Zoho-One', amount: -34.84, bank_name: 'American Express', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-61' },
  { transaction_date: '2025-07-30', description: 'Expense', counterparty: 'Zoho-One', amount: -31.35, bank_name: 'American Express', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-62' },
  { transaction_date: '2025-08-02', description: 'Refund/Credit', counterparty: 'American Express', amount: 5756.69, bank_name: 'American Express', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-63' },
  { transaction_date: '2025-08-17', description: 'Expense', counterparty: 'Zoho-One', amount: -340.00, bank_name: 'American Express', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-64' },
  { transaction_date: '2025-08-19', description: 'Refund/Credit', counterparty: 'American Express', amount: 3000.00, bank_name: 'American Express', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-65' },
  { transaction_date: '2025-08-25', description: 'Expense', counterparty: 'Color Service LLC', amount: -150.00, bank_name: 'American Express', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-66' },
  { transaction_date: '2025-08-26', description: 'Expense', counterparty: 'DeP Consulting', amount: -250.00, bank_name: 'Mercury', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-67' },
  { transaction_date: '2025-09-03', description: 'Expense', counterparty: 'American Express', amount: -69.16, bank_name: 'American Express', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-68' },
  { transaction_date: '2025-09-07', description: 'Expense', counterparty: 'italki HK Limited', amount: -7.61, bank_name: 'American Express', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-69' },
  { transaction_date: '2025-09-10', description: 'Expense', counterparty: 'Color Service LLC', amount: -150.00, bank_name: 'American Express', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-70' },
  { transaction_date: '2025-09-11', description: 'Expense', counterparty: 'italki HK Limited', amount: -57.88, bank_name: 'American Express', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-71' },
  { transaction_date: '2025-09-17', description: 'Expense', counterparty: 'Zoho-One', amount: -270.00, bank_name: 'American Express', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-72' },
  { transaction_date: '2025-09-17', description: 'Expense', counterparty: 'R.A.D Wilmington', amount: -160.50, bank_name: 'American Express', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-73' },
  { transaction_date: '2025-09-22', description: 'Expense', counterparty: 'Color Service LLC', amount: -165.00, bank_name: 'American Express', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-74' },
  { transaction_date: '2025-09-27', description: 'Expense', counterparty: 'R.A.D Wilmington', amount: -167.98, bank_name: 'American Express', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-75' },
  { transaction_date: '2025-09-29', description: 'Expense', counterparty: 'Paypal', amount: -250.00, bank_name: 'American Express', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-76' },
  { transaction_date: '2025-10-03', description: 'Expense', counterparty: 'Paypal', amount: -250.00, bank_name: 'American Express', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-77' },
  { transaction_date: '2025-10-08', description: 'Expense', counterparty: 'Applecard', amount: -1149.52, bank_name: 'Chase', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-78' },
  { transaction_date: '2025-10-08', description: 'Expense', counterparty: 'Chase', amount: -150.00, bank_name: 'Chase', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-79' },
  { transaction_date: '2025-10-10', description: 'Expense', counterparty: 'SuncoastCU', amount: -1564.82, bank_name: 'Chase', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-80' },
  { transaction_date: '2025-10-13', description: 'Expense', counterparty: 'Purpmaker', amount: -214.00, bank_name: 'Chase', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-81' },
  { transaction_date: '2025-10-17', description: 'Refund/Credit', counterparty: 'R.A.D Wilmington', amount: 153.50, bank_name: 'American Express', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-82' },
  { transaction_date: '2025-10-30', description: 'Expense', counterparty: 'Chase', amount: -1000.00, bank_name: 'Chase', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-83' },
  { transaction_date: '2025-10-31', description: 'Expense', counterparty: 'Check', amount: -300.00, bank_name: 'Chase', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-84' },
  { transaction_date: '2025-11-05', description: 'Expense', counterparty: 'Chase', amount: -1500.00, bank_name: 'Chase', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-85' },
  { transaction_date: '2025-11-07', description: 'Expense', counterparty: 'James', amount: -7000.00, bank_name: 'Relay', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-86' },
  { transaction_date: '2025-11-12', description: 'Expense', counterparty: 'Chase', amount: -2000.00, bank_name: 'Chase', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-87' },
  { transaction_date: '2025-11-18', description: 'Expense', counterparty: 'Chase', amount: -1000.00, bank_name: 'Chase', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-88' },
  { transaction_date: '2025-11-24', description: 'Expense', counterparty: 'Emanuele Ripari', amount: -200.00, bank_name: 'Chase', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-89' },
  { transaction_date: '2025-11-25', description: 'Expense', counterparty: 'Digital Title Solution', amount: -5000.00, bank_name: 'Mercury', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-90' },
  { transaction_date: '2025-12-01', description: 'Expense', counterparty: 'Chase', amount: -2000.00, bank_name: 'Chase', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-91' },
  { transaction_date: '2025-12-04', description: 'Expense', counterparty: 'Chase', amount: -2000.00, bank_name: 'Chase', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-92' },
  { transaction_date: '2025-12-12', description: 'Expense', counterparty: 'SuncoastCU', amount: -270.96, bank_name: 'Chase', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-93' },
  { transaction_date: '2025-12-12', description: 'Expense', counterparty: 'SuncoastCU', amount: -1564.82, bank_name: 'Chase', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-94' },
  { transaction_date: '2025-12-15', description: 'Expense', counterparty: 'Chase', amount: -2000.00, bank_name: 'Chase', category: 'uncategorized', subcategory: null, notes: null, ref_key: 'tasha-unexp-95' },

  // ── Partner Distribution (54 transactions) ────────────────────────────────
  { transaction_date: '2025-01-01', description: 'Owners Drawings', counterparty: 'American Express', amount: -62.25, bank_name: 'American Express', category: 'personal', subcategory: 'distribution', notes: null, ref_key: 'tasha-pd-0' },
  { transaction_date: '2025-01-01', description: 'Owners Drawings', counterparty: 'American Express', amount: -300.35, bank_name: 'American Express', category: 'personal', subcategory: 'distribution', notes: null, ref_key: 'tasha-pd-1' },
  { transaction_date: '2025-01-01', description: 'Owners Drawings', counterparty: 'American Express', amount: -67.41, bank_name: 'American Express', category: 'personal', subcategory: 'distribution', notes: null, ref_key: 'tasha-pd-2' },
  { transaction_date: '2025-01-02', description: 'Owners Drawings', counterparty: 'American Express', amount: -21.18, bank_name: 'American Express', category: 'personal', subcategory: 'distribution', notes: null, ref_key: 'tasha-pd-3' },
  { transaction_date: '2025-01-03', description: 'Owners Contribution', counterparty: 'Chase', amount: 210.00, bank_name: 'Chase', category: 'personal', subcategory: 'contribution', notes: null, ref_key: 'tasha-pd-4' },
  { transaction_date: '2025-01-05', description: 'Owners Drawings', counterparty: 'American Express', amount: -97.00, bank_name: 'American Express', category: 'personal', subcategory: 'distribution', notes: null, ref_key: 'tasha-pd-5' },
  { transaction_date: '2025-01-06', description: 'Owners Drawings', counterparty: 'Chase', amount: -2500.00, bank_name: 'Chase', category: 'personal', subcategory: 'distribution', notes: null, ref_key: 'tasha-pd-6' },
  { transaction_date: '2025-01-09', description: 'Owners Drawings', counterparty: 'Relay', amount: -200.00, bank_name: 'Relay', category: 'personal', subcategory: 'distribution', notes: null, ref_key: 'tasha-pd-7' },
  { transaction_date: '2025-01-09', description: 'Owners Drawings', counterparty: 'Chase', amount: -88.00, bank_name: 'Chase', category: 'personal', subcategory: 'distribution', notes: null, ref_key: 'tasha-pd-8' },
  { transaction_date: '2025-01-14', description: 'Owners Drawings', counterparty: 'Chase', amount: -90.00, bank_name: 'Chase', category: 'personal', subcategory: 'distribution', notes: null, ref_key: 'tasha-pd-9' },
  { transaction_date: '2025-01-16', description: 'Owners Drawings', counterparty: 'Chase', amount: -25.00, bank_name: 'Chase', category: 'personal', subcategory: 'distribution', notes: null, ref_key: 'tasha-pd-10' },
  { transaction_date: '2025-01-17', description: 'Owners Drawings', counterparty: 'Relay', amount: -1600.00, bank_name: 'Relay', category: 'personal', subcategory: 'distribution', notes: null, ref_key: 'tasha-pd-11' },
  { transaction_date: '2025-01-23', description: 'Owners Drawings', counterparty: 'Chase', amount: -34.24, bank_name: 'Chase', category: 'personal', subcategory: 'distribution', notes: null, ref_key: 'tasha-pd-12' },
  { transaction_date: '2025-01-23', description: 'Owners Drawings', counterparty: 'Chase', amount: -25.00, bank_name: 'Chase', category: 'personal', subcategory: 'distribution', notes: null, ref_key: 'tasha-pd-13' },
  { transaction_date: '2025-02-01', description: 'Owners Drawings', counterparty: 'American Express', amount: -42.37, bank_name: 'American Express', category: 'personal', subcategory: 'distribution', notes: null, ref_key: 'tasha-pd-14' },
  { transaction_date: '2025-02-10', description: 'Owners Drawings', counterparty: 'American Express', amount: -90.00, bank_name: 'American Express', category: 'personal', subcategory: 'distribution', notes: null, ref_key: 'tasha-pd-15' },
  { transaction_date: '2025-03-01', description: 'Owners Drawings', counterparty: 'American Express', amount: -42.37, bank_name: 'American Express', category: 'personal', subcategory: 'distribution', notes: null, ref_key: 'tasha-pd-16' },
  { transaction_date: '2025-03-15', description: 'Owners Drawings', counterparty: 'American Express', amount: -389.00, bank_name: 'American Express', category: 'personal', subcategory: 'distribution', notes: null, ref_key: 'tasha-pd-17' },
  { transaction_date: '2025-03-16', description: 'Owners Drawings', counterparty: 'Chase', amount: -196.60, bank_name: 'Chase', category: 'personal', subcategory: 'distribution', notes: null, ref_key: 'tasha-pd-18' },
  { transaction_date: '2025-03-24', description: 'Owners Drawings', counterparty: 'American Express', amount: -119.00, bank_name: 'American Express', category: 'personal', subcategory: 'distribution', notes: null, ref_key: 'tasha-pd-19' },
  { transaction_date: '2025-04-01', description: 'Owners Drawings', counterparty: 'American Express', amount: -42.37, bank_name: 'American Express', category: 'personal', subcategory: 'distribution', notes: null, ref_key: 'tasha-pd-20' },
  { transaction_date: '2025-04-24', description: 'Owners Drawings', counterparty: 'Chase', amount: -50.00, bank_name: 'Chase', category: 'personal', subcategory: 'distribution', notes: null, ref_key: 'tasha-pd-21' },
  { transaction_date: '2025-04-24', description: 'Owners Drawings', counterparty: 'Chase', amount: -8.28, bank_name: 'Chase', category: 'personal', subcategory: 'distribution', notes: null, ref_key: 'tasha-pd-22' },
  { transaction_date: '2025-05-01', description: 'Owners Drawings', counterparty: 'American Express', amount: -42.37, bank_name: 'American Express', category: 'personal', subcategory: 'distribution', notes: null, ref_key: 'tasha-pd-23' },
  { transaction_date: '2025-05-14', description: 'Owners Drawings', counterparty: 'Chase', amount: -50.00, bank_name: 'Chase', category: 'personal', subcategory: 'distribution', notes: null, ref_key: 'tasha-pd-24' },
  { transaction_date: '2025-05-14', description: 'Owners Drawings', counterparty: 'Chase', amount: -8.28, bank_name: 'Chase', category: 'personal', subcategory: 'distribution', notes: null, ref_key: 'tasha-pd-25' },
  { transaction_date: '2025-06-01', description: 'Owners Drawings', counterparty: 'American Express', amount: -42.37, bank_name: 'American Express', category: 'personal', subcategory: 'distribution', notes: null, ref_key: 'tasha-pd-26' },
  { transaction_date: '2025-06-12', description: 'Owners Drawings', counterparty: 'Chase', amount: -50.00, bank_name: 'Chase', category: 'personal', subcategory: 'distribution', notes: null, ref_key: 'tasha-pd-27' },
  { transaction_date: '2025-06-12', description: 'Owners Drawings', counterparty: 'Chase', amount: -8.28, bank_name: 'Chase', category: 'personal', subcategory: 'distribution', notes: null, ref_key: 'tasha-pd-28' },
  { transaction_date: '2025-07-01', description: 'Owners Drawings', counterparty: 'American Express', amount: -42.37, bank_name: 'American Express', category: 'personal', subcategory: 'distribution', notes: null, ref_key: 'tasha-pd-29' },
  { transaction_date: '2025-07-09', description: 'Owners Drawings', counterparty: 'Chase', amount: -50.00, bank_name: 'Chase', category: 'personal', subcategory: 'distribution', notes: null, ref_key: 'tasha-pd-30' },
  { transaction_date: '2025-07-09', description: 'Owners Drawings', counterparty: 'Chase', amount: -8.28, bank_name: 'Chase', category: 'personal', subcategory: 'distribution', notes: null, ref_key: 'tasha-pd-31' },
  { transaction_date: '2025-07-10', description: 'Owners Drawings', counterparty: 'Chase', amount: -25.00, bank_name: 'Chase', category: 'personal', subcategory: 'distribution', notes: null, ref_key: 'tasha-pd-32' },
  { transaction_date: '2025-07-18', description: 'Owners Drawings', counterparty: 'Chase', amount: -2500.00, bank_name: 'Chase', category: 'personal', subcategory: 'distribution', notes: null, ref_key: 'tasha-pd-33' },
  { transaction_date: '2025-07-22', description: 'Owners Drawings', counterparty: 'Chase', amount: -50.00, bank_name: 'Chase', category: 'personal', subcategory: 'distribution', notes: null, ref_key: 'tasha-pd-34' },
  { transaction_date: '2025-07-22', description: 'Owners Drawings', counterparty: 'Chase', amount: -8.28, bank_name: 'Chase', category: 'personal', subcategory: 'distribution', notes: null, ref_key: 'tasha-pd-35' },
  { transaction_date: '2025-08-01', description: 'Owners Drawings', counterparty: 'American Express', amount: -42.37, bank_name: 'American Express', category: 'personal', subcategory: 'distribution', notes: null, ref_key: 'tasha-pd-36' },
  { transaction_date: '2025-08-01', description: 'Owners Drawings', counterparty: 'American Express', amount: -42.37, bank_name: 'American Express', category: 'personal', subcategory: 'distribution', notes: null, ref_key: 'tasha-pd-37' },
  { transaction_date: '2025-08-11', description: 'Owners Drawings', counterparty: 'Chase', amount: -50.00, bank_name: 'Chase', category: 'personal', subcategory: 'distribution', notes: null, ref_key: 'tasha-pd-38' },
  { transaction_date: '2025-08-11', description: 'Owners Drawings', counterparty: 'Chase', amount: -8.28, bank_name: 'Chase', category: 'personal', subcategory: 'distribution', notes: null, ref_key: 'tasha-pd-39' },
  { transaction_date: '2025-08-12', description: 'Owners Drawings', counterparty: 'Chase', amount: -50.00, bank_name: 'Chase', category: 'personal', subcategory: 'distribution', notes: null, ref_key: 'tasha-pd-40' },
  { transaction_date: '2025-08-12', description: 'Owners Drawings', counterparty: 'Chase', amount: -8.28, bank_name: 'Chase', category: 'personal', subcategory: 'distribution', notes: null, ref_key: 'tasha-pd-41' },
  { transaction_date: '2025-08-12', description: 'Owners Drawings', counterparty: 'Chase', amount: -25.00, bank_name: 'Chase', category: 'personal', subcategory: 'distribution', notes: null, ref_key: 'tasha-pd-42' },
  { transaction_date: '2025-08-13', description: 'Owners Drawings', counterparty: 'Chase', amount: -50.00, bank_name: 'Chase', category: 'personal', subcategory: 'distribution', notes: null, ref_key: 'tasha-pd-43' },
  { transaction_date: '2025-08-13', description: 'Owners Drawings', counterparty: 'Chase', amount: -8.28, bank_name: 'Chase', category: 'personal', subcategory: 'distribution', notes: null, ref_key: 'tasha-pd-44' },
  { transaction_date: '2025-08-13', description: 'Owners Drawings', counterparty: 'Chase', amount: -50.00, bank_name: 'Chase', category: 'personal', subcategory: 'distribution', notes: null, ref_key: 'tasha-pd-45' },
  { transaction_date: '2025-08-13', description: 'Owners Drawings', counterparty: 'Chase', amount: -8.28, bank_name: 'Chase', category: 'personal', subcategory: 'distribution', notes: null, ref_key: 'tasha-pd-46' },
  { transaction_date: '2025-08-21', description: 'Owners Drawings', counterparty: 'Chase', amount: -42.37, bank_name: 'Chase', category: 'personal', subcategory: 'distribution', notes: null, ref_key: 'tasha-pd-47' },
  { transaction_date: '2025-08-25', description: 'Owners Drawings', counterparty: 'Chase', amount: -180.04, bank_name: 'Chase', category: 'personal', subcategory: 'distribution', notes: null, ref_key: 'tasha-pd-48' },
  { transaction_date: '2025-08-25', description: 'Owners Drawings', counterparty: 'American Express', amount: -79.00, bank_name: 'American Express', category: 'personal', subcategory: 'distribution', notes: null, ref_key: 'tasha-pd-49' },
  { transaction_date: '2025-09-19', description: 'Owners Drawings', counterparty: 'American Express', amount: -53.50, bank_name: 'American Express', category: 'personal', subcategory: 'distribution', notes: null, ref_key: 'tasha-pd-50' },
  { transaction_date: '2025-10-06', description: 'Owners Drawings', counterparty: 'American Express', amount: -81.22, bank_name: 'American Express', category: 'personal', subcategory: 'distribution', notes: null, ref_key: 'tasha-pd-51' },
]

async function main() {
  console.warn(`\n🔄 Importing ${TRANSACTIONS.length} transactions from Tasha's 2025 bookkeeping file...`)
  console.warn(`   COGS/contractor: ${TRANSACTIONS.filter(t => t.category === 'cogs').length}`)
  console.warn(`   Uncategorized (needs review): ${TRANSACTIONS.filter(t => t.category === 'uncategorized').length}`)
  console.warn(`   Personal draws/contributions: ${TRANSACTIONS.filter(t => t.category === 'personal').length}`)

  // Step 1: Delete old approximate transactions
  const { error: delError, count } = await supabase
    .from('bank_transactions')
    .delete({ count: 'exact' })
    .eq('account_id', OWNER_ACCOUNT_ID)
    .like('transaction_ref', 'tasha-2025-import-%')

  if (delError) {
    console.error('❌ Failed to delete old transactions:', delError.message)
    process.exit(1)
  }
  console.warn(`\n🗑  Deleted ${count ?? 0} old approximate transactions`)

  // Step 2: Check which new refs already exist
  const newRefs = TRANSACTIONS.map(t => t.ref_key)
  const { data: existing } = await supabase
    .from('bank_transactions')
    .select('transaction_ref')
    .eq('account_id', OWNER_ACCOUNT_ID)
    .in('transaction_ref', newRefs)

  const existingSet = new Set((existing ?? []).map(r => r.transaction_ref))
  const toInsert = TRANSACTIONS.filter(t => !existingSet.has(t.ref_key))

  if (toInsert.length === 0) {
    console.warn('✅ All transactions already imported.')
    return
  }

  console.warn(`\n📥 Inserting ${toInsert.length} new transactions...`)

  // Insert in batches of 50
  const BATCH = 50
  let inserted = 0
  for (let i = 0; i < toInsert.length; i += BATCH) {
    const batch = toInsert.slice(i, i + BATCH).map(t => ({
      account_id: OWNER_ACCOUNT_ID,
      tax_year: 2025,
      transaction_date: t.transaction_date,
      description: t.description,
      counterparty: t.counterparty,
      amount: t.amount,
      currency: 'USD',
      bank_name: t.bank_name,
      account_type: 'checking',
      transaction_ref: t.ref_key,
      category: t.category,
      subcategory: t.subcategory,
      is_related_party: false,
      notes: t.notes ?? `Imported from Tasha Batts bookkeeping 2025`,
    }))

    const { data, error } = await supabase
      .from('bank_transactions')
      .insert(batch)
      .select('id')

    if (error) {
      console.error(`❌ Batch ${i / BATCH + 1} failed:`, error.message)
      process.exit(1)
    }
    inserted += data?.length ?? 0
  }

  console.warn(`\n✅ Imported ${inserted} transactions`)
  console.warn(`   Run /owner?year=2025 to review`)
}

main()
