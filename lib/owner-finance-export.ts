import ExcelJS from 'exceljs'
import type { OwnerPnL, BalanceSheet, FilingSummary, OwnerTransaction, OwnerAccount } from '@/lib/owner-finance'

/**
 * Builds the "hand a CPA everything" workbook — Profit & Loss, Balance Sheet, a category
 * summary, every transaction, and the account registry, for one tax year.
 *
 * PURE — every number here is already computed by the same engine the on-screen tabs use
 * (getOwnerPnL / getBalanceSheet / getFilingSummary); this file only lays it out. No DB
 * calls, so it can be unit-tested without a live database, and it can never disagree with
 * what the app itself shows for the same year.
 *
 * Replaces the one-off `.books-scratch/make-workbook.mjs` script used by hand to build the
 * corrected 2025 workbook sent to the accountant — same shape, minus that script's
 * "Reconciliation to draft return" sheet, which explained one specific year's correction
 * story with hardcoded numbers and does not generalize to a repeatable export.
 */

export interface OwnerFinancialsExportInput {
  year: number
  pnl: OwnerPnL
  balanceSheet: BalanceSheet
  filing: FilingSummary
  transactions: OwnerTransaction[]
  accounts: OwnerAccount[]
}

const MONEY_FMT = '$#,##0.00'
const PLAIN_MONEY_FMT = '#,##0.00'

const titleCase = (key: string) =>
  key.split('/').pop()!.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())

function titleBlock(ws: ExcelJS.Worksheet, title: string, sub: string) {
  ws.mergeCells('A1:C1')
  ws.getCell('A1').value = 'TONY DURANTE LLC'
  ws.getCell('A1').font = { bold: true, size: 14 }
  ws.mergeCells('A2:C2')
  ws.getCell('A2').value = title
  ws.getCell('A2').font = { size: 12 }
  ws.mergeCells('A3:C3')
  ws.getCell('A3').value = sub
  ws.getCell('A3').font = { size: 9, color: { argb: 'FF666666' } }
  ws.addRow([])
}

function line(
  ws: ExcelJS.Worksheet,
  label: string,
  amount: number | null,
  opts: { bold?: boolean; indent?: number; top?: boolean; dbl?: boolean; fmt?: string } = {},
) {
  const { bold = false, indent = 0, top = false, dbl = false, fmt = MONEY_FMT } = opts
  const row = ws.addRow([`${'    '.repeat(indent)}${label}`, amount])
  if (bold) row.font = { bold: true }
  if (amount !== null) row.getCell(2).numFmt = fmt
  if (top) row.getCell(1).border = row.getCell(2).border = { top: { style: 'thin' } }
  if (dbl) row.getCell(1).border = row.getCell(2).border = { top: { style: 'thin' }, bottom: { style: 'double' } }
  return row
}

