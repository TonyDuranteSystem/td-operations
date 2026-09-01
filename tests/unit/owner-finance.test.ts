import { describe, it, expect } from 'vitest'
import {
  applyVendorRules,
  computeInvoiceIncome,
  computeFilingSummary,
  computeOwnerPnL,
  isSimilarVendor,
  normalizeVendorKey,
  OWNER_ACCOUNT_ID,
  TD_ENTITY_ID,
  type InvoiceIncomeRow,
  computeBalanceSheet,
  claimedAccountNames,
  type OwnerAccount,
  type OwnerTransaction,
  type VendorRule,
} from '@/lib/owner-finance'

const makeTx = (overrides: Partial<OwnerTransaction> = {}): OwnerTransaction => ({
  id: 'test-id',
  transaction_date: '2025-03-15',
  description: 'Test transaction',
  category: 'uncategorized',
  subcategory: null,
  counterparty: 'Test Vendor',
  amount: -500,
  currency: 'USD',
  balance_after: null,
  bank_name: 'Mercury',
  account_type: 'checking',
  transaction_ref: null,
  is_related_party: false,
  notes: null,
  tax_year: 2025,
  created_at: '2025-03-15T00:00:00Z',
  ...overrides,
})

const makeRule = (overrides: Partial<VendorRule> = {}): VendorRule => ({
  id: 'rule-id',
  counterparty_pattern: 'test vendor',
  match_type: 'exact',
  category: 'expense',
  subcategory: 'software',
  is_related_party: false,
  notes: null,
  ...overrides,
})

describe('OWNER_ACCOUNT_ID', () => {
  it('has the fixed owner UUID', () => {
    expect(OWNER_ACCOUNT_ID).toBe('00000000-0000-0000-0000-000000000001')
  })
})

describe('applyVendorRules', () => {
  it('returns transactions unchanged when no rules match', () => {
    const txs = [makeTx()]
    const result = applyVendorRules(txs, [])
    expect(result[0].category).toBe('uncategorized')
  })

  it('skips already-categorized transactions', () => {
    const tx = makeTx({ category: 'income' })
    const rule = makeRule({ counterparty_pattern: 'test vendor' })
    const result = applyVendorRules([tx], [rule])
    expect(result[0].category).toBe('income')
  })

  it('applies exact match rule', () => {
    const tx = makeTx({ counterparty: 'Test Vendor' })
    const rule = makeRule({ counterparty_pattern: 'test vendor', match_type: 'exact' })
    const result = applyVendorRules([tx], [rule])
    expect(result[0].category).toBe('expense')
    expect(result[0].subcategory).toBe('software')
  })

  it('applies contains match rule', () => {
    const tx = makeTx({ counterparty: 'Zoho-One Monthly Charge' })
    const rule = makeRule({ counterparty_pattern: 'zoho', match_type: 'contains', subcategory: 'saas' })
    const result = applyVendorRules([tx], [rule])
    expect(result[0].category).toBe('expense')
    expect(result[0].subcategory).toBe('saas')
  })

  it('applies regex match rule', () => {
    const tx = makeTx({ counterparty: 'Airwallex Wire #12345' })
    const rule = makeRule({ counterparty_pattern: 'airwallex.*wire', match_type: 'regex', category: 'conversion' })
    const result = applyVendorRules([tx], [rule])
    expect(result[0].category).toBe('conversion')
  })

  it('handles invalid regex gracefully without throwing', () => {
    const tx = makeTx()
    const rule = makeRule({ counterparty_pattern: '[invalid(regex', match_type: 'regex' })
    expect(() => applyVendorRules([tx], [rule])).not.toThrow()
    expect(applyVendorRules([tx], [rule])[0].category).toBe('uncategorized')
  })

  it('matches using description when counterparty is null', () => {
    const tx = makeTx({ counterparty: null, description: 'Zoho subscription' })
    const rule = makeRule({ counterparty_pattern: 'zoho subscription', match_type: 'exact' })
    const result = applyVendorRules([tx], [rule])
    expect(result[0].category).toBe('expense')
  })

  it('sets is_related_party from matching rule', () => {
    const tx = makeTx({ counterparty: 'Luca DeG' })
    const rule = makeRule({ counterparty_pattern: 'luca deg', match_type: 'exact', is_related_party: true, category: 'cogs', subcategory: 'contractor' })
    const result = applyVendorRules([tx], [rule])
    expect(result[0].is_related_party).toBe(true)
  })
})

describe('normalizeVendorKey / isSimilarVendor', () => {
  it('normalizes punctuation and case to one canonical form', () => {
    expect(normalizeVendorKey('STRIPE - TRANSFER')).toBe('stripe transfer')
    expect(normalizeVendorKey('  Zoho-One  ')).toBe('zoho one')
    expect(normalizeVendorKey(null)).toBe('')
  })

  it('groups the SAME vendor worded differently by different banks', () => {
    expect(isSimilarVendor(
      'STRIPE - TRANSFER',
      'STRIPE; TRANSFER; TONY DURANTE LLC; Merchant name: STRIPE'
    )).toBe(true)
    expect(isSimilarVendor('Zoho-One', 'ZOHO ONE MONTHLY')).toBe(true)
  })

  it('does not match unrelated vendors or trivially short keys', () => {
    expect(isSimilarVendor('Chase', 'American Express')).toBe(false)
    expect(isSimilarVendor('AWS', 'SAWS PLUMBING AWS123')).toBe(false) // shorter side < 4 chars
    expect(isSimilarVendor('', 'Chase')).toBe(false)
  })

  it('matches whole tokens only — "Chase" must NOT match "POS PURCHASE" wording', () => {
    expect(isSimilarVendor('Chase', 'POS PURCHASE MERCHANT 4421')).toBe(false)
    expect(isSimilarVendor('Chase', 'CHASE CREDIT CRD EPAY')).toBe(true)
  })

  it('folds accents so Italian vendor names keep their full key', () => {
    expect(normalizeVendorKey('CAFFÈ ROMA')).toBe('caffe roma')
    expect(isSimilarVendor('CAFFÈ', 'CAFFO DISTILLERIA')).toBe(false)
  })

  it('contains-rules match across bank wordings after normalization', () => {
    const tx = makeTx({ counterparty: 'STRIPE; TRANSFER; TONY DURANTE LLC; Merchant name: STRIPE' })
    const rule = makeRule({ counterparty_pattern: 'stripe transfer', match_type: 'contains', category: 'transfer', subcategory: 'stripe_payout' })
    expect(applyVendorRules([tx], [rule])[0].category).toBe('transfer')
  })

  it('contains-rules respect token boundaries — a "chase" rule never chips "purchase" rows', () => {
    const tx = makeTx({ counterparty: 'POS PURCHASE MERCHANT 4421' })
    const rule = makeRule({ counterparty_pattern: 'chase', match_type: 'contains', category: 'expense', subcategory: 'other_expense' })
    expect(applyVendorRules([tx], [rule])[0].category).toBe('uncategorized')
  })

  it('the most specific rule wins — "stripe fee" beats "stripe" for a STRIPE FEE row', () => {
    const feeRow = makeTx({ counterparty: 'STRIPE FEE' })
    const rules = [
      makeRule({ id: 'broad', counterparty_pattern: 'stripe', match_type: 'contains', category: 'transfer', subcategory: 'stripe_payout' }),
      makeRule({ id: 'narrow', counterparty_pattern: 'stripe fee', match_type: 'contains', category: 'expense', subcategory: 'stripe_fees' }),
    ]
    expect(applyVendorRules([feeRow], rules)[0].category).toBe('expense')
  })

  it('a contains-rule whose pattern normalizes to nothing matches NOTHING, not everything', () => {
    const tx = makeTx({ counterparty: 'Anything At All' })
    const rule = makeRule({ counterparty_pattern: '&&', match_type: 'contains', category: 'expense', subcategory: 'other_expense' })
    expect(applyVendorRules([tx], [rule])[0].category).toBe('uncategorized')
  })
})

