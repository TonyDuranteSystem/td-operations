/**
 * buildPnlWorkbook — the pure (no-DB) workbook builder extracted from
 * generatePnlExcel (M1 of the standalone-P&L job). These tests prove it runs
 * with NO database access, on in-memory transactions alone, which is exactly
 * what the /tools/pnl external mode (M3) relies on. Totals math is already
 * covered by pnl-totals.test.ts; here we assert the assembled workbook's
 * PnlResult summary + that the file is a readable 5-sheet xlsx.
 */

import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import { buildPnlWorkbook, type BuildPnlWorkbookInput } from '@/lib/pnl-generator'
import type { Database } from '@/lib/database.types'

type BankTxRow = Database['public']['Tables']['bank_transactions']['Row']

/** Minimal BankTxRow fixture — fill only what the builder reads. */
function tx(partial: Partial<BankTxRow>): BankTxRow {
  return {
    account_id: 'acct-1',
    account_type: 'Checking',
    ai_bucket: null,
    ai_lean: null,
    amount: 0,
    balance_after: null,
    bank_name: 'Test Bank',
    category: 'uncategorized',
    counterparty: null,
    created_at: null,
    currency: 'USD',
    description: 'row',
    id: crypto.randomUUID(),
    is_related_party: null,
    notes: null,
    source_file_id: null,
    subcategory: null,
    tax_year: 2025,
    transaction_date: '2025-06-01',
    transaction_ref: 'REF',
    ...partial,
  }
}

const baseInput = (over: Partial<BuildPnlWorkbookInput> = {}): BuildPnlWorkbookInput => ({
  companyName: 'Test Co',
  members: [
    { name: 'Alice', ownership_pct: 50 },
    { name: 'Bob', ownership_pct: 50 },
  ],
  taxYear: 2025,
  transactions: [
    tx({ category: 'income', amount: 10000, transaction_date: '2025-02-01', balance_after: 10000 }),
    tx({ category: 'expense', amount: -3000, transaction_date: '2025-03-01', balance_after: 7000 }),
    tx({ category: 'distribution', amount: -1000, counterparty: 'Alice', transaction_date: '2025-04-01', balance_after: 6000 }),
  ],
  priorTransactions: [],
  rates: { USD: 1 },
  priorRates: {},
  ...over,
})

describe('buildPnlWorkbook — pure, no DB', () => {
  it('computes the PnlResult summary from in-memory transactions', async () => {
    const result = await buildPnlWorkbook(baseInput())
    expect(result.totalRevenue).toBe(10000)
    expect(result.totalExpenses).toBe(3000)
    expect(result.netIncome).toBe(7000)
    expect(result.uncategorizedCount).toBe(0)
    expect(result.fileName).toBe('Test Co - PnL 2025.xlsx')
    expect(result.buffer.length).toBeGreaterThan(0)
  })

  it('produces a readable 5-sheet workbook', async () => {
    const result = await buildPnlWorkbook(baseInput())
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(result.buffer as unknown as Buffer)
    const names = wb.worksheets.map(w => w.name)
    expect(names).toEqual([
      'P&L Statement',
      'Balance Sheet',
      'Income Detail',
      'Expense Detail',
      'Distributions',
    ])
  })

  it('throws on empty transactions instead of emitting a blank sheet', async () => {
    await expect(buildPnlWorkbook(baseInput({ transactions: [] }))).rejects.toThrow(/no transactions/i)
  })

  it('flags uncategorized rows in the count (F2 visibility carried through)', async () => {
    const result = await buildPnlWorkbook(
      baseInput({
        transactions: [
          tx({ category: 'income', amount: 5000, balance_after: 5000 }),
          tx({ category: 'uncategorized', amount: -250, balance_after: 4750 }),
        ],
      }),
    )
    expect(result.uncategorizedCount).toBe(1)
  })
})
