/**
 * P&L Excel Generator — Extracted from bank-statements MCP tool
 *
 * Generates a comprehensive Profit & Loss Excel file with:
 * - Sheet 1: P&L Statement (revenue, COGS, expenses, net income, K-1, distributions)
 * - Sheet 2: Balance Sheet (assets, liabilities, equity)
 * - Sheet 3: Income Detail (every income transaction)
 * - Sheet 4: Expense Detail (every expense transaction)
 * - Sheet 5: Distribution Detail
 *
 * All amounts in dual currency (original + USD at IRS yearly average rate)
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

interface MemberInfo {
  name: string
  ownership_pct: number
}

interface AccountContext {
  companyName: string
  driveFolderId: string
  members: MemberInfo[]
}

interface PnlResult {
  buffer: Buffer
  fileName: string
  summary: string
  netIncome: number
  totalRevenue: number
  totalExpenses: number
  uncategorizedCount: number
}

/** Get IRS exchange rate for a currency/year */
async function getIrsRate(currency: string, taxYear: number): Promise<number> {
  if (currency === "USD") return 1
  const { data } = await supabaseAdmin
    .from("irs_exchange_rates")
    .select("rate_to_usd")
    .eq("tax_year", taxYear)
    .eq("currency", currency)
    .single()
  return data?.rate_to_usd || 1
}

/** Get account context: company name, drive folder, members */
async function getAccountContext(accountId: string): Promise<AccountContext> {
  const { data: account } = await supabaseAdmin
    .from("accounts")
    .select("company_name, drive_folder_id")
    .eq("id", accountId)
    .single()

  const { data: links } = await supabaseAdmin
    .from("account_contacts")
    .select("contact_id, role, ownership_pct, contacts(first_name, last_name)")
    .eq("account_id", accountId)

  const contactLinks = ((links || []) as unknown) as Array<{
    contact_id: string; role: string; ownership_pct: number | null;
    contacts: { first_name: string; last_name: string } | null
  }>

  const totalMembers = contactLinks.length || 1
  const members = contactLinks
    .filter(l => l.contacts)
    .map(l => ({
      name: `${l.contacts!.first_name} ${l.contacts!.last_name}`.trim(),
      ownership_pct: l.ownership_pct ?? (100 / totalMembers),
    }))

  return {
    companyName: account?.company_name || "Unknown",
    driveFolderId: account?.drive_folder_id || "",
    members,
  }
}

/**
 * Generate P&L Excel from bank_transactions table.
 * Returns the Excel buffer + summary text.
 */
