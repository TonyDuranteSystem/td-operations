/**
 * P&L pure math helpers — currency rates and category totals.
 *
 * This file used to also build the P&L Excel/CSV workbook end to end, but
 * that path was superseded 2026-07-01 by the shared financials engine
 * (lib/tax/financials-orchestration.ts::buildFinancialsWorkbookForAccount) —
 * see lib/tax/financials-excel.ts for the story. The workbook builder and its
 * own account/member lookup (getAccountContext) were deleted 2026-08-19: they
 * had no callers left anywhere in the app, and that lookup carried the same
 * "null null" defect fixed the same day in bank-statements.ts's copy — dead
 * code that was also a landmine for anyone who copied it as a working
 * example. getIrsRate and computePnlTotals below are still live-imported.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

/** Get IRS exchange rate for a currency/year */
export async function getIrsRate(currency: string, taxYear: number): Promise<number> {
  if (currency === "USD") return 1
  const { data } = await supabaseAdmin
    .from("irs_exchange_rates")
    .select("rate_to_usd")
    .eq("tax_year", taxYear)
    .eq("currency", currency)
    .single()
  return data?.rate_to_usd || 1
}

/** Compute P&L totals from a set of transactions (reusable for current + prior year) */
export function computePnlTotals(
  txs: Array<{ category: string; amount: number | string }>,
  opts: { defaultUncategorizedBySign?: boolean } = {},
) {
  const income = txs.filter(t => t.category === "income")
  const cogs = txs.filter(t => t.category === "cogs")
  const expenses = txs.filter(t => ["expense", "fee"].includes(t.category))
  const refunds = txs.filter(t => t.category === "refund")
  const distributions = txs.filter(t => t.category === "distribution")
  const contributions = txs.filter(t => t.category === "contribution")
  const uncategorized = txs.filter(t => t.category === "uncategorized")

  // "Default + flag exceptions" policy (portal tax review, 2026-06-17). When ON,
  // any still-uncategorized transaction is treated by SIGN — an outflow
  // (amount < 0) as a business EXPENSE, an inflow (amount > 0) as INCOME — so the
  // P&L is complete and gate 6 (uncategorized == 0) is not blocked. The owner
  // only FLAGS the exceptions (e.g. personal spend → distribution); a flag
  // persists as a real category and therefore leaves the `uncategorized` bucket.
  // OFF by default so the staff P&L tools / external P&L are byte-identical.
  const uncatIncome = opts.defaultUncategorizedBySign ? uncategorized.filter(t => Number(t.amount) > 0) : []
  const uncatExpense = opts.defaultUncategorizedBySign ? uncategorized.filter(t => Number(t.amount) < 0) : []

  const totalIncome = income.reduce((s, t) => s + Number(t.amount), 0)
    + uncatIncome.reduce((s, t) => s + Number(t.amount), 0)
  // F4 fix (2026-06-15): expenses and COGS are SIGNED, not Math.abs. Outflows
  // are negative, so the magnitude is the NEGATED signed sum. A positive amount
  // inside an expense/COGS category is money RETURNED (a vendor refund or a
  // reversal) and is a contra-expense — it must REDUCE the total, exactly as a
  // sales return reduces net revenue. The old Math.abs() flipped a returned
  // +$X into +$X of spending, double-counting it (Uxio: 3 Aurora reversals
  // totalling +$9,006 overstated expenses by $18,012 and understated net income
  // by the same). Contra-expense treatment per QuickBooks / standard accounting.
  const totalCogs = -cogs.reduce((s, t) => s + Number(t.amount), 0)
  const grossProfit = totalIncome - totalCogs
  // Refunds in the dedicated `refund` category are SIGNED too: a refund received
  // (inflow, amount > 0) REDUCES expenses; a refund paid out (outflow) increases.
  const totalExpenses =
    -expenses.reduce((s, t) => s + Number(t.amount), 0) +
    refunds.reduce((s, t) => s - Number(t.amount), 0) +
    -uncatExpense.reduce((s, t) => s + Number(t.amount), 0)
  const netIncome = grossProfit - totalExpenses
  const totalDistributions = distributions.reduce((s, t) => s + Math.abs(Number(t.amount)), 0)
  // F3 fix: contributions (owner money in) are equity, never revenue.
  // Tracked separately for the capital-account roll-forward.
  const totalContributions = contributions.reduce((s, t) => s + Number(t.amount), 0)
  // F2 visibility: the document must SHOW what its totals exclude. Under the
  // default-by-sign policy nothing is left pending (every uncategorized row is
  // folded into income/expenses above), so the pending count is 0.
  const uncategorizedCount = opts.defaultUncategorizedBySign ? 0 : uncategorized.length
  const uncategorizedTotal = opts.defaultUncategorizedBySign ? 0 : uncategorized.reduce((s, t) => s + Number(t.amount), 0)

  // Folded-visibility fields (2026-07-02, B&P $594k incident): under the by-sign
  // policy the totals LOOK complete (uncategorizedCount is forced to 0 for gate 6)
  // while unclassified money is silently inside income/expenses. These additive
  // fields expose what was folded so a surface can WARN instead of pretending
  // completeness. Zero when folding is off (nothing was folded — the rows sit in
  // the visible uncategorized bucket instead).
  const foldedUncategorizedCount = opts.defaultUncategorizedBySign ? uncategorized.length : 0
  const foldedUncategorizedIncome = opts.defaultUncategorizedBySign ? uncatIncome.reduce((s, t) => s + Number(t.amount), 0) : 0
  const foldedUncategorizedExpense = opts.defaultUncategorizedBySign ? -uncatExpense.reduce((s, t) => s + Number(t.amount), 0) : 0

  return {
    totalIncome, totalCogs, grossProfit, totalExpenses, netIncome,
    totalDistributions, totalContributions, uncategorizedCount, uncategorizedTotal,
    foldedUncategorizedCount, foldedUncategorizedIncome, foldedUncategorizedExpense,
  }
}