describe('TD_ENTITY_ID', () => {
  it('equals the historical owner sentinel (ids were preserved across the migration)', () => {
    expect(TD_ENTITY_ID).toBe(OWNER_ACCOUNT_ID)
  })
})

const makeIncomeRow = (overrides: Partial<InvoiceIncomeRow> = {}): InvoiceIncomeRow => ({
  amount_paid: 1000,
  amount_currency: 'USD',
  paid_date: '2026-03-10',
  issue_date: '2026-03-01',
  created_at: '2026-03-01T00:00:00Z',
  status: 'Paid',
  invoice_number: 'INV-001234',
  total: 1000,
  amount: 1000,
  ...overrides,
})

describe('computeInvoiceIncome', () => {
  it('sums paid cash by paid-date year and month, per currency', () => {
    const rows = [
      makeIncomeRow({ amount_paid: 1000, paid_date: '2026-01-15' }),
      makeIncomeRow({ amount_paid: 2500, paid_date: '2026-01-20' }),
      makeIncomeRow({ amount_paid: 700, paid_date: '2026-06-05' }),
    ]
    const inc = computeInvoiceIncome(rows, 2026)
    expect(inc.byCurrency.USD.total).toBe(4200)
    expect(inc.byCurrency.USD.monthly[0]).toBe(3500)
    expect(inc.byCurrency.USD.monthly[5]).toBe(700)
    expect(inc.anomalies).toHaveLength(0)
  })

  it('never mixes currencies', () => {
    const rows = [
      makeIncomeRow({ amount_paid: 1000, amount_currency: 'USD' }),
      makeIncomeRow({ amount_paid: 800, amount_currency: 'EUR' }),
    ]
    const inc = computeInvoiceIncome(rows, 2026)
    expect(inc.byCurrency.USD.total).toBe(1000)
    expect(inc.byCurrency.EUR.total).toBe(800)
  })

  it('excludes other years', () => {
    const rows = [
      makeIncomeRow({ paid_date: '2025-12-31' }),
      makeIncomeRow({ paid_date: '2026-01-01', amount_paid: 50 }),
    ]
    const inc = computeInvoiceIncome(rows, 2026)
    expect(inc.byCurrency.USD.total).toBe(50)
  })

  it('counts undated cash via issue-date fallback and flags it approximated', () => {
    const rows = [
      makeIncomeRow({ paid_date: null, issue_date: '2026-04-01', amount_paid: 500 }),
    ]
    const inc = computeInvoiceIncome(rows, 2026)
    expect(inc.byCurrency.USD.total).toBe(500)
    expect(inc.byCurrency.USD.monthly[3]).toBe(500)
    expect(inc.byCurrency.USD.approximated_count).toBe(1)
  })

  it('falls back to created date when both paid and issue dates are missing', () => {
    const rows = [
      makeIncomeRow({ paid_date: null, issue_date: null, created_at: '2026-07-09T12:00:00Z', amount_paid: 250 }),
    ]
    const inc = computeInvoiceIncome(rows, 2026)
    expect(inc.byCurrency.USD.total).toBe(250)
    expect(inc.byCurrency.USD.monthly[6]).toBe(250)
  })

  it('routes cash on Cancelled/Refunded rows to anomalies, excluded from totals', () => {
    const rows = [
      makeIncomeRow({ status: 'Cancelled', amount_paid: 1250 }),
      makeIncomeRow({ status: 'Refunded', amount_paid: 300 }),
      makeIncomeRow({ status: 'Paid', amount_paid: 100 }),
    ]
    const inc = computeInvoiceIncome(rows, 2026)
    expect(inc.byCurrency.USD.total).toBe(100)
    expect(inc.anomalies).toHaveLength(2)
    expect(inc.anomalies[0].status).toBe('Cancelled')
  })

  it('year-scopes anomalies — a 2025 refund does not haunt the 2026 banner', () => {
    const rows = [
      makeIncomeRow({ status: 'Refunded', amount_paid: 500, paid_date: '2025-06-01' }),
      makeIncomeRow({ status: 'Cancelled', amount_paid: 200, paid_date: '2026-02-01' }),
    ]
    expect(computeInvoiceIncome(rows, 2026).anomalies.map(a => a.status)).toEqual(['Cancelled'])
    expect(computeInvoiceIncome(rows, 2025).anomalies.map(a => a.status)).toEqual(['Refunded'])
  })

  it('a dateless anomaly cannot be scoped and shows every year (safe side)', () => {
    const rows = [makeIncomeRow({ status: 'Cancelled', amount_paid: 50, paid_date: null, issue_date: null, created_at: null })]
    expect(computeInvoiceIncome(rows, 2026).anomalies).toHaveLength(1)
    expect(computeInvoiceIncome(rows, 2027).anomalies).toHaveLength(1)
  })

  it('flags part-paid rows — cumulative cash pinned to one date is only approximately monthly', () => {
    const rows = [
      makeIncomeRow({ amount_paid: 500, total: 2200 }),
      makeIncomeRow({ amount_paid: 1000, total: 1000 }),
    ]
    const inc = computeInvoiceIncome(rows, 2026)
    expect(inc.byCurrency.USD.total).toBe(1500)
    expect(inc.byCurrency.USD.partial_count).toBe(1)
  })

  it('ignores rows with no cash received', () => {
    const rows = [
      makeIncomeRow({ amount_paid: 0 }),
      makeIncomeRow({ amount_paid: null }),
    ]
    const inc = computeInvoiceIncome(rows, 2026)
    expect(Object.keys(inc.byCurrency)).toHaveLength(0)
  })

  it('includes part-payments on non-terminal invoices (cash method: money received counts)', () => {
    const rows = [
      makeIncomeRow({ status: 'Overdue', amount_paid: 500, paid_date: null, issue_date: '2026-02-10' }),
    ]
    const inc = computeInvoiceIncome(rows, 2026)
    expect(inc.byCurrency.USD.total).toBe(500)
  })
})

