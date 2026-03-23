/**
 * P&L Excel Generator — Extracted from bank-statements MCP tool
 *
 * Generates a comprehensive Profit & Loss Excel file with:
 * - Sheet 1: P&L Statement (revenue, COGS, expenses, net income, K-1, distributions)
 * - Sheet 2: Comparative Balance Sheet (prior year vs current year)
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

/** Compute P&L totals from a set of transactions (reusable for current + prior year) */
function computePnlTotals(txs: Array<{ category: string; amount: number | string }>) {
  const income = txs.filter(t => t.category === "income")
  const cogs = txs.filter(t => t.category === "cogs")
  const expenses = txs.filter(t => ["expense", "fee", "refund"].includes(t.category))
  const distributions = txs.filter(t => t.category === "distribution")

  const totalIncome = income.reduce((s, t) => s + Number(t.amount), 0)
  const totalCogs = cogs.reduce((s, t) => s + Math.abs(Number(t.amount)), 0)
  const grossProfit = totalIncome - totalCogs
  const totalExpenses = expenses.reduce((s, t) => s + Math.abs(Number(t.amount)), 0)
  const netIncome = grossProfit - totalExpenses
  const totalDistributions = distributions.reduce((s, t) => s + Math.abs(Number(t.amount)), 0)

  return { totalIncome, totalCogs, grossProfit, totalExpenses, netIncome, totalDistributions }
}

/** Compute year-end balances from transactions (last balance_after per bank account) */
function computeAccountBalances(txs: Array<{ bank_name: string; account_type: string | null; balance_after: number | null }>) {
  const balances: Record<string, number> = {}
  for (const tx of txs) {
    const key = `${tx.bank_name} ${tx.account_type || "Checking"}`
    if (tx.balance_after !== null) balances[key] = Number(tx.balance_after)
  }
  return balances
}

/**
 * Generate P&L Excel from bank_transactions table.
 * Returns the Excel buffer + summary text.
 * Sheet 2 is a Comparative Balance Sheet (prior year vs current year).
 */
