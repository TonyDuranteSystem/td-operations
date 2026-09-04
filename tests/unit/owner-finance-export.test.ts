import { describe, it, expect } from 'vitest'
import { buildOwnerFinancialsWorkbook, type OwnerFinancialsExportInput } from '@/lib/owner-finance-export'
import type { OwnerPnL, PnLBlock, BalanceSheet, FilingSummary, OwnerTransaction, OwnerAccount } from '@/lib/owner-finance'

const makeBlock = (overrides: Partial<PnLBlock> = {}): PnLBlock => ({
  currency: 'USD',
  invoice_income: 1000,
  other_income: 0,
  cogs: 100,
  gross_profit: 900,
  expenses: 300,
  net_profit: 600,
  distributions: 0,
  contributions: 0,
  uncategorized_income: 0,
  uncategorized_expense: 0,
  by_subcategory: { 'cogs/state_filing_fees': 100, 'expense/software': 300 },
  monthly: Array.from({ length: 12 }, (_, i) => ({ month: i + 1, income: 0, cogs: 0, expenses: 0, net: 0 })),
  usd_rate: null,
  ...overrides,
})

const makePnL = (blocks: PnLBlock[]): OwnerPnL => ({
  year: 2025,
  blocks,
  income_anomalies: [],
  approximated_date_count: 0,
  partial_attribution_count: 0,
})

const makeBalanceSheet = (overrides: Partial<BalanceSheet> = {}): BalanceSheet => ({
  year: 2025,
  as_of: '2025-12-31',
  currency: 'USD',
  cash: [{ label: 'Mercury checking', amount: 1000 }],
  other_assets: [],
  total_assets: 1000,
  liabilities: [{ label: 'Credit card', amount: 200 }],
  total_liabilities: 200,
  equity: 800,
  foreign: [],
  notes: [],
  can_state: true,
  ...overrides,
})

const makeFiling = (overrides: Partial<FilingSummary> = {}): FilingSummary => ({
  year: 2025,
  books_net_usd: 600,
  foreign: [],
  adjustments: [{ label: 'Half of business meals added back', amount: 50, why: 'Only 50% deductible.' }],
  taxable_income: 650,
  capitalized: [],
  warnings: [],
  ...overrides,
})