const emptyIncome = { year: 2026, byCurrency: {}, anomalies: [] }

describe('computeOwnerPnL', () => {
  it('income comes from the invoice ledger; books income rows are Other Income', () => {
    const income = computeInvoiceIncome([makeIncomeRow({ amount_paid: 10000, paid_date: '2026-02-01' })], 2026)
    const txs = [makeTx({ category: 'income', amount: 250, transaction_date: '2026-03-05', tax_year: 2026 })]
    const pnl = computeOwnerPnL(txs, income, 2026)
    const usd = pnl.blocks.find(b => b.currency === 'USD')!
    expect(usd.invoice_income).toBe(10000)
    expect(usd.other_income).toBe(250)
    expect(usd.gross_profit).toBe(10250)
    expect(usd.monthly[1].income).toBe(10000)
    expect(usd.monthly[2].income).toBe(250)
  })

  it('transfer rows never touch the P&L — Stripe money is counted exactly once', () => {
    const income = computeInvoiceIncome([makeIncomeRow({ amount_paid: 5000, paid_date: '2026-01-10' })], 2026)
    const payout = makeTx({ category: 'transfer', amount: 4855, transaction_date: '2026-01-14', tax_year: 2026 })
    const pnl = computeOwnerPnL([payout], income, 2026)
    const usd = pnl.blocks.find(b => b.currency === 'USD')!
    expect(usd.invoice_income).toBe(5000)
    expect(usd.other_income).toBe(0)
    expect(usd.net_profit).toBe(5000)
    expect(usd.by_subcategory).toEqual({})
  })

  it('expenses, fees and cogs reduce profit; equity moves are separate', () => {
    const txs = [
      makeTx({ category: 'expense', amount: -300, subcategory: 'saas', transaction_date: '2026-05-01' }),
      makeTx({ category: 'fee', amount: -20, subcategory: 'bank_fee', transaction_date: '2026-05-02' }),
      makeTx({ category: 'cogs', amount: -1000, subcategory: 'contractor', transaction_date: '2026-05-03' }),
      makeTx({ category: 'distribution', amount: -2000, transaction_date: '2026-05-04' }),
      makeTx({ category: 'contribution', amount: 500, transaction_date: '2026-05-05' }),
    ]
    const pnl = computeOwnerPnL(txs, emptyIncome, 2026)
    const usd = pnl.blocks.find(b => b.currency === 'USD')!
    expect(usd.expenses).toBe(320)
    expect(usd.cogs).toBe(1000)
    expect(usd.net_profit).toBe(-1320)
    expect(usd.distributions).toBe(2000)
    expect(usd.contributions).toBe(500)
    expect(usd.by_subcategory).not.toHaveProperty('distribution')
    expect(usd.by_subcategory).not.toHaveProperty('contribution')
  })

  it('keeps each currency in its own block — nothing is summed across currencies', () => {
    const income = computeInvoiceIncome([
      makeIncomeRow({ amount_paid: 1000, amount_currency: 'USD', paid_date: '2026-01-05' }),
      makeIncomeRow({ amount_paid: 900, amount_currency: 'EUR', paid_date: '2026-01-06' }),
    ], 2026)
    const txs = [makeTx({ currency: 'EUR', category: 'expense', amount: -100, transaction_date: '2026-02-01' })]
    const pnl = computeOwnerPnL(txs, income, 2026)
    expect(pnl.blocks[0].currency).toBe('USD')
    expect(pnl.blocks[0].net_profit).toBe(1000)
    const eur = pnl.blocks.find(b => b.currency === 'EUR')!
    expect(eur.net_profit).toBe(800)
  })

  it('surfaces income anomalies and approximated dates on the result', () => {
    const income = computeInvoiceIncome([
      makeIncomeRow({ status: 'Cancelled', amount_paid: 99 }),
      makeIncomeRow({ paid_date: null, issue_date: '2026-01-01', amount_paid: 10 }),
    ], 2026)
    const pnl = computeOwnerPnL([], income, 2026)
    expect(pnl.income_anomalies).toHaveLength(1)
    expect(pnl.approximated_date_count).toBe(1)
  })

  it('uncategorized cash reaches net profit AND the monthly series — chart ties to KPI', () => {
    const txs = [
      makeTx({ category: 'uncategorized', amount: 400, transaction_date: '2026-06-01' }),
      makeTx({ category: 'uncategorized', amount: -150, transaction_date: '2026-06-02' }),
    ]
    const pnl = computeOwnerPnL(txs, emptyIncome, 2026)
    const usd = pnl.blocks.find(b => b.currency === 'USD')!
    expect(usd.uncategorized_income).toBe(400)
    expect(usd.uncategorized_expense).toBe(150)
    expect(usd.net_profit).toBe(250)
    expect(usd.monthly[5].income).toBe(400)
    expect(usd.monthly[5].expenses).toBe(150)
    const monthlyNetSum = usd.monthly.reduce((s, m) => s + m.net, 0)
    expect(monthlyNetSum).toBe(usd.net_profit)
  })

  it('a currency with ONLY non-P&L rows gets no block — no all-zero tables', () => {
    const txs = [makeTx({ currency: 'DKK', category: 'transfer', amount: 3730, transaction_date: '2026-04-01' })]
    const pnl = computeOwnerPnL(txs, emptyIncome, 2026)
    expect(pnl.blocks.find(b => b.currency === 'DKK')).toBeUndefined()
  })

  it('exposes the part-paid attribution count on the P&L', () => {
    const income = computeInvoiceIncome([makeIncomeRow({ amount_paid: 300, total: 900 })], 2026)
    const pnl = computeOwnerPnL([], income, 2026)
    expect(pnl.partial_attribution_count).toBe(1)
  })

  it('month attribution slices the date string — no timezone drift on month boundaries', () => {
    const txs = [makeTx({ category: 'expense', amount: -50, transaction_date: '2026-03-01' })]
    const pnl = computeOwnerPnL(txs, emptyIncome, 2026)
    const usd = pnl.blocks.find(b => b.currency === 'USD')!
    expect(usd.monthly[2].expenses).toBe(50)
    expect(usd.monthly[1].expenses).toBe(0)
  })
})

