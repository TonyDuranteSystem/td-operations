/**
 * Excel workbook for the tax-financials system — rendered FROM the engine draft
 * (`buildFinancialDraft`), so the downloaded file always matches the on-screen
 * P&L / Balance Sheet exactly.
 *
 * WHY (2026-07-01): the download route used to call `generatePnlExcel`, which
 * RE-DERIVED everything from raw transactions with a DIFFERENT policy than the
 * screen — no `defaultUncategorizedBySign`, and beginning balances from the
 * bank statements' opening balance instead of the prior return's Schedule L. So
 * the file the client/staff downloaded could disagree with the numbers they saw.
 * This builder takes the SAME `FinancialDraft` the screen uses — one engine,
 * one set of numbers.
 *
 * The summary sheets (P&L, Balance Sheet with the M-2 capital roll-forward, K-1)
 * come straight from the draft (USD, prior-return-aware). The three detail sheets
 * list the transactions themselves; their USD column uses the IRS yearly-average
 * rate (matching the P&L). (Balance-sheet year-end FX spot rate is tracked
 * refinement R1 — it will improve the draft AND this file together.)
 */

import type ExcelJSType from "exceljs"
import type { FinancialDraft } from "./financials-engine"

export interface FinancialsExcelInput {
  companyName: string
  taxYear: number
  draft: FinancialDraft
  /** Rows for the detail sheets (income / expense / distribution). */
  transactions: Array<{
    transaction_date: string
    description: string | null
    counterparty: string | null
    amount: number
    currency: string | null
    category: string | null
    subcategory: string | null
    bank_name: string | null
    account_type: string | null
    is_related_party?: boolean | null
    transaction_ref?: string | null
  }>
  /** IRS yearly-average rates (foreign units per USD) for the detail USD column. */
  rates: Record<string, number>
}

export interface FinancialsExcelResult {
  buffer: Buffer
  fileName: string
}

