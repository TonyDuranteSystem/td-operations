import { describe, it, expect } from 'vitest'
import {
  applyVendorRules,
  computeInvoiceIncome,
  computeOwnerPnL,
  isSimilarVendor,
  normalizeVendorKey,
  OWNER_ACCOUNT_ID,
  TD_ENTITY_ID,
  type InvoiceIncomeRow,
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

  it('contains-rules match across bank wordings — the merchant marker IS the identity, so a "stripe" rule covers both wordings', () => {
    const mercury = makeTx({ counterparty: 'STRIPE; TRANSFER; TONY DURANTE LLC; Merchant name: STRIPE' })
    const relay = makeTx({ counterparty: 'STRIPE - TRANSFER' })
    const rule = makeRule({ counterparty_pattern: 'stripe', match_type: 'contains', category: 'transfer', subcategory: 'stripe_payout' })
    expect(applyVendorRules([mercury], [rule])[0].category).toBe('transfer')
    expect(applyVendorRules([relay], [rule])[0].category).toBe('transfer')
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

describe('vendorIdentity (sender-noise / merchant-marker handling)', () => {
  it("Mercury outgoing payment: counterparty is the SENDER (own company) — identity must be the merchant, not us (Antonio's live catch: $2,500 IT Infonity grouped with own transfers)", async () => {
    const { vendorIdentity } = await import('@/lib/owner-vendor-match')
    expect(vendorIdentity('Tony Durante LLC', 'From Tony Durante LLC; Merchant name: IT Infonity')).toBe('it infonity')
  })

  it('genuine self-transfers keep the own name and still group with each other', async () => {
    const { vendorIdentity, isSimilarVendor } = await import('@/lib/owner-vendor-match')
    const a = vendorIdentity('Tony Durante LLC', 'Tony Durante LLC — From Tony Durante LLC')
    const b = vendorIdentity('Tony Durante LLC — From Tony Durante LLC', null)
    expect(isSimilarVendor(a, b)).toBe(true)
    expect(a).toBe('tony durante llc')
  })

  it('the IT Infonity payment must NOT match the own-transfer group', async () => {
    const { vendorIdentity, isSimilarVendor } = await import('@/lib/owner-vendor-match')
    const transfer = vendorIdentity('Tony Durante LLC', 'Tony Durante LLC — From Tony Durante LLC')
    const vendorPayment = vendorIdentity('Tony Durante LLC', 'From Tony Durante LLC; Merchant name: IT Infonity')
    expect(isSimilarVendor(transfer, vendorPayment)).toBe(false)
  })

  it('strips the own-entity sender suffix (incl. the Durant misspelling) so the recipient is the identity', async () => {
    const { vendorIdentity } = await import('@/lib/owner-vendor-match')
    expect(vendorIdentity('Olufunke Adeyemo — From Tony Durante LLC', null)).toBe('olufunke adeyemo')
    expect(vendorIdentity('SLASH - PRIME CI; PAYMENT; TONY DURANT LLC; Merchant name: SLASH - PRIME CI', null)).toBe('slash prime ci')
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