/* Two faults found on the real 2025 books, 2026-08-31, when Antonio opened the P&L and
   the figures did not match the ledger. Both are silent — nothing errors, the screen
   just misleads — so each gets a test that fails if the fault returns. */
describe('computeOwnerPnL — the expenses breakdown is expenses only', () => {
  const income: InvoiceIncomeRow[] = []

  it('keeps income OUT of "Expenses by Subcategory"', () => {
    const pnl = computeOwnerPnL([
      makeTx({ category: 'income', subcategory: 'client_payment', amount: 426946.58 }),
      makeTx({ category: 'income', subcategory: 'bank_rewards', amount: 22951.05 }),
      makeTx({ category: 'expense', subcategory: 'payroll', amount: -180088.6 }),
      makeTx({ category: 'cogs', subcategory: 'state_filing_fees', amount: -29291.82 }),
      makeTx({ category: 'fee', subcategory: 'card_fee', amount: -695 }),
    ], computeInvoiceIncome(income, 2025), 2025)
    const b = pnl.blocks[0]
    // The whole point: revenue must not appear as a cost. Under the old rule
    // client_payment was the LARGEST line in a panel headed "Expenses".
    // Keys are "category/subcategory" so the UI can link each line to its rows.
    expect(Object.keys(b.by_subcategory).some(k => k.endsWith('/client_payment'))).toBe(false)
    expect(Object.keys(b.by_subcategory).some(k => k.endsWith('/bank_rewards'))).toBe(false)
    expect(b.by_subcategory['expense/payroll']).toBeCloseTo(180088.6, 2)
    expect(b.by_subcategory['cogs/state_filing_fees']).toBeCloseTo(29291.82, 2)
    expect(b.by_subcategory['fee/card_fee']).toBeCloseTo(695, 2)
  })

  it('still keeps equity and own-money movement out of it', () => {
    const pnl = computeOwnerPnL([
      makeTx({ category: 'distribution', subcategory: 'owner_personal', amount: -75826.93 }),
      makeTx({ category: 'transfer', subcategory: 'own_account', amount: -275000 }),
      makeTx({ category: 'expense', subcategory: 'rent', amount: -24188.42 }),
    ], computeInvoiceIncome(income, 2025), 2025)
    expect(Object.keys(pnl.blocks[0].by_subcategory)).toEqual(['expense/rent'])
  })
})

describe('computeOwnerPnL — the achieved FX rate', () => {
  const income: InvoiceIncomeRow[] = []
  const conv = (cur: string, amt: number) =>
    makeTx({ category: 'conversion', subcategory: 'fx', currency: cur, amount: amt })

  it('derives the rate the company actually got, from its own conversions', () => {
    const pnl = computeOwnerPnL([
      makeTx({ currency: 'EUR', category: 'income', subcategory: 'client_payment', amount: 144770.9 }),
      conv('EUR', -147100), conv('USD', 164895.95),
    ], computeInvoiceIncome(income, 2025), 2025)
    const eur = pnl.blocks.find(b => b.currency === 'EUR')!
    expect(eur.usd_rate).toBeCloseTo(164895.95 / 147100, 6)
  })

  it('refuses a rate when TWO currencies were converted — the dollars cannot be split', () => {
    const pnl = computeOwnerPnL([
      makeTx({ currency: 'EUR', category: 'income', subcategory: 'client_payment', amount: 1000 }),
      makeTx({ currency: 'GBP', category: 'income', subcategory: 'client_payment', amount: 1000 }),
      conv('EUR', -1000), conv('GBP', -1000), conv('USD', 2400),
    ], computeInvoiceIncome(income, 2025), 2025)
    // A guessed split would silently misstate revenue on a tax return.
    expect(pnl.blocks.find(b => b.currency === 'EUR')!.usd_rate).toBeNull()
    expect(pnl.blocks.find(b => b.currency === 'GBP')!.usd_rate).toBeNull()
  })

  it('leaves the rate null when nothing was converted', () => {
    const pnl = computeOwnerPnL([
      makeTx({ currency: 'EUR', category: 'income', subcategory: 'client_payment', amount: 500 }),
    ], computeInvoiceIncome(income, 2025), 2025)
    expect(pnl.blocks.find(b => b.currency === 'EUR')!.usd_rate).toBeNull()
  })

  it('never sets a rate on the USD block itself', () => {
    const pnl = computeOwnerPnL([
      makeTx({ category: 'income', subcategory: 'client_payment', amount: 1000 }),
      makeTx({ currency: 'EUR', category: 'income', subcategory: 'client_payment', amount: 1000 }),
      conv('EUR', -1000), conv('USD', 1120),
    ], computeInvoiceIncome(income, 2025), 2025)
    expect(pnl.blocks.find(b => b.currency === 'USD')!.usd_rate).toBeNull()
  })
})

/* The drill-down contract (2026-08-31): Antonio could read a P&L total but never open it,
   so every figure had to be taken on trust. Each line is now a link, and these guard the
   two things that would make the link show the WRONG rows. */
describe('computeOwnerPnL — the expense breakdown can be linked to its transactions', () => {
  const income: InvoiceIncomeRow[] = []

  it('keys every line with its category, so a click can filter on both', () => {
    const pnl = computeOwnerPnL([
      makeTx({ category: 'expense', subcategory: 'payroll', amount: -1000 }),
      makeTx({ category: 'cogs', subcategory: 'contractor', amount: -500 }),
    ], computeInvoiceIncome(income, 2025), 2025)
    expect(Object.keys(pnl.blocks[0].by_subcategory).sort()).toEqual(['cogs/contractor', 'expense/payroll'])
  })

  it('does NOT merge the same subcategory name used under two categories', () => {
    // The real hazard: filtering on the bare name would pull rows from the other line and
    // show a list that cannot add up to the total the reader just clicked.
    const pnl = computeOwnerPnL([
      makeTx({ category: 'expense', subcategory: 'professional_services', amount: -900 }),
      makeTx({ category: 'cogs', subcategory: 'professional_services', amount: -100 }),
    ], computeInvoiceIncome(income, 2025), 2025)
    const b = pnl.blocks[0].by_subcategory
    expect(b['expense/professional_services']).toBeCloseTo(900, 2)
    expect(b['cogs/professional_services']).toBeCloseTo(100, 2)
  })
})

