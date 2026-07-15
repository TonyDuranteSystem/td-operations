/**
 * buildFinancialsWorkbook renders the Excel FROM the engine draft — so the
 * downloaded file matches the on-screen numbers. These tests pin that: the
 * Balance Sheet's beginning capital comes from the DRAFT (prior-return-aware),
 * not re-derived from statement opening balances, and the P&L net income is the
 * draft's.
 */

import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import { buildFinancialsWorkbook } from '@/lib/tax/financials-excel'
import type { FinancialDraft } from '@/lib/tax/financials-engine'

function draft(over: Partial<FinancialDraft> = {}): FinancialDraft {
  return {
    tax_year: 2025,
    pnl: {
      totalIncome: 10000, totalCogs: 0, grossProfit: 10000, totalExpenses: 3000,
      netIncome: 7000, totalDistributions: 1000, totalContributions: 0,
      uncategorizedCount: 0, uncategorizedTotal: 0,
      foldedUncategorizedCount: 0, foldedUncategorizedIncome: 0, foldedUncategorizedExpense: 0,
    },
    members: [
      { name: 'Alice', pct: 100, beginning_capital: 5000, contributions: 0, income_share: 7000, distributions: 1000, ending_capital: 11000 },
    ],
    banks: [],
    bank_balances: null,
    operating_expense_breakdown: [],
    beginning_cash: 5000,
    beginning_cash_source: 'prior_return',
    beginning_capital_total: 5000,
    ending_cash: 11000,
    total_assets: 11000,
    total_liabilities: 0,
    ending_capital_total: 11000,
    fx_translation_adjustment: 0,
    conversion_gross: 0,
    balance_sheet_check: 0,
    unattributed: { contributions: 0, distributions: 0 },
    notes: [],
    ...over,
  }
}

/** The value in the Balance Sheet CHECK row (second column). */
async function checkRowValue(buffer: Uint8Array): Promise<number> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer as unknown as ArrayBuffer)
  const sheet = wb.getWorksheet('Balance Sheet')!
  let val = NaN
  sheet.eachRow(r => {
    const label = r.getCell(1).value
    if (typeof label === 'string' && /^CHECK/i.test(label.trim())) val = Number(r.getCell(2).value)
  })
  return val
}

async function cellsOf(buffer: Uint8Array, sheetName: string): Promise<unknown[]> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer as unknown as ArrayBuffer)
  const sheet = wb.getWorksheet(sheetName)!
  const out: unknown[] = []
  sheet.eachRow(r => { r.eachCell(c => out.push(c.value)) })
  return out
}
const hasText = (cells: unknown[], re: RegExp) => cells.some(v => typeof v === 'string' && re.test(v))

describe('buildFinancialsWorkbook — renders from the draft', () => {
  it('Balance Sheet beginning capital comes from the draft (prior-return), not re-derived', async () => {
    const { buffer } = await buildFinancialsWorkbook({ companyName: 'Test Co', taxYear: 2025, draft: draft(), transactions: [], rates: {} })
    const bs = await cellsOf(buffer, 'Balance Sheet')
    // labelled as prior-return-sourced, value 5000
    expect(hasText(bs, /prior-year return/i)).toBe(true)
    expect(bs).toContain(5000)
    // ending equity = 11000, assets = 11000
    expect(bs).toContain(11000)
  })

  it('P&L net income is the draft net income', async () => {
    const { buffer } = await buildFinancialsWorkbook({ companyName: 'Test Co', taxYear: 2025, draft: draft(), transactions: [], rates: {} })
    const pl = await cellsOf(buffer, 'P&L Statement')
    expect(pl).toContain(7000)   // NET INCOME
    expect(pl).toContain(10000)  // Revenue
  })

  it('has the expected sheets incl. per-member capital accounts (K-1 L)', async () => {
    const { buffer, fileName } = await buildFinancialsWorkbook({ companyName: 'Test Co', taxYear: 2025, draft: draft(), transactions: [], rates: {} })
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buffer as unknown as ArrayBuffer)
    expect(wb.worksheets.map(w => w.name)).toEqual([
      'P&L Statement', 'Balance Sheet', 'Capital Accounts (K-1 L)', 'Income Detail', 'Expense Detail', 'Distributions',
    ])
    expect(fileName).toBe('Test Co - PnL 2025.xlsx')
  })

  it('flags a balance-sheet that does not balance', async () => {
    const { buffer } = await buildFinancialsWorkbook({
      companyName: 'X', taxYear: 2025,
      draft: draft({ total_assets: 99999, ending_capital_total: 11000, balance_sheet_check: 88999 }), transactions: [], rates: {},
    })
    const bs = await cellsOf(buffer, 'Balance Sheet')
    expect(hasText(bs, /CHECK/i)).toBe(true)
    expect(await checkRowValue(buffer)).toBeCloseTo(88999, 2)
  })

  it('renders the foreign-exchange line AND the CHECK ties when FX is present (Dynamiq class)', async () => {
    // assets 11000 = capital 52861.05 + FX (−41861.05); the engine sets balance_sheet_check ≈ 0.
    const { buffer } = await buildFinancialsWorkbook({
      companyName: 'FX Co', taxYear: 2025,
      draft: draft({ total_assets: 11000, ending_capital_total: 52861.05, fx_translation_adjustment: -41861.05, balance_sheet_check: 0 }),
      transactions: [], rates: {},
    })
    const bs = await cellsOf(buffer, 'Balance Sheet')
    expect(hasText(bs, /Foreign-exchange translation adjustment/i)).toBe(true)
    expect(bs).toContain(-41861.05)              // the FX line is present
    expect(await checkRowValue(buffer)).toBeCloseTo(0, 2)  // and the sheet TIES (was off by −41861.05)
  })
})