function buildProfitAndLossSheet(wb: ExcelJS.Workbook, input: OwnerFinancialsExportInput) {
  const { pnl, filing, year } = input
  const ws = wb.addWorksheet('Profit and Loss')
  ws.columns = [{ width: 52 }, { width: 18 }]
  titleBlock(ws, 'Statement of Profit and Loss', `Year ended 31 December ${year} · Cash basis`)

  // Every currency the year actually has activity in — never assume it's just USD/EUR.
  // A silently-dropped third currency would understate revenue on a document going to a CPA.
  for (const block of pnl.blocks) {
    const fmt = block.currency === 'USD' ? MONEY_FMT : PLAIN_MONEY_FMT
    const suffix = block.currency === 'USD' ? '' : ` (${block.currency})`
    ws.addRow([`REVENUE${suffix}`]).font = { bold: true }
    line(ws, 'Client services (invoice ledger)', block.invoice_income, { indent: 1, fmt })
    if (block.other_income !== 0) line(ws, 'Other income', block.other_income, { indent: 1, fmt })
    const revenue = block.invoice_income + block.other_income
    line(ws, 'Total revenue', revenue, { bold: true, top: true, fmt })
    ws.addRow([])

    const catLines = Object.entries(block.by_subcategory).sort((a, b) => b[1] - a[1])
    const cogsLines = catLines.filter(([k]) => k.startsWith('cogs/'))
    const opLines = catLines.filter(([k]) => !k.startsWith('cogs/'))

    if (cogsLines.length > 0) {
      ws.addRow([`COST OF SERVICES${suffix}`]).font = { bold: true }
      cogsLines.forEach(([k, v]) => line(ws, titleCase(k), v, { indent: 1, fmt }))
      line(ws, 'Total cost of services', block.cogs, { bold: true, top: true, fmt })
      line(ws, 'GROSS PROFIT', revenue - block.cogs, { bold: true, top: true, fmt })
      ws.addRow([])
    }

    ws.addRow([`OPERATING EXPENSES${suffix}`]).font = { bold: true }
    opLines.forEach(([k, v]) => line(ws, titleCase(k), v, { indent: 1, fmt }))
    line(ws, 'Total operating expenses', block.expenses, { bold: true, top: true, fmt })
    ws.addRow([])
    if (block.distributions !== 0) line(ws, 'Distributions', block.distributions, { indent: 0, fmt })
    if (block.contributions !== 0) line(ws, 'Contributions', block.contributions, { indent: 0, fmt })
    line(ws, `NET PROFIT PER BOOKS${suffix}`, block.net_profit, { bold: true, dbl: true, fmt })
    ws.addRow([])
    ws.addRow([])
  }

  // The single combined, tax-ready figure — reuses computeFilingSummary's own adjustments
  // rather than re-deriving them, so this can never disagree with the Tax tab.
  ws.addRow(['ADJUSTMENTS FOR TAX PURPOSES']).font = { bold: true }
  filing.adjustments.forEach(a => line(ws, a.label, a.amount, { indent: 1 }))
  line(ws, 'ORDINARY BUSINESS INCOME (USD)', filing.taxable_income, { bold: true, dbl: true })
  if (filing.warnings.length > 0) {
    ws.addRow([])
    ws.addRow(['NEEDS ATTENTION']).font = { bold: true, color: { argb: 'FFB30000' } }
    filing.warnings.forEach(w => {
      const r = ws.addRow([w])
      r.font = { italic: true, size: 9 }
      ws.mergeCells(`A${r.number}:B${r.number}`)
      r.alignment = { wrapText: true }
    })
  }
}

function buildBalanceSheetSheet(wb: ExcelJS.Workbook, input: OwnerFinancialsExportInput) {
  const { balanceSheet: bs, year } = input
  const ws = wb.addWorksheet('Balance Sheet')
  ws.columns = [{ width: 52 }, { width: 18 }]
  titleBlock(ws, 'Balance Sheet', `As at 31 December ${year} · Cash basis · ${bs.currency}`)

  if (!bs.can_state) {
    const r = ws.addRow([
      `A complete balance sheet cannot be stated for ${year} — the account records available do not cover the full year. See the notes below.`,
    ])
    r.font = { italic: true }
    ws.mergeCells(`A${r.number}:B${r.number}`)
    r.alignment = { wrapText: true }
    ws.addRow([])
  } else {
    ws.addRow(['ASSETS']).font = { bold: true }
    ws.addRow(['    Cash and cash equivalents']).font = { bold: true }
    bs.cash.forEach(l => line(ws, l.label, l.amount, { indent: 2 }))
    line(ws, 'Total cash and cash equivalents', bs.cash.reduce((s, l) => s + l.amount, 0), { bold: true, top: true })
    ws.addRow([])
    if (bs.other_assets.length > 0) {
      ws.addRow(['    Other assets']).font = { bold: true }
      bs.other_assets.forEach(l => line(ws, l.label, l.amount, { indent: 2 }))
    }
    line(ws, 'TOTAL ASSETS', bs.total_assets, { bold: true, top: true })
    ws.addRow([])
    ws.addRow(['LIABILITIES']).font = { bold: true }
    bs.liabilities.forEach(l => line(ws, l.label, l.amount, { indent: 1 }))
    line(ws, 'TOTAL LIABILITIES', bs.total_liabilities, { bold: true, top: true })
    ws.addRow([])
    line(ws, "MEMBERS' EQUITY (DEFICIT)", bs.equity, { bold: true, dbl: true })

    if (bs.foreign.length > 0) {
      ws.addRow([])
      ws.addRow(['HELD IN OTHER CURRENCIES — not included above']).font = { bold: true }
      bs.foreign.forEach(f => line(ws, `${f.label} (${f.currency})`, f.amount, { fmt: PLAIN_MONEY_FMT }))
    }
  }

  if (bs.notes.length > 0) {
    ws.addRow([])
    ws.addRow(['NOTES']).font = { bold: true }
    bs.notes.forEach(n => {
      const r = ws.addRow([n])
      r.font = { italic: true, size: 9 }
      ws.mergeCells(`A${r.number}:B${r.number}`)
      r.alignment = { wrapText: true }
    })
  }
}