/* The filing summary (2026-08-31). Antonio asked for the euro income converted, the office
   treated as property, and the meals halved. All three are TAX treatment, applied on top of
   the books — never edits to the rows, which were proven against the banks' own balances and
   must keep tying. These tests exist to stop that boundary being crossed later. */
describe('computeFilingSummary', () => {
  const pnlOf = (txs: OwnerTransaction[]) => computeOwnerPnL(txs, computeInvoiceIncome([], 2025), 2025)
  /* Every 2025 summary also carries the deductible part of the office closing. It is a real
     adjustment, not noise — these tests state it rather than absorb it, so that if the figure
     ever changes the failure names the reason. */
  const CLOSING = -1001.90

  it('adds back half of business meals, because only half is deductible', () => {
    const txs = [
      makeTx({ category: 'income', subcategory: 'client_payment', amount: 10000 }),
      makeTx({ category: 'expense', subcategory: 'meals', amount: -2927.51 }),
    ]
    const f = computeFilingSummary(txs, pnlOf(txs))
    expect(f.books_net_usd).toBeCloseTo(10000 - 2927.51, 2)
    const meals = f.adjustments.find(a => a.label.includes('meals'))!
    expect(meals.amount).toBeCloseTo(1463.755, 2)
    expect(f.taxable_income).toBeCloseTo(10000 - 2927.51 + 1463.755 + CLOSING, 2)
  })

  it('converts foreign profit at the rate the company actually achieved', () => {
    const txs = [
      makeTx({ currency: 'EUR', category: 'income', subcategory: 'client_payment', amount: 144770.9 }),
      makeTx({ currency: 'EUR', category: 'conversion', subcategory: 'fx', amount: -147100 }),
      makeTx({ category: 'conversion', subcategory: 'fx', amount: 164895.95 }),
    ]
    const f = computeFilingSummary(txs, pnlOf(txs))
    const eur = f.foreign.find(x => x.currency === 'EUR')!
    expect(eur.rate).toBeCloseTo(164895.95 / 147100, 6)
    expect(eur.net_usd).toBeCloseTo(144770.9 * (164895.95 / 147100), 2)
    expect(f.taxable_income).toBeCloseTo(eur.net_usd! + CLOSING, 2)
  })

  it('WARNS instead of guessing when a currency has no achieved rate', () => {
    // Silently dropping unconvertible foreign profit would understate income on a return.
    const txs = [makeTx({ currency: 'GBP', category: 'income', subcategory: 'client_payment', amount: 5000 })]
    const f = computeFilingSummary(txs, pnlOf(txs))
    expect(f.foreign[0].net_usd).toBeNull()
    expect(f.warnings.join(' ')).toContain('GBP')
    expect(f.taxable_income).toBeCloseTo(0 + CLOSING, 2)
  })

  it('surfaces capitalized property WITHOUT deducting it', () => {
    const txs = [
      makeTx({ category: 'income', subcategory: 'client_payment', amount: 50000 }),
      makeTx({ category: 'transfer', subcategory: 'fixed_asset_office_purchase', amount: -29032.53 }),
      makeTx({ category: 'transfer', subcategory: 'fixed_asset_office_purchase', amount: -3000 }),
      makeTx({ category: 'transfer', subcategory: 'fixed_asset_office_purchase', amount: -3000 }),
    ]
    const f = computeFilingSummary(txs, pnlOf(txs))
    expect(f.capitalized[0].amount).toBeCloseTo(35032.53, 2)
    // A building is not a cost of this year — profit must be untouched by the purchase itself.
    expect(f.taxable_income).toBeCloseTo(50000 + CLOSING, 2)
  })
})

describe('computeFilingSummary — deductible closing costs', () => {
  it('claims the deductible part of the 2025 closing and lowers taxable income', () => {
    const txs = [makeTx({ category: 'income', subcategory: 'client_payment', amount: 100000 })]
    const f = computeFilingSummary(txs, computeOwnerPnL(txs, computeInvoiceIncome([], 2025), 2025))
    const line = f.adjustments.find(a => a.label.includes('closing costs'))!
    expect(line.amount).toBeCloseTo(-1001.90, 2)
    expect(f.taxable_income).toBeCloseTo(100000 - 1001.90, 2)
  })

  it('does NOT apply it to another year — it is one transaction in one year', () => {
    const txs = [makeTx({ tax_year: 2026, category: 'income', subcategory: 'client_payment', amount: 100000 })]
    const f = computeFilingSummary(txs, computeOwnerPnL(txs, computeInvoiceIncome([], 2026), 2026))
    expect(f.adjustments.some(a => a.label.includes('closing costs'))).toBe(false)
  })
})

const makeAccount = (overrides: Partial<OwnerAccount> = {}): OwnerAccount => ({
  bank_name: 'Test Checking',
  institution: 'Test Bank',
  account_number: '0001',
  account_type: 'checking',
  // These must be values the table's CHECK constraints allow, or every positive test
  // below runs on an account shape the database cannot produce.
  sign_convention: 'normal',
  is_clearing: false,
  currency: 'USD',
  opening_balance: null,
  opening_date: null,
  closing_balance: 1000,
  closing_date: '2025-12-31',
  closing_source: 'statement',
  notes: null,
  is_active: true,
  ...overrides,
})

/** The balance sheet shipped without any tests. It is the only place the office purchase
 *  appears at all, and the only independent check on the cash the P&L implies — so the
 *  rules it encodes are pinned here.
 *
 *  THE RULE THAT MATTERS MOST, and the one an earlier version of this file got WRONG:
 *  a balance is a position on a DATE. The registry holds one closing figure per account,
 *  so unless the balance's own year is checked, the same figures render under every year's
 *  heading. An earlier test here asserted exactly that broken behaviour — it fed an
 *  account closed 2025-12-31 into a 2024 balance sheet and asserted the label read 2024 —
 *  which pinned the defect in place instead of catching it. Live QA found it: the page
 *  defaults to the CURRENT year, so simply opening it produced a complete, confident,
 *  wrong statement.
 *
 *  THE SECOND RULE, added after the SAME defect came back in a smaller shape: the year
 *  check alone was not enough. It asked "does ANY account match the year", so one matching
 *  account printed a complete-looking statement out of a subset — with the mortgage simply
 *  absent and nothing on the page saying so. A statement is every account or it is none. */