export async function buildFinancialsWorkbook(input: FinancialsExcelInput): Promise<FinancialsExcelResult> {
  const { companyName, taxYear, draft, transactions, rates } = input
  const toUSD = (amount: number, currency: string | null) => {
    const rate = rates[(currency ?? "USD")] || 1
    return rate === 1 ? amount : amount / rate
  }

  const ExcelJS = (await import("exceljs")).default
  const workbook = new ExcelJS.Workbook()

  const money = (row: ExcelJSType.Row, key: string) => { row.getCell(key).numFmt = "$#,##0.00" }
  const addRow = (sheet: ExcelJSType.Worksheet, label: string, usd: number, bold = false, indent = 0) => {
    const row = sheet.addRow({ label: `${"  ".repeat(indent)}${label}`, usd })
    if (bold) row.font = { bold: true }
    money(row, "usd")
    return row
  }

  // ── Sheet 1: P&L Statement (from the draft) ──
  const pl = workbook.addWorksheet("P&L Statement")
  pl.columns = [
    { header: "", key: "label", width: 44 },
    { header: "USD", key: "usd", width: 18 },
  ]
  pl.getRow(1).font = { bold: true }
  pl.addRow({ label: companyName }).font = { bold: true, size: 14 }
  pl.addRow({ label: `Profit & Loss Statement -- Tax Year ${taxYear}` }).font = { bold: true }
  pl.addRow({})

  addRow(pl, "Revenue", draft.pnl.totalIncome, true)
  if (draft.pnl.totalCogs !== 0) {
    addRow(pl, "Cost of Services", -draft.pnl.totalCogs, false, 1)
    addRow(pl, "Gross Profit", draft.pnl.grossProfit, true)
  }
  addRow(pl, "Operating Expenses", -draft.pnl.totalExpenses, false, 1)
  addRow(pl, "NET INCOME", draft.pnl.netIncome, true)
  pl.addRow({})

  addRow(pl, "K-1 ALLOCATION", 0, true)
  for (const m of draft.members) addRow(pl, `${m.name} (${m.pct}%)`, m.income_share, false, 1)
  pl.addRow({})

  addRow(pl, "DISTRIBUTIONS", 0, true)
  for (const m of draft.members) { if (m.distributions !== 0) addRow(pl, m.name, -m.distributions, false, 1) }
  addRow(pl, "Total Distributions", -draft.pnl.totalDistributions, true)

  if (draft.pnl.totalContributions !== 0) {
    pl.addRow({})
    addRow(pl, "CAPITAL CONTRIBUTIONS (equity — not revenue)", draft.pnl.totalContributions, true)
  }
  if (draft.pnl.uncategorizedCount > 0) {
    const warn = pl.addRow({ label: `⚠ ${draft.pnl.uncategorizedCount} UNCATEGORIZED transaction(s) (net ${draft.pnl.uncategorizedTotal.toFixed(2)}) EXCLUDED from totals — review before filing` })
    warn.font = { bold: true, color: { argb: "FFCC0000" } }
  }

  // ── Sheet 2: Balance Sheet (M-2 capital roll-forward — matches the screen) ──
  const bs = workbook.addWorksheet("Balance Sheet")
  bs.columns = [
    { header: "", key: "label", width: 44 },
    { header: "USD", key: "usd", width: 18 },
  ]
  bs.getRow(1).font = { bold: true }
  bs.addRow({ label: `${companyName} -- Balance Sheet as of 12/31/${taxYear}` }).font = { bold: true, size: 14 }
  bs.addRow({})

  addRow(bs, "ASSETS", 0, true)
  addRow(bs, "Cash", draft.total_assets, false, 1)
  addRow(bs, "Total Assets", draft.total_assets, true)
  bs.addRow({})
  addRow(bs, "LIABILITIES", 0, true)
  addRow(bs, "Total Liabilities", draft.total_liabilities, true)
  bs.addRow({})

  addRow(bs, "PARTNERS' EQUITY (Schedule M-2)", 0, true)
  const beginLabel = draft.beginning_cash_source === "prior_return"
    ? "Beginning Capital (from prior-year return)"
    : draft.beginning_cash_source === "statements"
      ? "Beginning Capital (from opening bank balances)"
      : "Beginning Capital"
  addRow(bs, beginLabel, draft.beginning_capital_total, false, 1)
  const totalContrib = draft.members.reduce((s, m) => s + m.contributions, 0)
  if (totalContrib !== 0) addRow(bs, "Capital Contributions", totalContrib, false, 1)
  addRow(bs, "Net Income", draft.pnl.netIncome, false, 1)
  addRow(bs, "Less: Distributions", -draft.pnl.totalDistributions, false, 1)
  addRow(bs, "Total Partners' Equity (ending capital)", draft.ending_capital_total, true)
  // Reconciling line (2026-07-02): uncategorized rows move cash (they're inside
  // ending_cash) but not equity (excluded from netIncome) — so the sheet is out
  // of balance by EXACTLY their net. Name the gap instead of leaving a mystery
  // CHECK failure.
  if (draft.pnl.uncategorizedCount > 0) {
    const recon = addRow(bs, `⚠ Unclassified cash movement (${draft.pnl.uncategorizedCount} uncategorized transactions — categorize to balance)`, draft.pnl.uncategorizedTotal, false, 1)
    recon.font = { bold: true, color: { argb: "FFCC0000" } }
  }
  const checkRow = addRow(bs, "CHECK: Assets − Liabilities − Equity", draft.total_assets - draft.total_liabilities - draft.ending_capital_total, true)
  if (Math.abs(draft.total_assets - draft.total_liabilities - draft.ending_capital_total) > 1) {
    checkRow.font = { bold: true, color: { argb: "FFCC0000" } }
  }
  bs.addRow({})

  // Per-member capital table (K-1 item L)
  const cap = workbook.addWorksheet("Capital Accounts (K-1 L)")
  cap.columns = [
    { header: "Member", key: "name", width: 30 },
    { header: "%", key: "pct", width: 8 },
    { header: "Beginning", key: "beg", width: 16 },
    { header: "Contributions", key: "con", width: 16 },
    { header: "Income", key: "inc", width: 16 },
    { header: "Distributions", key: "dist", width: 16 },
    { header: "Ending", key: "end", width: 16 },
  ]
  cap.getRow(1).font = { bold: true }
  for (const m of draft.members) {
    const row = cap.addRow({ name: m.name, pct: m.pct, beg: m.beginning_capital, con: m.contributions, inc: m.income_share, dist: -m.distributions, end: m.ending_capital })
    for (const k of ["beg", "con", "inc", "dist", "end"]) money(row, k)
  }

  // ── Detail sheets: Income / Expense / Distributions (from transactions) ──
  const incomeTx = transactions.filter(t => t.category === "income")
  const expenseTx = transactions.filter(t => ["cogs", "expense", "fee", "refund"].includes(t.category ?? ""))
  const distTx = transactions.filter(t => t.category === "distribution")

  const detail = (name: string, rows: typeof transactions, withCategory: boolean) => {
    const sheet = workbook.addWorksheet(name)
    sheet.columns = [
      { header: "Date", key: "date", width: 12 },
      { header: "Description", key: "desc", width: 44 },
      { header: "Counterparty", key: "cp", width: 24 },
      ...(withCategory ? [{ header: "Category", key: "cat", width: 14 }] : []),
      { header: "Subcategory", key: "sub", width: 18 },
      { header: "USD", key: "usd", width: 15 },
      { header: "Reference", key: "ref", width: 20 },
    ]
    sheet.getRow(1).font = { bold: true }
    for (const t of rows) {
      const row = sheet.addRow({ date: t.transaction_date, desc: t.description, cp: t.counterparty, cat: t.category, sub: t.subcategory, usd: toUSD(Number(t.amount), t.currency), ref: t.transaction_ref })
      money(row, "usd")
    }
  }
  detail("Income Detail", incomeTx, false)
  detail("Expense Detail", expenseTx, true)
  detail("Distributions", distTx, false)

  const buffer = Buffer.from(await workbook.xlsx.writeBuffer())
  const fileName = `${companyName} - PnL ${taxYear}.xlsx`
  return { buffer, fileName }
}