function buildCategorySummarySheet(wb: ExcelJS.Workbook, input: OwnerFinancialsExportInput) {
  const ws = wb.addWorksheet('Category summary')
  ws.columns = [
    { header: 'Category', key: 'c', width: 18 },
    { header: 'Subcategory', key: 's', width: 30 },
    { header: 'Currency', key: 'cur', width: 10 },
    { header: 'Transactions', key: 'n', width: 14 },
    { header: 'Net amount', key: 'a', width: 18 },
  ]
  ws.getRow(1).font = { bold: true }
  const agg: Record<string, { c: string; s: string; cur: string; n: number; a: number }> = {}
  for (const r of input.transactions) {
    const key = `${r.category}|${r.subcategory ?? ''}|${r.currency ?? 'USD'}`
    agg[key] ??= { c: r.category, s: r.subcategory ?? '', cur: r.currency ?? 'USD', n: 0, a: 0 }
    agg[key].n++
    agg[key].a += Number(r.amount)
  }
  Object.values(agg)
    .sort((a, b) => a.c.localeCompare(b.c) || a.a - b.a)
    .forEach(v => {
      const row = ws.addRow(v)
      row.getCell('a').numFmt = v.cur === 'USD' ? MONEY_FMT : PLAIN_MONEY_FMT
    })
  ws.autoFilter = { from: 'A1', to: 'E1' }
  ws.views = [{ state: 'frozen', ySplit: 1 }]
}

function buildTransactionsSheet(wb: ExcelJS.Workbook, input: OwnerFinancialsExportInput) {
  const ws = wb.addWorksheet('Transactions')
  ws.columns = [
    { header: 'Date', key: 'd', width: 12 },
    { header: 'Account', key: 'b', width: 30 },
    { header: 'Description', key: 'de', width: 62 },
    { header: 'Category', key: 'c', width: 16 },
    { header: 'Subcategory', key: 's', width: 26 },
    { header: 'Currency', key: 'cur', width: 10 },
    { header: 'Amount', key: 'a', width: 16 },
  ]
  ws.getRow(1).font = { bold: true }
  const sorted = [...input.transactions].sort((a, b) => a.transaction_date.localeCompare(b.transaction_date))
  for (const r of sorted) {
    const cur = r.currency ?? 'USD'
    const row = ws.addRow({
      d: r.transaction_date,
      b: r.bank_name ?? '',
      de: r.description ?? '',
      c: r.category ?? '',
      s: r.subcategory ?? '',
      cur,
      a: Number(r.amount),
    })
    row.getCell('a').numFmt = cur === 'USD' ? MONEY_FMT : PLAIN_MONEY_FMT
  }
  ws.autoFilter = { from: 'A1', to: 'G1' }
  ws.views = [{ state: 'frozen', ySplit: 1 }]
}

function buildAccountsSheet(wb: ExcelJS.Workbook, input: OwnerFinancialsExportInput) {
  const ws = wb.addWorksheet('Accounts')
  ws.columns = [
    { header: 'Account', key: 'b', width: 34 },
    { header: 'Type', key: 't', width: 14 },
    { header: 'Currency', key: 'cur', width: 10 },
    { header: 'Closing balance', key: 'c', width: 18 },
    { header: 'Statement date', key: 'd', width: 16 },
  ]
  ws.getRow(1).font = { bold: true }
  ;[...input.accounts]
    .sort((a, b) => a.bank_name.localeCompare(b.bank_name))
    .forEach(a => {
      const row = ws.addRow({
        b: a.bank_name,
        t: a.account_type,
        cur: a.currency,
        c: a.closing_balance,
        d: a.closing_date,
      })
      if (a.closing_balance !== null) row.getCell('c').numFmt = a.currency === 'USD' ? MONEY_FMT : PLAIN_MONEY_FMT
    })
}

export function buildOwnerFinancialsWorkbook(input: OwnerFinancialsExportInput): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Tony Durante LLC'
  wb.created = new Date()

  buildProfitAndLossSheet(wb, input)
  buildBalanceSheetSheet(wb, input)
  buildCategorySummarySheet(wb, input)
  buildTransactionsSheet(wb, input)
  buildAccountsSheet(wb, input)

  return wb
}