describe('computeBalanceSheet', () => {
  it('splits accounts into cash and liabilities by type, and nets equity', () => {
    const bs = computeBalanceSheet([
      makeAccount({ bank_name: 'Chase', account_type: 'checking', closing_balance: 17832.23 }),
      makeAccount({ bank_name: 'Amex savings', account_type: 'savings', closing_balance: 602.73 }),
      makeAccount({ bank_name: 'Stripe', account_type: 'processor', closing_balance: 2882.10 }),
      makeAccount({ bank_name: 'Amex card', account_type: 'credit_card', closing_balance: 1991.63 }),
      makeAccount({ bank_name: 'FCB loan', account_type: 'loan', closing_balance: 140246.52 }),
    ], [
      // NOT an empty ledger: with no transactions the post-date-activity check passes
      // vacuously, and it is the only thing justifying a year-end statement date.
      makeTx({ bank_name: 'Chase', transaction_date: '2025-11-02' }),
      makeTx({ bank_name: 'FCB loan', transaction_date: '2025-12-31' }),
    ], 2025)

    expect(bs.can_state).toBe(true)
    expect(bs.cash.map(l => l.label)).toEqual(['Chase', 'Stripe', 'Amex savings'])
    expect(bs.liabilities.map(l => l.label)).toEqual(['FCB loan', 'Amex card'])
    expect(bs.total_assets).toBeCloseTo(21317.06, 2)
    expect(bs.total_liabilities).toBeCloseTo(142238.15, 2)
    expect(bs.equity).toBeCloseTo(21317.06 - 142238.15, 2)
  })

  it('REFUSES to state a balance sheet for a year it holds no balances for', () => {
    // The exact live defect: 2025 balances rendered under the 2026 heading, on the
    // DEFAULT page load, because the year was used only to build the label.
    const accounts = [makeAccount({ closing_balance: 41138.64, closing_date: '2025-12-31' })]
    const bs = computeBalanceSheet(accounts, [], 2026)

    expect(bs.can_state).toBe(false)
    expect(bs.cash).toHaveLength(0)
    expect(bs.total_assets).toBe(0)
    expect(bs.total_liabilities).toBe(0)
    expect(bs.notes.some(n => n.includes('2026') && n.includes('2025'))).toBe(true)
  })

  it('states the year it DOES hold balances for', () => {
    const accounts = [makeAccount({ closing_balance: 41138.64, closing_date: '2025-06-30' })]
    // NOT an empty ledger. This is the test that pins `as_of` at the year end for a balance
    // struck at midsummer, and the ONLY thing justifying that is the post-date-activity
    // check — which passes for free when there are no transactions to check against. The
    // row here is dated BEFORE the balance, so the check genuinely runs and genuinely holds.
    const bs = computeBalanceSheet(accounts, [makeTx({ bank_name: 'Test Checking', transaction_date: '2025-05-02' })], 2025)
    expect(bs.can_state).toBe(true)
    expect(bs.total_assets).toBeCloseTo(41138.64, 2)
    expect(bs.cash[0].as_of).toBe('2025-06-30')
    // A midsummer balance with NO later movement in the books still holds at the year
    // end, so the statement is a year-end one — but the line keeps its own date, and a
    // note says which accounts were struck early. What would NOT be legitimate is money
    // moving after the figure was struck; that case is refused (next test).
    expect(bs.as_of).toBe('2025-12-31')
    expect(bs.notes.some(n => n.includes('before 31 December'))).toBe(true)
  })

  it('REFUSES a balance the books themselves contradict — money moved after it was struck', () => {
    const bs = computeBalanceSheet(
      [makeAccount({ bank_name: 'Chase', closing_balance: 1000, closing_date: '2025-12-15' })],
      [makeTx({ bank_name: 'Chase', transaction_date: '2025-12-28', amount: -400 })],
      2025,
    )
    expect(bs.can_state).toBe(false)
    expect(bs.notes.some(n => n.includes('Chase') && n.includes('AFTER'))).toBe(true)
  })

  it('REFUSES when the BOOKS hold an account the registry has never heard of', () => {
    // Live today, not hypothetical: the 2026 books carry Mercury / Relay / Airwallex rows
    // under names no registry row holds, because nothing in the app writes a registry row
    // and an uploaded statement invents its account label from the file name. Walking only
    // the registry, the completeness check could never see them.
    const bs = computeBalanceSheet(
      [makeAccount({ bank_name: 'Chase checking 3920', closing_balance: 1000 })],
      [makeTx({ bank_name: 'Mercury' })],
      2025,
    )
    expect(bs.can_state).toBe(false)
    expect(bs.notes.some(n => n.includes('Mercury') && n.includes('not match any account on file'))).toBe(true)
  })

  it('REFUSES an institution-only label from the bank feed — it cannot say WHICH account', () => {
    // The two writers name accounts differently: the bank feed labels a row by its
    // INSTITUTION ("Mercury"), the registry and the statement importer by the account
    // ("Mercury checking 4517"). An earlier version treated the institution label as
    // COVERING any account starting with it — which let a stale balance certify itself:
    // entering a mid-year figure for "Mercury checking 4517" while the feed kept writing
    // bare "Mercury" rows after it produced NO staleness match (different strings) and a
    // note swearing nothing moved afterwards, which was false. And an institution with
    // MULTIPLE accounts (Chase has three) would be "covered" by any one of them, so
    // closing a card could vanish from a year it was live in with nothing said.
    // The books cannot say which of two Airwallex accounts a bare row belongs to, so the
    // honest answer is refusal, not a guess dressed as coverage.
    const bs = computeBalanceSheet(
      [makeAccount({ bank_name: 'Mercury checking 4517', closing_balance: 15044.08 })],
      [makeTx({ bank_name: 'Mercury' })],
      2025,
    )
    expect(bs.can_state).toBe(false)
    expect(bs.notes.some(n => n.includes('Mercury') && n.includes('not match any account on file'))).toBe(true)
  })

  it('REFUSES rather than certify a balance as unmoved when staleness is checked against the WRONG name', () => {
    // The bug this pins: coverage and staleness must share the SAME join key. Entering a
    // "Mercury checking 4517" closing balance while the feed keeps posting bare "Mercury"
    // rows after it must not let the mismatch itself stand in for "nothing moved" — that
    // reads the ABSENCE of a matching name as proof of no activity, which is backwards.
    const bs = computeBalanceSheet(
      [makeAccount({ bank_name: 'Mercury checking 4517', closing_balance: 15044.08, closing_date: '2025-06-30' })],
      [makeTx({ bank_name: 'Mercury', transaction_date: '2025-11-02' })],
      2025,
    )
    expect(bs.can_state).toBe(false)
    expect(bs.notes.some(n => n.includes('no movement in them afterwards'))).toBe(false)
  })

  it('REFUSES when one account at a multi-account institution is closed and a sibling stays open', () => {
    // Chase has a checking account and two credit cards. A bare feed row "Chase" is not
    // allowed to be satisfied by whichever of the three happens to still be active — that
    // would let a closed card's debt disappear from a year it was live in, unnamed,
    // because ITS institution still has an open account.
    const bs = computeBalanceSheet(
      [makeAccount({ bank_name: 'Chase checking 3920', closing_balance: 17832.23 })],
      [makeTx({ bank_name: 'Chase' })],
      2025,
    )
    expect(bs.can_state).toBe(false)
    expect(bs.notes.some(n => n.includes('Chase') && n.includes('not match any account on file'))).toBe(true)
  })

  it('REFUSES when a registry name DRIFTS from the name the books use', () => {
    // The app tells the operator to save the loan export as "FirstCitizens_loan_7363.csv",
    // which writes bank_name "FirstCitizens loan 7363" while the registry says
    // "Firstcitizenbank loan 7363". Every join here is an exact string, so a drifted name
    // is a second account: the cash position lists the loan twice, and the "no movement
    // afterwards" check silently matches nothing while the note still claims it ran.
    const bs = computeBalanceSheet(
      [makeAccount({ bank_name: 'Firstcitizenbank loan 7363', account_type: 'loan', closing_balance: 140246.52 })],
      [makeTx({ bank_name: 'FirstCitizens loan 7363' })],
      2025,
    )
    expect(bs.can_state).toBe(false)
    expect(bs.notes.some(n => n.includes('FirstCitizens loan 7363'))).toBe(true)
  })

  it('REFUSES rather than let a closed account erase a PRIOR year\'s liability', () => {
    // is_active has no time dimension, so switching the loan off when it is renegotiated
    // in 2026 would drop 140,246.52 out of the 2025 statement retroactively and move
    // equity by the same amount, silently. The books still carry its 2025 rows.
    // The 4th argument is the point of this test: getBalanceSheet reads the FULL registry
    // (active + inactive) so a closed account can be told apart from one the registry
    // never held — an earlier version of this test omitted that argument, which meant it
    // asserted a true thing without exercising the branch it was named for.
    const loan = makeAccount({ bank_name: 'Firstcitizenbank loan 7363', account_type: 'loan', closing_balance: 140246.52, is_active: false })
    const active = makeAccount({ bank_name: 'Chase checking 3920', closing_balance: 17832.23 })
    const bs = computeBalanceSheet([active], [
      makeTx({ bank_name: 'Chase checking 3920' }),
      makeTx({ bank_name: 'Firstcitizenbank loan 7363', amount: -1200 }),
    ], 2025, [active, loan])

    expect(bs.can_state).toBe(false)
    expect(bs.notes.some(n => n.includes('Firstcitizenbank loan 7363') && n.includes('marked closed'))).toBe(true)
    // The engine still ARRIVES at a number — a clean positive 17,832.23 for a company
    // that owes a mortgage. can_state is the only thing standing between that number and
    // the screen, which is exactly why it is asserted first and why the tab must never
    // render a total without checking it.
    expect(bs.equity).toBe(17832.23)
  })

  it('REFUSES a partial statement — one account in the year is not the company', () => {
    // The real shape of a year-end close: balances are updated ONE ACCOUNT AT A TIME.
    // The moment the first 2026 figure is entered, 2026 has one match and the rest are
    // still on 2025. That used to print total assets of a single bank account, "None
    // recorded" against liabilities and POSITIVE equity — for a company carrying a
    // 140,246.52 mortgage that was simply not on the page.
    const bs = computeBalanceSheet([
      makeAccount({ bank_name: 'Chase', closing_balance: 17832.23, closing_date: '2026-12-31' }),
      makeAccount({ bank_name: 'FCB loan', account_type: 'loan', closing_balance: 140246.52, closing_date: '2025-12-31' }),
    ], [], 2026)

    expect(bs.can_state).toBe(false)
    expect(bs.notes.some(n => n.includes('FCB loan') && n.includes('2025'))).toBe(true)
  })

  it('names the accounts struck before the year end WITHOUT crying wolf over them', () => {
    // Six of the thirteen real accounts are like this: the balance is derived from the
    // last row that published a running balance, mid-December. Nothing moved afterwards,
    // so the figure is right. Warning on the date alone would flag all six every year and
    // train the reader to ignore the notes.
    const bs = computeBalanceSheet([
      makeAccount({ bank_name: 'Chase', closing_date: '2025-12-31' }),
      makeAccount({ bank_name: 'Relay', closing_date: '2025-12-15' }),
    ], [makeTx({ bank_name: 'Relay', transaction_date: '2025-12-10' })], 2025)

    expect(bs.can_state).toBe(true)
    expect(bs.notes.some(n => n.includes('Relay') && n.includes('carries to the year end'))).toBe(true)
  })

  it('an account with no closing DATE cannot be placed in any year', () => {
    const bs = computeBalanceSheet([makeAccount({ closing_date: null })], [], 2025)
    expect(bs.can_state).toBe(false)
    expect(bs.total_assets).toBe(0)
  })

  it('a processor balance counts as cash — it is the company money, just in transit', () => {
    const bs = computeBalanceSheet([makeAccount({ account_type: 'processor', closing_balance: 500 })], [], 2025)
    expect(bs.cash).toHaveLength(1)
    expect(bs.total_assets).toBe(500)
  })

  it('NEVER converts a foreign balance into the totals — it is listed separately', () => {
    const bs = computeBalanceSheet([
      makeAccount({ bank_name: 'Chase', closing_balance: 100 }),
      makeAccount({ bank_name: 'Airwallex EUR', currency: 'EUR', closing_balance: 4258.76 }),
    ], [], 2025)

    expect(bs.total_assets).toBe(100)
    expect(bs.cash.map(l => l.label)).toEqual(['Chase'])
    expect(bs.foreign).toEqual([{ currency: 'EUR', label: 'Airwallex EUR', amount: 4258.76 }])
    expect(bs.notes.some(n => n.includes('EUR'))).toBe(true)
  })

  it('NAMES an account whose balance is unknown instead of dropping it silently', () => {
    // Dropping it understates what is OWED and overstates equity — the one direction a
    // balance sheet must never be wrong in.
    const bs = computeBalanceSheet([
      makeAccount({ bank_name: 'Known', closing_balance: 250 }),
      makeAccount({ bank_name: 'Amex card', account_type: 'credit_card', closing_balance: null }),
    ], [], 2025)

    // It must be NAMED — and the note has to be reachable. The balance check used to run
    // AFTER the year filter, and an account with no balance has no date either, so it was
    // dropped by the year test before anything could name it: a card with an unknown
    // balance vanished in total silence.
    expect(bs.notes.some(n => n.includes('Amex card') && n.includes('overstates'))).toBe(true)
    // And it blocks the statement: what is owed is unknown, so equity is unknowable.
    expect(bs.can_state).toBe(false)
  })

  it('carries the property purchase — the one place it appears, since profit excludes it', () => {
    const bs = computeBalanceSheet([makeAccount()], [
      makeTx({ subcategory: 'fixed_asset_office_purchase', amount: -29032.53 }),
      makeTx({ subcategory: 'fixed_asset_office_purchase', amount: -6000 }),
    ], 2025)

    expect(bs.other_assets[0]).toMatchObject({ label: 'Office property (at cost)', amount: 35032.53 })
    expect(bs.notes.some(n => n.includes('depreciation'))).toBe(true)
  })

  it('a credit tagged to the purchase REDUCES what the property cost', () => {
    const bs = computeBalanceSheet([makeAccount()], [
      makeTx({ subcategory: 'fixed_asset_office_purchase', amount: -35032.53 }),
      makeTx({ subcategory: 'fixed_asset_office_purchase', amount: 5000 }),
    ], 2025)
    expect(bs.other_assets[0].amount).toBeCloseTo(30032.53, 2)
  })

  it('with NO registry it reports it cannot state a position, property or not', () => {
    // Production's state. The property alone used to be enough to make the screen print
    // total assets, "None recorded" liabilities and POSITIVE equity for a company that
    // owes a mortgage.
    const bs = computeBalanceSheet([], [
      makeTx({ subcategory: 'fixed_asset_office_purchase', amount: -35032.53 }),
    ], 2025)

    expect(bs.can_state).toBe(false)
    expect(bs.liabilities).toHaveLength(0)
    expect(bs.notes.some(n => n.includes('No account records exist'))).toBe(true)
  })

  it('keeps the source and the date of each balance so a reader can weigh it', () => {
    const bs = computeBalanceSheet([makeAccount({ closing_source: 'provider_report' })], [], 2025)
    expect(bs.cash[0].source).toBe('provider_report')
    expect(bs.cash[0].as_of).toBe('2025-12-31')
  })
})

