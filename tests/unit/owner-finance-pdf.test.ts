import { describe, it, expect } from 'vitest'
import { buildProfitAndLossHtml, buildBalanceSheetHtml } from '@/lib/owner-finance-pdf'
import type { OwnerFinancialsExportInput } from '@/lib/owner-finance-export'
import type { OwnerPnL, PnLBlock, BalanceSheet, FilingSummary } from '@/lib/owner-finance'

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

const baseInput = (overrides: Partial<OwnerFinancialsExportInput> = {}): OwnerFinancialsExportInput => ({
  year: 2025,
  pnl: makePnL([makeBlock()]),
  balanceSheet: makeBalanceSheet(),
  filing: makeFiling(),
  transactions: [],
  accounts: [],
  ...overrides,
})

describe('buildProfitAndLossHtml', () => {
  it('is well-formed HTML naming the company and the year', () => {
    const html = buildProfitAndLossHtml(baseInput())
    expect(html).toMatch(/^<!doctype html>/i)
    expect(html).toContain('TONY DURANTE LLC')
    expect(html).toContain('2025')
  })

  it('gives EVERY currency block its own section, not just USD — a third currency must not be silently dropped', () => {
    const html = buildProfitAndLossHtml(
      baseInput({
        pnl: makePnL([
          makeBlock({ currency: 'USD' }),
          makeBlock({ currency: 'EUR', usd_rate: 1.08 }),
          makeBlock({ currency: 'DKK', usd_rate: null }),
        ]),
      }),
    )
    expect(html).toContain('REVENUE</td>')
    expect(html).toContain('REVENUE (EUR)')
    expect(html).toContain('REVENUE (DKK)')
  })

  it('shows the filing adjustments and taxable income from the SAME filing summary the Tax tab uses', () => {
    const html = buildProfitAndLossHtml(
      baseInput({ filing: makeFiling({ taxable_income: 999999, adjustments: [{ label: 'Custom adjustment', amount: 1, why: 'x' }] }) }),
    )
    expect(html).toContain('Custom adjustment')
    expect(html).toContain('ORDINARY BUSINESS INCOME')
    // $999,999.00 formatted via formatOwnerCurrency.
    expect(html).toContain('999,999.00')
  })

  it('surfaces filing warnings in the notes', () => {
    const html = buildProfitAndLossHtml(baseInput({ filing: makeFiling({ warnings: ['EUR activity could not be converted.'] }) }))
    expect(html).toContain('EUR activity could not be converted.')
  })
})

describe('buildBalanceSheetHtml', () => {
  it('shows a plain "cannot be stated" message instead of numbers when can_state is false', () => {
    const html = buildBalanceSheetHtml(baseInput({ year: 2023, balanceSheet: makeBalanceSheet({ can_state: false, year: 2023 }) }))
    expect(html).toContain('A complete balance sheet cannot be stated for 2023')
    expect(html).not.toContain('TOTAL ASSETS')
  })

  it('states a normal position when can_state is true', () => {
    const html = buildBalanceSheetHtml(baseInput())
    expect(html).toContain('ASSETS')
    expect(html).toContain('TOTAL ASSETS')
    expect(html).toContain("MEMBERS' EQUITY")
  })

  it('lists foreign-currency balances separately from the reporting currency', () => {
    const html = buildBalanceSheetHtml(
      baseInput({ balanceSheet: makeBalanceSheet({ foreign: [{ currency: 'EUR', label: 'Airwallex EUR', amount: 500 }] }) }),
    )
    expect(html).toContain('HELD IN OTHER CURRENCIES')
    expect(html).toContain('Airwallex EUR')
  })
})