export async function generatePnlExcel(
  accountId: string,
  taxYear: number,
): Promise<PnlResult> {
  const ctx = await getAccountContext(accountId)

  // Get current year transactions
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

  // Get prior year transactions (for comparative balance sheet)
  const { data: priorTransactions } = await supabaseAdmin
    .from("bank_transactions")
    .select("*")
    .eq("account_id", accountId)
    .eq("tax_year", taxYear - 1)
    .order("transaction_date", { ascending: true })

  const hasPriorYear = (priorTransactions?.length || 0) > 0

  // Get IRS rates for current year
  const currencies = Array.from(new Set(transactions.map(t => t.currency)))
  const rates: Record<string, number> = {}
  for (const curr of currencies) {
    rates[curr] = await getIrsRate(curr, taxYear)
  }

  // Get IRS rates for prior year (if data exists)
  const priorRates: Record<string, number> = {}
  if (hasPriorYear) {
    const priorCurrencies = Array.from(new Set(priorTransactions!.map(t => t.currency)))
    for (const curr of priorCurrencies) {
      priorRates[curr] = await getIrsRate(curr, taxYear - 1)
    }
  }

  const toUSD = (amount: number, currency: string) => {
    const rate = rates[currency] || 1
    return rate === 1 ? amount : amount / rate
  }
  const toPriorUSD = (amount: number, currency: string) => {
    const rate = priorRates[currency] || 1
    return rate === 1 ? amount : amount / rate
  }

  // Calculate P&L categories (current year)
  const income = transactions.filter(t => t.category === "income")
  const cogs = transactions.filter(t => t.category === "cogs")
  const expenses = transactions.filter(t => ["expense", "fee", "refund"].includes(t.category))
  const distributions = transactions.filter(t => t.category === "distribution")
  const uncategorized = transactions.filter(t => t.category === "uncategorized")

  const currentTotals = computePnlTotals(transactions)
  const { totalIncome, totalCogs, grossProfit, totalExpenses, netIncome, totalDistributions } = currentTotals

  // Prior year totals
  const priorTotals = hasPriorYear ? computePnlTotals(priorTransactions!) : null

  // Primary currency
  const currencyCounts = transactions.reduce((acc, t) => {
    acc[t.currency] = (acc[t.currency] || 0) + 1
    return acc
  }, {} as Record<string, number>)
  const primaryCurrency = Object.entries(currencyCounts).sort((a, b) => (b[1] as number) - (a[1] as number))[0]?.[0] || "USD"
  const irsRate = rates[primaryCurrency]

  // Year-end balances (current + prior)
  const accountBalances = computeAccountBalances(transactions)
  const priorAccountBalances = hasPriorYear ? computeAccountBalances(priorTransactions!) : {}

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

  // ── Sheet 2: Comparative Balance Sheet ──
  const bsSheet = workbook.addWorksheet("Balance Sheet")
  bsSheet.columns = [
    { header: "", key: "label", width: 40 },
    { header: `${taxYear - 1} ${primaryCurrency}`, key: "prior_orig", width: 18 },
    { header: `${taxYear - 1} USD`, key: "prior_usd", width: 18 },
    { header: `${taxYear} ${primaryCurrency}`, key: "curr_orig", width: 18 },
    { header: `${taxYear} USD`, key: "curr_usd", width: 18 },
  ]
  bsSheet.getRow(1).font = { bold: true }
  bsSheet.addRow({ label: `${ctx.companyName} -- Comparative Balance Sheet` }).font = { bold: true, size: 14 }
  bsSheet.addRow({ label: `As of 12/31/${taxYear - 1} vs 12/31/${taxYear}` }).font = { italic: true }
  if (!hasPriorYear) bsSheet.addRow({ label: `Note: No prior year (${taxYear - 1}) data available` }).font = { italic: true, color: { argb: "FF888888" } }
  bsSheet.addRow({})

  // Helper for comparative rows
  const addCompRow = (sheet: import("exceljs").Worksheet, label: string, priorAmt: number | null, currAmt: number, bold = false, indent = 0) => {
    const prefix = "  ".repeat(indent)
    const row = sheet.addRow({
      label: `${prefix}${label}`,
      prior_orig: priorAmt,
      prior_usd: priorAmt !== null ? toPriorUSD(priorAmt, primaryCurrency) : null,
      curr_orig: currAmt,
      curr_usd: toUSD(currAmt, primaryCurrency),
    })
    if (bold) row.font = { bold: true }
    for (const key of ["prior_orig", "prior_usd", "curr_orig", "curr_usd"]) {
      const cell = row.getCell(key)
      if (cell.value === null) cell.value = hasPriorYear ? 0 : "N/A"
      cell.numFmt = key.includes("usd") ? "$#,##0.00" : "#,##0.00"
    }
    return row
  }

  // ASSETS — current year balances
  let totalAssets = 0
  let priorTotalAssets = 0
  addCompRow(bsSheet, "ASSETS", null, 0, true)
  // Combine all account keys from both years
  const allAccountKeys = Array.from(new Set([...Object.keys(accountBalances), ...Object.keys(priorAccountBalances)]))
  for (const acct of allAccountKeys) {
    const currBal = accountBalances[acct] || 0
    const priorBal = priorAccountBalances[acct] || 0
    addCompRow(bsSheet, `Cash -- ${acct}`, hasPriorYear ? priorBal : null, currBal, false, 1)
    totalAssets += currBal
    priorTotalAssets += priorBal
  }
  addCompRow(bsSheet, "Total Assets", hasPriorYear ? priorTotalAssets : null, totalAssets, true)
  bsSheet.addRow({})

  addCompRow(bsSheet, "LIABILITIES", null, 0, true)
  addCompRow(bsSheet, "Total Liabilities", hasPriorYear ? 0 : null, 0, true)
  bsSheet.addRow({})

  // PARTNERS' EQUITY
  const equity = totalAssets
  const priorEquity = priorTotalAssets
  addCompRow(bsSheet, "PARTNERS' EQUITY", null, 0, true)
  addCompRow(bsSheet, "Net Income", hasPriorYear ? priorTotals!.netIncome : null, netIncome, false, 1)
  addCompRow(bsSheet, "Less: Distributions", hasPriorYear ? -priorTotals!.totalDistributions : null, -totalDistributions, false, 1)
  const fxAdj = equity - netIncome + totalDistributions
  const priorFxAdj = hasPriorYear ? priorEquity - priorTotals!.netIncome + priorTotals!.totalDistributions : 0
  if (Math.abs(fxAdj) > 0.01 || (hasPriorYear && Math.abs(priorFxAdj) > 0.01)) {
    addCompRow(bsSheet, "Beginning Capital + FX Adjustment", hasPriorYear ? priorFxAdj : null, fxAdj, false, 1)
  }
  addCompRow(bsSheet, "Total Partners' Equity", hasPriorYear ? priorEquity : null, equity, true)

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

/**
 * Generate CSV versions of P&L + Balance Sheet for India team.
 * Returns two CSV strings: pnl and balance_sheet.
 * All amounts in USD (converted from original currency using IRS rate).
 */
export async function generatePnlCsv(
  accountId: string,
  taxYear: number,
): Promise<{ pnlCsv: string; balanceSheetCsv: string; transactionsCsv: string; companyName: string }> {
  const ctx = await getAccountContext(accountId)

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

  const primaryCurrency = Object.entries(
    transactions.reduce((acc, t) => { acc[t.currency] = (acc[t.currency] || 0) + 1; return acc }, {} as Record<string, number>)
  ).sort((a, b) => (b[1] as number) - (a[1] as number))[0]?.[0] || "USD"
  const irsRate = rates[primaryCurrency]

  // Categorize
  const income = transactions.filter(t => t.category === "income")
  const cogs = transactions.filter(t => t.category === "cogs")
  const expenses = transactions.filter(t => ["expense", "fee", "refund"].includes(t.category))
  const distributions = transactions.filter(t => t.category === "distribution")

  const totalIncome = income.reduce((s, t) => s + Number(t.amount), 0)
  const totalCogs = cogs.reduce((s, t) => s + Math.abs(Number(t.amount)), 0)
  const grossProfit = totalIncome - totalCogs
  const totalExpenses = expenses.reduce((s, t) => s + Math.abs(Number(t.amount)), 0)
  const netIncome = grossProfit - totalExpenses
  const totalDistributions = distributions.reduce((s, t) => s + Math.abs(Number(t.amount)), 0)

  // Group expenses by subcategory
  const expBySubcat: Record<string, number> = {}
  for (const t of expenses) {
    const key = t.subcategory || t.category || "other"
    expBySubcat[key] = (expBySubcat[key] || 0) + Math.abs(Number(t.amount))
  }

  // ── P&L CSV ──
  const pnlLines = [
    `"${ctx.companyName} - Profit & Loss Statement ${taxYear}"`,
    `"Currency","${primaryCurrency}","IRS Rate","${irsRate}"`,
    `""`,
    `"Category","${primaryCurrency}","USD"`,
    `"Revenue","${totalIncome.toFixed(2)}","${toUSD(totalIncome, primaryCurrency).toFixed(2)}"`,
    `"Cost of Goods Sold","${totalCogs.toFixed(2)}","${toUSD(totalCogs, primaryCurrency).toFixed(2)}"`,
    `"Gross Profit","${grossProfit.toFixed(2)}","${toUSD(grossProfit, primaryCurrency).toFixed(2)}"`,
    `""`,
    `"Operating Expenses","",""`,
  ]

  // Add expense breakdown
  for (const [sub, amt] of Object.entries(expBySubcat).sort((a, b) => b[1] - a[1])) {
    pnlLines.push(`"  ${sub}","${amt.toFixed(2)}","${toUSD(amt, primaryCurrency).toFixed(2)}"`)
  }

  pnlLines.push(
    `"Total Operating Expenses","${totalExpenses.toFixed(2)}","${toUSD(totalExpenses, primaryCurrency).toFixed(2)}"`,
    `""`,
    `"Net Income","${netIncome.toFixed(2)}","${toUSD(netIncome, primaryCurrency).toFixed(2)}"`,
    `""`,
    `"Distributions","${totalDistributions.toFixed(2)}","${toUSD(totalDistributions, primaryCurrency).toFixed(2)}"`,
  )

  // K-1 allocation
  if (ctx.members.length > 0) {
    pnlLines.push(`""`, `"K-1 Allocation","",""`)
    for (const m of ctx.members) {
      const share = netIncome * (m.ownership_pct / 100)
      pnlLines.push(`"  ${m.name} (${m.ownership_pct}%)","${share.toFixed(2)}","${toUSD(share, primaryCurrency).toFixed(2)}"`)
    }
  }

  // ── Comparative Balance Sheet CSV ──
  const csvAccountBalances = computeAccountBalances(transactions)
  const totalCash = Object.values(csvAccountBalances).reduce((s, v) => s + v, 0)
  const csvTotalAssets = totalCash

  // Get prior year for CSV too
  const { data: csvPriorTx } = await supabaseAdmin
    .from("bank_transactions")
    .select("bank_name, account_type, balance_after, category, amount")
    .eq("account_id", accountId)
    .eq("tax_year", taxYear - 1)
    .order("transaction_date", { ascending: true })

  const csvHasPrior = (csvPriorTx?.length || 0) > 0
  const csvPriorBalances = csvHasPrior ? computeAccountBalances(csvPriorTx!) : {}
  const csvPriorTotals = csvHasPrior ? computePnlTotals(csvPriorTx!) : null
  const csvPriorTotalAssets = Object.values(csvPriorBalances).reduce((s, v) => s + v, 0)

  let csvPriorRate = 1
  if (csvHasPrior && primaryCurrency !== "USD") {
    csvPriorRate = await getIrsRate(primaryCurrency, taxYear - 1)
  }
  const toCsvPriorUSD = (amt: number) => csvPriorRate === 1 ? amt : amt / csvPriorRate

  const bsLines = [
    `"${ctx.companyName} - Comparative Balance Sheet"`,
    `"","${taxYear - 1}","","${taxYear}",""`,
    `"","${primaryCurrency}","USD","${primaryCurrency}","USD"`,
    `"ASSETS","","","",""`,
  ]

  const allCsvAccts = Array.from(new Set([...Object.keys(csvAccountBalances), ...Object.keys(csvPriorBalances)]))
  for (const acct of allCsvAccts) {
    const curr = csvAccountBalances[acct] || 0
    const prior = csvPriorBalances[acct] || 0
    bsLines.push(`"  ${acct}","${csvHasPrior ? prior.toFixed(2) : "N/A"}","${csvHasPrior ? toCsvPriorUSD(prior).toFixed(2) : "N/A"}","${curr.toFixed(2)}","${toUSD(curr, primaryCurrency).toFixed(2)}"`)
  }

  bsLines.push(
    `"Total Assets","${csvHasPrior ? csvPriorTotalAssets.toFixed(2) : "N/A"}","${csvHasPrior ? toCsvPriorUSD(csvPriorTotalAssets).toFixed(2) : "N/A"}","${csvTotalAssets.toFixed(2)}","${toUSD(csvTotalAssets, primaryCurrency).toFixed(2)}"`,
    `""`,
    `"EQUITY","","","",""`,
    `"Net Income","${csvHasPrior ? csvPriorTotals!.netIncome.toFixed(2) : "N/A"}","${csvHasPrior ? toCsvPriorUSD(csvPriorTotals!.netIncome).toFixed(2) : "N/A"}","${netIncome.toFixed(2)}","${toUSD(netIncome, primaryCurrency).toFixed(2)}"`,
    `"Total Equity","${csvHasPrior ? csvPriorTotalAssets.toFixed(2) : "N/A"}","${csvHasPrior ? toCsvPriorUSD(csvPriorTotalAssets).toFixed(2) : "N/A"}","${csvTotalAssets.toFixed(2)}","${toUSD(csvTotalAssets, primaryCurrency).toFixed(2)}"`,
  )

  // ── Transactions CSV (all transactions for India team) ──
  const txLines = [
    `"Date","Description","Counterparty","Category","Subcategory","${primaryCurrency}","USD","Related Party","Reference"`,
  ]
  for (const t of transactions) {
    const amt = Number(t.amount)
    txLines.push(
      `"${t.transaction_date}","${(t.description || "").replace(/"/g, '""')}","${(t.counterparty || "").replace(/"/g, '""')}","${t.category}","${t.subcategory || ""}","${amt.toFixed(2)}","${toUSD(amt, t.currency).toFixed(2)}","${t.is_related_party ? "Yes" : ""}","${t.transaction_ref || ""}"`
    )
  }

  return {
    pnlCsv: pnlLines.join("\n"),
    balanceSheetCsv: bsLines.join("\n"),
    transactionsCsv: txLines.join("\n"),
    companyName: ctx.companyName,
  }
}