/** `getCashPosition` hits the database and cannot be unit-tested directly, so the rule
 *  that decides which books rows it must NOT double-count is pulled out as this pure
 *  function — the fix for a bug-hunter finding: the registry names an account by itself
 *  ("Mercury checking 4517"), the bank feed labels its own rows by bare institution
 *  ("Mercury"), and a raw-string claim set could not see those as the same account — a
 *  feed row that started publishing its own balance would have been added a second time,
 *  doubling the cash figure the moment that started happening (not live when found, but a
 *  real shape, not a hypothetical one — the same namespace split already broke the
 *  balance sheet twice in this file's history). */
describe('claimedAccountNames', () => {
  it('claims the full account name, case- and spacing-insensitively', () => {
    const claimed = claimedAccountNames([makeAccount({ bank_name: 'Firstcitizenbank checking 5820' })])
    expect(claimed.has('firstcitizenbank checking 5820')).toBe(true)
  })

  it('claims a bare institution label when it names exactly ONE active account', () => {
    // The live shape: Mercury has one account in the registry, so the bank feed's bare
    // "Mercury" rows must be recognised as that account, not counted as a new one.
    const claimed = claimedAccountNames([makeAccount({ bank_name: 'Mercury checking 4517' })])
    expect(claimed.has('mercury')).toBe(true)
  })

  it('does NOT claim a bare institution label that names SEVERAL accounts', () => {
    // Chase has a checking account and two credit cards in the real registry. A bare
    // "Chase" row cannot say which one it belongs to — claiming it anyway would silently
    // attribute it to whichever the fallback happens to prefer, hiding the ambiguity
    // rather than surfacing it. Unclaimed here means the fallback still sees the row
    // (as a new, separately-visible entry) rather than the registry balance absorbing it.
    const claimed = claimedAccountNames([
      makeAccount({ bank_name: 'Chase checking 3920' }),
      makeAccount({ bank_name: 'Chase credit card 6094', account_type: 'credit_card' }),
    ])
    expect(claimed.has('chase')).toBe(false)
    expect(claimed.has('chase checking 3920')).toBe(true)
    expect(claimed.has('chase credit card 6094')).toBe(true)
  })

  it('claims a CLOSED account too, so it cannot be resurrected via the fallback', () => {
    const claimed = claimedAccountNames([makeAccount({ bank_name: 'Old Bank', is_active: false })])
    expect(claimed.has('old bank')).toBe(true)
  })

  it('an inactive account does not count toward institution ambiguity', () => {
    // Only ACTIVE accounts compete for a bare institution label — a closed sibling should
    // not block the live account from being recognised under its institution's short name.
    const claimed = claimedAccountNames([
      makeAccount({ bank_name: 'Mercury checking 4517' }),
      makeAccount({ bank_name: 'Mercury checking 9999', is_active: false }),
    ])
    expect(claimed.has('mercury')).toBe(true)
  })
})

/** `computeBalanceSheet`'s two account-matching questions — "is this a described
 *  account" and "did money move after its balance was struck" — answer with the SAME
 *  comparison for a reason: they used to use different ones, and that let a stale balance
 *  certify itself as unmoved (a bug-hunter finding, fixed by sharing one function). This
 *  test does not just check outcomes on cases where both checks happen to fail for
 *  unrelated reasons — it isolates a pair that differs ONLY by something normalisation
 *  handles, so a future edit that re-splits the two checks onto different comparisons
 *  would fail it even if each half still "worked" on its own. */
describe('coverage and staleness stay on one shared comparison', () => {
  it('a same-account pair differing ONLY by case/spacing matches on BOTH checks at once', () => {
    const bs = computeBalanceSheet(
      [makeAccount({ bank_name: '  CHASE   Checking 3920  ', closing_balance: 17832.23, closing_date: '2025-06-30' })],
      [makeTx({ bank_name: 'chase checking 3920', transaction_date: '2025-05-01' })],
      2025,
    )
    // Covered (no "does not match" note) AND the staleness check found the row and
    // passed it — if either half used a different key, one of these would flip.
    expect(bs.can_state).toBe(true)
    expect(bs.as_of).toBe('2025-12-31')
  })
})