const makeTx = (overrides: Partial<OwnerTransaction> = {}): OwnerTransaction => ({
  id: 'tx-1',
  transaction_date: '2025-03-15',
  description: 'Test transaction',
  category: 'expense',
  subcategory: 'software',
  counterparty: null,
  amount: -300,
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

const makeAccount = (overrides: Partial<OwnerAccount> = {}): OwnerAccount => ({
  bank_name: 'Mercury checking 4517',
  institution: 'Mercury',
  account_number: '4517',
  account_type: 'checking',
  sign_convention: 'asset',
  is_clearing: false,
  currency: 'USD',
  opening_balance: 0,
  opening_date: '2025-01-01',
  closing_balance: 1000,
  closing_date: '2025-12-31',
  closing_source: 'statement',
  notes: null,
  is_active: true,
  ...overrides,
})

const baseInput = (overrides: Partial<OwnerFinancialsExportInput> = {}): OwnerFinancialsExportInput => ({
  year: 2025,
  pnl: makePnL([makeBlock()]),
  balanceSheet: makeBalanceSheet(),
  filing: makeFiling(),
  transactions: [makeTx()],
  accounts: [makeAccount()],
  ...overrides,
})

function cellTexts(ws: import('exceljs').Worksheet): string[] {
  const out: string[] = []
  ws.eachRow(row => {
    const v = row.getCell(1).value
    if (typeof v === 'string') out.push(v)
  })
  return out
}

describe('buildOwnerFinancialsWorkbook', () => {
  it('creates exactly the five expected sheets, in order', () => {
    const wb = buildOwnerFinancialsWorkbook(baseInput())
    expect(wb.worksheets.map(w => w.name)).toEqual([
      'Profit and Loss',
      'Balance Sheet',
      'Category summary',
      'Transactions',
      'Accounts',
    ])
  })

  it('includes EVERY currency block on the P&L sheet, not just USD — a third currency must not be silently dropped', () => {
    const wb = buildOwnerFinancialsWorkbook(
      baseInput({
        pnl: makePnL([
          makeBlock({ currency: 'USD' }),
          makeBlock({ currency: 'EUR', usd_rate: 1.08 }),
          makeBlock({ currency: 'DKK', usd_rate: null }),
        ]),
      }),
    )
    const pl = wb.getWorksheet('Profit and Loss')!
    const texts = cellTexts(pl).join(' | ')
    expect(texts).toContain('REVENUE')
    expect(texts).toContain('REVENUE (EUR)')
    expect(texts).toContain('REVENUE (DKK)')
  })

  it('shows a plain "cannot be stated" message instead of numbers when the balance sheet cannot state a position', () => {
    const wb = buildOwnerFinancialsWorkbook(baseInput({ year: 2023, balanceSheet: makeBalanceSheet({ can_state: false, year: 2023 }) }))
    const bs = wb.getWorksheet('Balance Sheet')!
    const texts = cellTexts(bs).join(' | ')
    expect(texts).toContain('A complete balance sheet cannot be stated for 2023')
    expect(texts).not.toContain('ASSETS')
  })

  it('states a normal balance sheet position when can_state is true', () => {
    const wb = buildOwnerFinancialsWorkbook(baseInput())
    const bs = wb.getWorksheet('Balance Sheet')!
    const texts = cellTexts(bs).join(' | ')
    expect(texts).toContain('ASSETS')
    expect(texts).toContain('TOTAL ASSETS')
    expect(texts).toContain("MEMBERS' EQUITY (DEFICIT)")
  })

  it('the filing adjustments and taxable income on the P&L sheet come from the SAME filing summary the Tax tab uses, not re-derived', () => {
    const wb = buildOwnerFinancialsWorkbook(
      baseInput({ filing: makeFiling({ taxable_income: 999999, adjustments: [{ label: 'Custom adjustment', amount: 1, why: 'x' }] }) }),
    )
    const pl = wb.getWorksheet('Profit and Loss')!
    const texts = cellTexts(pl).join(' | ')
    expect(texts).toContain('Custom adjustment')
    const row = pl.getRow(pl.rowCount)
    // The last rows include the ordinary business income line; scan all rows for the amount.
    let found = false
    pl.eachRow(r => { if (r.getCell(2).value === 999999) found = true })
    void row
    expect(found).toBe(true)
  })

  it('aggregates the category summary by category, subcategory, and currency', () => {
    const wb = buildOwnerFinancialsWorkbook(
      baseInput({
        transactions: [
          makeTx({ category: 'expense', subcategory: 'software', currency: 'USD', amount: -100 }),
          makeTx({ category: 'expense', subcategory: 'software', currency: 'USD', amount: -50 }),
          makeTx({ category: 'expense', subcategory: 'software', currency: 'EUR', amount: -20 }),
        ],
      }),
    )
    const cs = wb.getWorksheet('Category summary')!
    const rows: Array<Record<string, unknown>> = []
    cs.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return
      rows.push({ c: row.getCell(1).value, s: row.getCell(2).value, cur: row.getCell(3).value, n: row.getCell(4).value, a: row.getCell(5).value })
    })
    const usdRow = rows.find(r => r.cur === 'USD')
    const eurRow = rows.find(r => r.cur === 'EUR')
    expect(usdRow).toMatchObject({ c: 'expense', s: 'software', n: 2, a: -150 })
    expect(eurRow).toMatchObject({ c: 'expense', s: 'software', n: 1, a: -20 })
  })

  it('lists every transaction on the Transactions sheet, sorted by date', () => {
    const wb = buildOwnerFinancialsWorkbook(
      baseInput({
        transactions: [
          makeTx({ id: 'a', transaction_date: '2025-06-01', description: 'June row' }),
          makeTx({ id: 'b', transaction_date: '2025-01-01', description: 'January row' }),
        ],
      }),
    )
    const tx = wb.getWorksheet('Transactions')!
    expect(tx.getRow(2).getCell(3).value).toBe('January row')
    expect(tx.getRow(3).getCell(3).value).toBe('June row')
  })

  it('lists every account on the Accounts sheet', () => {
    const wb = buildOwnerFinancialsWorkbook(
      baseInput({
        accounts: [
          makeAccount({ bank_name: 'Zeta checking' }),
          makeAccount({ bank_name: 'Alpha checking' }),
        ],
      }),
    )
    const ac = wb.getWorksheet('Accounts')!
    // Sorted alphabetically by bank_name.
    expect(ac.getRow(2).getCell(1).value).toBe('Alpha checking')
    expect(ac.getRow(3).getCell(1).value).toBe('Zeta checking')
  })
})