export async function generatePnlExcel(
  accountId: string,
  taxYear: number,
): Promise<PnlResult> {
  const ctx = await getAccountContext(accountId)

  // Get transactions
  const { data: transactions, error } = await supabaseAdmin
    .from("bank_transactions")
    .select("*")
    .eq("account_id", accountId)
    .eq("tax_year", taxYear)
    .order("transaction_date", { ascending: true })

  if (error) throw new Error(error.message)
  if (!transactions || transactions.length === 0) {
    throw new Error("No transactions found. Run bank_statement_process first.")
  }

  // Get IRS rates
  const currencies = Array.from(new Set(transactions.map(t => t.currency)))
  const rates: Record<string, number> = {}
  for (const curr of currencies) {
    rates[curr] = await getIrsRate(curr, taxYear)
  }

  const toUSD = (amount: number, currency: string) => {
    const rate = rates[currency] || 1
    return rate === 1 ? amount : amount / rate
  }

  // Calculate P&L categories
  const income = transactions.filter(t => t.category === "income")
  const cogs = transactions.filter(t => t.category === "cogs")
  const expenses = transactions.filter(t => ["expense", "fee", "refund"].includes(t.category))
  const distributions = transactions.filter(t => t.category === "distribution")
  const uncategorized = transactions.filter(t => t.category === "uncategorized")

  const totalIncome = income.reduce((s, t) => s + Number(t.amount), 0)
  const totalCogs = cogs.reduce((s, t) => s + Math.abs(Number(t.amount)), 0)
  const grossProfit = totalIncome - totalCogs
  const totalExpenses = expenses.reduce((s, t) => s + Math.abs(Number(t.amount)), 0)
  const netIncome = grossProfit - totalExpenses
  const totalDistributions = distributions.reduce((s, t) => s + Math.abs(Number(t.amount)), 0)

  // Primary currency
  const currencyCounts = transactions.reduce((acc, t) => {
    acc[t.currency] = (acc[t.currency] || 0) + 1
    return acc
  }, {} as Record<string, number>)
  const primaryCurrency = Object.entries(currencyCounts).sort((a, b) => (b[1] as number) - (a[1] as number))[0]?.[0] || "USD"
  const irsRate = rates[primaryCurrency]

  // Year-end balances
  const accountBalances: Record<string, number> = {}
  for (const tx of transactions) {
    const key = `${tx.bank_name} ${tx.account_type}`
    if (tx.balance_after !== null) accountBalances[key] = Number(tx.balance_after)
  }

  // Generate Excel
  const ExcelJS = (await import("exceljs")).default
  const workbook = new ExcelJS.Workbook()

  // Helper
  const addRow = (sheet: import("exceljs").Worksheet, label: string, amount: number, bold = false, indent = 0) => {
    const prefix = "  ".repeat(indent)
    const row = sheet.addRow({ label: `${prefix}${label}`, original: amount, usd: toUSD(amount, primaryCurrency) })
    if (bold) row.font = { bold: true }
    row.getCell("original").numFmt = "#,##0.00"
    row.getCell("usd").numFmt = "$#,##0.00"
    return row
  }

  // ── Sheet 1: P&L Statement ──
  const plSheet = workbook.addWorksheet("P&L Statement")
  plSheet.columns = [
    { header: "", key: "label", width: 40 },
    { header: primaryCurrency, key: "original", width: 18 },
    { header: "USD", key: "usd", width: 18 },
  ]
  plSheet.getRow(1).font = { bold: true }

  plSheet.addRow({ label: ctx.companyName }).font = { bold: true, size: 14 }
  plSheet.addRow({ label: `Profit & Loss Statement -- Tax Year ${taxYear}` }).font = { bold: true }
  plSheet.addRow({ label: `IRS Exchange Rate: 1 ${primaryCurrency} / ${irsRate} = USD` })
  plSheet.addRow({})

  // Revenue
  addRow(plSheet, "REVENUE", 0, true)
  const incomeBySubcat: Record<string, number> = {}
  for (const t of income) {
    const sub = t.subcategory || "other"
    incomeBySubcat[sub] = (incomeBySubcat[sub] || 0) + Number(t.amount)
  }
  for (const [sub, amt] of Object.entries(incomeBySubcat)) addRow(plSheet, sub.replace(/_/g, " "), amt, false, 1)
  addRow(plSheet, "Total Revenue", totalIncome, true)
  plSheet.addRow({})

  // COGS
  if (cogs.length > 0) {
    addRow(plSheet, "COST OF SERVICES", 0, true)
    const cogsBySubcat: Record<string, number> = {}
    for (const t of cogs) { cogsBySubcat[t.subcategory || "other"] = (cogsBySubcat[t.subcategory || "other"] || 0) + Math.abs(Number(t.amount)) }
    for (const [sub, amt] of Object.entries(cogsBySubcat)) addRow(plSheet, sub.replace(/_/g, " "), -amt, false, 1)
    addRow(plSheet, "Total COGS", -totalCogs, true)
    plSheet.addRow({})
  }

  addRow(plSheet, "GROSS PROFIT", grossProfit, true)
  plSheet.addRow({})

  // Expenses
  addRow(plSheet, "OPERATING EXPENSES", 0, true)
  const expBySubcat: Record<string, number> = {}
  for (const t of expenses) { expBySubcat[t.subcategory || "other"] = (expBySubcat[t.subcategory || "other"] || 0) + Math.abs(Number(t.amount)) }
  for (const [sub, amt] of Object.entries(expBySubcat)) addRow(plSheet, sub.replace(/_/g, " "), -amt, false, 1)
  addRow(plSheet, "Total Operating Expenses", -totalExpenses, true)
  plSheet.addRow({})

  addRow(plSheet, "NET INCOME", netIncome, true)
  plSheet.addRow({})

  // K-1 Allocation
  addRow(plSheet, "K-1 ALLOCATION", 0, true)
  for (const member of ctx.members) addRow(plSheet, `${member.name} (${member.ownership_pct}%)`, netIncome * member.ownership_pct / 100, false, 1)
  plSheet.addRow({})

  // Distributions
  addRow(plSheet, "DISTRIBUTIONS", 0, true)
  const distByMember: Record<string, number> = {}
  for (const t of distributions) { distByMember[t.counterparty || "Unknown"] = (distByMember[t.counterparty || "Unknown"] || 0) + Math.abs(Number(t.amount)) }
  for (const [name, amt] of Object.entries(distByMember)) addRow(plSheet, name, -amt, false, 1)
  addRow(plSheet, "Total Distributions", -totalDistributions, true)

  // ── Sheet 2: Balance Sheet ──
  const bsSheet = workbook.addWorksheet("Balance Sheet")
  bsSheet.columns = [
    { header: "", key: "label", width: 40 },
    { header: primaryCurrency, key: "original", width: 18 },
    { header: "USD", key: "usd", width: 18 },
  ]
  bsSheet.getRow(1).font = { bold: true }
  bsSheet.addRow({ label: `${ctx.companyName} -- Balance Sheet as of 12/31/${taxYear}` }).font = { bold: true, size: 14 }
  bsSheet.addRow({})

  let totalAssets = 0
  addRow(bsSheet, "ASSETS", 0, true)
  for (const [acct, bal] of Object.entries(accountBalances)) { addRow(bsSheet, `Cash -- ${acct}`, bal, false, 1); totalAssets += bal }
  addRow(bsSheet, "Total Assets", totalAssets, true)
  bsSheet.addRow({})
  addRow(bsSheet, "LIABILITIES", 0, true)
  addRow(bsSheet, "Total Liabilities", 0, true)
  bsSheet.addRow({})

  const equity = totalAssets
  addRow(bsSheet, "PARTNERS' EQUITY", 0, true)
  addRow(bsSheet, "Net Income", netIncome, false, 1)
  addRow(bsSheet, "Less: Distributions", -totalDistributions, false, 1)
  const fxAdj = equity - netIncome + totalDistributions
  if (Math.abs(fxAdj) > 0.01) addRow(bsSheet, "Beginning Capital + FX Adjustment", fxAdj, false, 1)
  addRow(bsSheet, "Total Partners' Equity", equity, true)

  // ── Sheet 3: Income Detail ──
  const incSheet = workbook.addWorksheet("Income Detail")
  incSheet.columns = [
    { header: "Date", key: "date", width: 12 }, { header: "Description", key: "desc", width: 45 },
    { header: "Counterparty", key: "cp", width: 25 }, { header: "Subcategory", key: "sub", width: 18 },
    { header: primaryCurrency, key: "original", width: 15 }, { header: "USD", key: "usd", width: 15 },
    { header: "Related Party", key: "rp", width: 12 }, { header: "Reference", key: "ref", width: 20 },
  ]
  incSheet.getRow(1).font = { bold: true }
  for (const t of income) {
    const row = incSheet.addRow({ date: t.transaction_date, desc: t.description, cp: t.counterparty, sub: t.subcategory, original: Number(t.amount), usd: toUSD(Number(t.amount), t.currency), rp: t.is_related_party ? "Yes" : "", ref: t.transaction_ref })
    row.getCell("original").numFmt = "#,##0.00"; row.getCell("usd").numFmt = "$#,##0.00"
  }

  // ── Sheet 4: Expense Detail ──
  const expSheet = workbook.addWorksheet("Expense Detail")
  expSheet.columns = [
    { header: "Date", key: "date", width: 12 }, { header: "Description", key: "desc", width: 45 },
    { header: "Counterparty", key: "cp", width: 25 }, { header: "Category", key: "cat", width: 15 },
    { header: "Subcategory", key: "sub", width: 18 }, { header: primaryCurrency, key: "original", width: 15 },
    { header: "USD", key: "usd", width: 15 }, { header: "Related Party", key: "rp", width: 12 },
    { header: "Reference", key: "ref", width: 20 },
  ]
  expSheet.getRow(1).font = { bold: true }
  for (const t of [...cogs, ...expenses]) {
    const amt = Number(t.amount)
    const row = expSheet.addRow({ date: t.transaction_date, desc: t.description, cp: t.counterparty, cat: t.category, sub: t.subcategory, original: amt, usd: toUSD(amt, t.currency), rp: t.is_related_party ? "Yes" : "", ref: t.transaction_ref })
    row.getCell("original").numFmt = "#,##0.00"; row.getCell("usd").numFmt = "$#,##0.00"
  }

  // ── Sheet 5: Distributions ──
  const distSheet = workbook.addWorksheet("Distributions")
  distSheet.columns = [
    { header: "Date", key: "date", width: 12 }, { header: "Member", key: "member", width: 30 },
    { header: "Description", key: "desc", width: 40 }, { header: primaryCurrency, key: "original", width: 15 },
    { header: "USD", key: "usd", width: 15 }, { header: "Reference", key: "ref", width: 20 },
  ]
  distSheet.getRow(1).font = { bold: true }
  for (const t of distributions) {
    const amt = Number(t.amount)
    const row = distSheet.addRow({ date: t.transaction_date, member: t.counterparty, desc: t.description, original: amt, usd: toUSD(amt, t.currency), ref: t.transaction_ref })
    row.getCell("original").numFmt = "#,##0.00"; row.getCell("usd").numFmt = "$#,##0.00"
  }

  // Write buffer
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer())
  const fileName = `${ctx.companyName} - PnL ${taxYear}.xlsx`

  const summary = [
    `Revenue: ${primaryCurrency} ${totalIncome.toFixed(2)} ($${toUSD(totalIncome, primaryCurrency).toFixed(2)})`,
    `Expenses: ${primaryCurrency} ${totalExpenses.toFixed(2)} ($${toUSD(totalExpenses, primaryCurrency).toFixed(2)})`,
    `Net Income: ${primaryCurrency} ${netIncome.toFixed(2)} ($${toUSD(netIncome, primaryCurrency).toFixed(2)})`,
    uncategorized.length > 0 ? `${uncategorized.length} uncategorized transactions` : "",
  ].filter(Boolean).join(". ")

  return { buffer, fileName, summary, netIncome, totalRevenue: totalIncome, totalExpenses, uncategorizedCount: uncategorized.length }
}
