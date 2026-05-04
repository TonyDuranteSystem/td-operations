/**
 * Import 2025 P&L aggregate entries from Tasha's QuickBooks bookkeeping.
 * Creates one synthetic transaction per P&L line item dated 2025-12-31.
 * These represent QB-categorized totals not available as individual bank transactions.
 * Run: npx tsx scripts/import-owner-transactions-2025-pnl-aggregates.ts
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

// All P&L aggregate entries from Tasha's QuickBooks (2025 full year)
// Income = positive amounts, Expenses = negative amounts
const PNL_ENTRIES: Array<{
  key: string
  description: string
  category: string
  subcategory: string
  amount: number
}> = [
  // ── INCOME ──────────────────────────────────────────────────────────────
  { key: 'income-general',  description: 'General Income (QB aggregate)',  category: 'income', subcategory: 'general',  amount:    1243.90 },
  { key: 'income-sales',    description: 'Sales (QB aggregate)',           category: 'income', subcategory: 'sales',    amount:  851489.35 },
  { key: 'income-services', description: 'Services (QB aggregate)',        category: 'income', subcategory: 'services', amount:    5052.20 },

  // ── OPERATING EXPENSES ──────────────────────────────────────────────────
  { key: 'exp-license',       description: 'Business licenses & permits',         category: 'expense', subcategory: 'license',      amount:   -4702.50 },
  { key: 'exp-saas-membr',    description: 'Memberships & subscriptions',         category: 'expense', subcategory: 'saas',         amount:   -4542.52 },
  { key: 'exp-bank-fees',     description: 'Bank fees & service charges',         category: 'expense', subcategory: 'bank-fees',    amount:    -341.18 },
  { key: 'exp-education',     description: 'Continuing education',                category: 'expense', subcategory: 'education',    amount:    -310.00 },
  { key: 'exp-interest',      description: 'Interest paid',                       category: 'expense', subcategory: 'interest',     amount:    -432.80 },
  { key: 'exp-janitorial',    description: 'Janitorial expense',                  category: 'expense', subcategory: 'janitorial',   amount:   -1360.00 },
  { key: 'exp-rent-office',   description: 'Rent expense (office)',                category: 'expense', subcategory: 'rent',         amount:   -5750.00 },
  { key: 'exp-repairs',       description: 'Repairs and maintenance',             category: 'expense', subcategory: 'repairs',      amount:  -10824.75 },
  { key: 'exp-stripe-fees',   description: 'Stripe payment processing fees',      category: 'expense', subcategory: 'stripe-fees',  amount:   -3451.57 },
  { key: 'exp-zoho-fees',     description: 'Zoho Payments processing fees',       category: 'expense', subcategory: 'payment-fees', amount:    -825.61 },
  { key: 'exp-accounting',    description: 'Accounting fees',                     category: 'expense', subcategory: 'accounting',   amount:   -2038.20 },
  { key: 'exp-legal',         description: 'Legal fees',                          category: 'expense', subcategory: 'legal',        amount:  -18354.28 },
  { key: 'exp-advertising',   description: 'Advertising & promotion',             category: 'expense', subcategory: 'advertising',  amount:   -6144.00 },
  { key: 'exp-social-media',  description: 'Social media marketing',              category: 'expense', subcategory: 'social-media', amount:   -4859.99 },
  { key: 'exp-website-ads',   description: 'Website ads & digital marketing',     category: 'expense', subcategory: 'marketing',    amount:   -1597.34 },
  { key: 'exp-airfare',       description: 'Travel — airfare',                    category: 'expense', subcategory: 'travel',       amount:   -1707.50 },
  { key: 'exp-hotels',        description: 'Travel — hotels',                     category: 'expense', subcategory: 'travel',       amount:    -465.19 },
  { key: 'exp-taxis',         description: 'Travel — taxis & rideshares',         category: 'expense', subcategory: 'travel',       amount:    -396.67 },
  { key: 'exp-vehicle-rent',  description: 'Travel — vehicle rental',             category: 'expense', subcategory: 'travel',       amount:   -1360.30 },
  { key: 'exp-building-rent', description: 'Building & land rent',                category: 'expense', subcategory: 'rent',         amount:  -31000.00 },
  { key: 'exp-equip-rent',    description: 'Equipment rental',                    category: 'expense', subcategory: 'equipment',    amount:  -19038.42 },
  { key: 'exp-insurance',     description: 'Business insurance',                  category: 'expense', subcategory: 'insurance',    amount:    -399.96 },
  { key: 'exp-electricity',   description: 'Utilities — electricity',             category: 'expense', subcategory: 'utilities',    amount:   -2287.62 },
  { key: 'exp-telecom',       description: 'Utilities — telephone & internet',    category: 'expense', subcategory: 'utilities',    amount:   -5044.98 },
  { key: 'exp-water',         description: 'Utilities — water & sewer',           category: 'expense', subcategory: 'utilities',    amount:      -7.80 },
  { key: 'exp-meals-ent',     description: 'Meals and entertainment',             category: 'expense', subcategory: 'meals',        amount:    -608.11 },
  { key: 'exp-meals-clients', description: 'Meals with clients',                  category: 'expense', subcategory: 'meals',        amount:    -152.18 },
  { key: 'exp-meals-team',    description: 'Team meals',                          category: 'expense', subcategory: 'meals',        amount:  -15743.96 },
  { key: 'exp-office-suppl',  description: 'Office supplies',                     category: 'expense', subcategory: 'office',       amount:  -11987.54 },
  { key: 'exp-printing',      description: 'Printing & photocopying',             category: 'expense', subcategory: 'office',       amount:   -2478.98 },
  { key: 'exp-shipping',      description: 'Shipping & postage',                  category: 'expense', subcategory: 'shipping',     amount:   -4599.42 },
  { key: 'exp-tools',         description: 'Small tools & equipment',             category: 'expense', subcategory: 'equipment',    amount:    -754.89 },
  { key: 'exp-software',      description: 'Software & apps',                     category: 'expense', subcategory: 'saas',         amount:  -11900.12 },
  { key: 'exp-payroll-fees',  description: 'Payroll processing fees',             category: 'expense', subcategory: 'payroll',      amount:    -252.00 },
  { key: 'exp-payroll-taxes', description: 'Payroll taxes',                       category: 'expense', subcategory: 'payroll',      amount:  -12981.00 },
  { key: 'exp-salaries',      description: 'Salaries & wages',                    category: 'expense', subcategory: 'payroll',      amount: -166666.60 },

  // ── NON-OPERATING INCOME ────────────────────────────────────────────────
  { key: 'income-fx-gain',    description: 'Exchange gain or loss (QB aggregate)',  category: 'income', subcategory: 'general',      amount:      219.42 },

  // ── NON-OPERATING EXPENSES ──────────────────────────────────────────────
  { key: 'exp-recruitment',   description: 'Recruitment',                         category: 'expense', subcategory: 'recruitment',  amount:    -608.71 },
  { key: 'exp-est-tax',       description: 'Estimated tax payments',              category: 'expense', subcategory: 'tax',          amount:  -40605.26 },
  { key: 'exp-irs-filing',    description: 'IRS filing fees',                     category: 'expense', subcategory: 'tax',          amount:    -624.74 },
  { key: 'exp-parking',       description: 'Vehicle — parking & tolls',           category: 'expense', subcategory: 'vehicle',      amount:    -193.50 },
  { key: 'exp-vehicle-gas',   description: 'Vehicle — gas & fuel',                category: 'expense', subcategory: 'vehicle',      amount:   -2111.95 },
  { key: 'exp-vehicle-ins',   description: 'Vehicle — insurance',                 category: 'expense', subcategory: 'vehicle',      amount:   -2859.47 },
  { key: 'exp-vehicle-rep',   description: 'Vehicle — repairs & maintenance',     category: 'expense', subcategory: 'vehicle',      amount:    -252.93 },
]

async function main() {
  const refs = PNL_ENTRIES.map(e => `tasha-pnl-${e.key}`)

  // Check existing to avoid duplicates
  const { data: existing } = await supabase
    .from('bank_transactions')
    .select('transaction_ref')
    .eq('account_id', OWNER_ACCOUNT_ID)
    .in('transaction_ref', refs)

  const existingRefs = new Set((existing ?? []).map(r => r.transaction_ref))

  const records = PNL_ENTRIES
    .filter(e => !existingRefs.has(`tasha-pnl-${e.key}`))
    .map(e => ({
      account_id: OWNER_ACCOUNT_ID,
      tax_year: 2025,
      transaction_date: '2025-12-31',
      description: e.description,
      counterparty: 'QuickBooks P&L Aggregate',
      amount: e.amount,
      currency: 'USD',
      bank_name: 'QuickBooks',
      account_type: 'checking',
      transaction_ref: `tasha-pnl-${e.key}`,
      category: e.category,
      subcategory: e.subcategory,
      is_related_party: false,
      notes: 'Tasha Batts QB aggregate — 2025 full year total',
    }))

  if (records.length === 0) {
    console.warn('✅ All P&L aggregate entries already imported.')
    return
  }

  console.warn(`Skipping ${PNL_ENTRIES.length - records.length} existing, inserting ${records.length} new entries...`)

  const { data, error } = await supabase
    .from('bank_transactions')
    .insert(records)
    .select('id')

  if (error) {
    console.error('❌ Import failed:', error.message)
    process.exit(1)
  }

  console.warn(`✅ Imported ${data?.length ?? 0} P&L aggregate entries`)

  // Print expected totals for verification
  const income = PNL_ENTRIES.filter(e => e.category === 'income').reduce((s, e) => s + e.amount, 0)
  const expenses = PNL_ENTRIES.filter(e => e.category === 'expense').reduce((s, e) => s + e.amount, 0)
  console.warn(`Expected income from aggregates: $${income.toLocaleString('en-US', { minimumFractionDigits: 2 })}`)
  console.warn(`Expected expenses from aggregates: $${Math.abs(expenses).toLocaleString('en-US', { minimumFractionDigits: 2 })}`)
}

main()
