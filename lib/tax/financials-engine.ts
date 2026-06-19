/**
 * Financials draft engine (Slice 7, master plan §4) — PURE.
 *
 * Takes the year's categorized transactions + the resolved ownership + the
 * prior-return record and produces the FinancialDraft: P&L totals (via the
 * shared computePnlTotals — F1/F2/F3 semantics), the per-member capital
 * roll-forward (M-2), the cash-basis balance sheet, and every number the six
 * verification gates need. No I/O here — the orchestration layer loads data
 * and persists results.
 *
 * Cash-basis v1 decisions (plan §4 + §13 A5):
 * - Balance sheet books CASH + CAPITAL (assets = cash; liabilities = 0 unless
 *   a later version adds client questions for non-cash items).
 * - Beginning cash comes from the prior return's Schedule L ending cash
 *   (validated extractions only); first-year/never-filed start at 0.
 * - Per-bank beginning balances are derived from statement balance columns
 *   where present (first row: balance_after − amount) — used by gate 1.
 * - Contributions/distributions are attributed to members by counterparty
 *   name match; unattributed amounts are reported (staff/client question),
 *   and for the roll-forward they are spread by ownership % so the M-2 still
 *   ties while the draft FLAGS the attribution gap.
 */

import { computePnlTotals } from "@/lib/pnl-generator"
import { sameName, type ResolvedMember } from "./ownership-resolution"
import type { PriorReturnCaseRecord } from "./prior-return-case"
import { toUsd, type FxRates } from "./fx"

export interface DraftTransaction {
  id: string
  transaction_date: string
  description: string
  counterparty: string | null
  amount: number
  currency: string
  category: string
  subcategory: string | null
  bank_name: string
  account_type: string | null
  balance_after: number | null
}

export interface MemberCapital {
  name: string
  pct: number
  beginning_capital: number
  contributions: number
  distributions: number
  income_share: number
  ending_capital: number
}

export interface BankCashPosition {
  bank_key: string
  /** Derived from the first balance-bearing row (balance_after − amount); null when the CSV has no balance column. */
  derived_beginning: number | null
  /** Last balance_after seen; null when the CSV has no balance column. */
  reported_ending: number | null
  net_movement: number
}

export interface FinancialDraft {
  tax_year: number
  pnl: ReturnType<typeof computePnlTotals>
  members: MemberCapital[]
  banks: BankCashPosition[]
  /** The current year's beginning cash. Prefers the prior return's Schedule L
   *  ending cash; when there is no validated prior, falls back to the bank
   *  statements' opening balances (only when EVERY account carries a running
   *  balance and there are members to hold the opening equity). Null otherwise. */
  beginning_cash: number | null
  /** Where beginning_cash came from — drives the UI note + gate wording. */
  beginning_cash_source: "prior_return" | "statements" | null
  beginning_capital_total: number
  ending_cash: number
  /** v1: assets = cash. */
  total_assets: number
  total_liabilities: number
  ending_capital_total: number
  /** Contribution/distribution amounts that matched no member by name — needs staff/client resolution. */
  unattributed: { contributions: number; distributions: number }
  notes: string[]
}

export interface BuildDraftInput {
  taxYear: number
  transactions: DraftTransaction[]
  /** From resolveOwnership — only members with a pct take part in allocation. */
  members: ResolvedMember[]
  priorReturn: PriorReturnCaseRecord | null
  /** "Default + flag exceptions" policy: treat remaining uncategorized rows by
   *  sign (outflow → business expense, inflow → income) so the P&L is complete
   *  and gate 6 is not blocked; the owner flags only the exceptions. Portal tax
   *  review turns this ON; staff/Excel paths leave it OFF. */
  defaultUncategorizedBySign?: boolean
  /** IRS yearly-average rates (foreign units per USD) for converting
   *  foreign-currency amounts to USD (Phase 2). Omit for all-USD datasets. */
  fxRates?: FxRates
}

/** Match a counterparty/description to a member by name. Exported for tests. */
export function attributeToMember(text: string | null, members: ResolvedMember[]): ResolvedMember | null {
  if (!text) return null
  for (const m of members) {
    if (sameName(text, m.name)) return m
    // counterparty often embeds the name in extra text ("Wire to Sofia Marinoni — distribution")
    const tokens = m.name.toLowerCase().split(/\s+/).filter(t => t.length > 2)
    if (tokens.length >= 2 && tokens.every(t => text.toLowerCase().includes(t))) return m
  }
  return null
}

/** Beginning cash from a validated prior return; null when there is none. */
export function priorEndingCash(prior: PriorReturnCaseRecord | null): number | null {
  if (!prior) return null
  if (prior.case === "filed_elsewhere" && prior.status === "validated") {
    return prior.extracted.schedule_l?.ending.cash ?? null
  }
  return null // first_year / never_filed start at 0 by design; quarantined/on_file handled by orchestration
}

/** Prior per-member beginning capital from validated K-1s (matched by name). */
function priorBeginningCapital(prior: PriorReturnCaseRecord | null, memberName: string): number {
  if (prior && prior.case === "filed_elsewhere" && prior.status === "validated") {
    const k1 = prior.extracted.k1s.find(k => sameName(k.partner_name, memberName))
    if (k1?.ending_capital !== null && k1?.ending_capital !== undefined) return k1.ending_capital
  }
  return 0
}

export function buildFinancialDraft(input: BuildDraftInput): FinancialDraft {
  const { taxYear, transactions: rawTransactions, members, priorReturn, fxRates } = input
  const notes: string[] = []

  // ── Phase 2: normalize every amount + running balance to USD ──
  // A foreign-currency row is converted by ITS OWN currency's IRS yearly-average
  // rate (USD = amount / rate). USD / empty currency pass through unchanged. A
  // non-USD row with no rate on file is left as-is and FLAGGED, so it never
  // silently counts 1:1. Everything downstream (P&L, banks, balance sheet) then
  // works in USD. Single-currency USD accounts are unaffected.
  const missingRateCurrencies = new Set<string>()
  const transactions: DraftTransaction[] = !fxRates ? rawTransactions : rawTransactions.map(t => {
    const conv = toUsd(Number(t.amount), t.currency, fxRates)
    if (conv.missingRate) missingRateCurrencies.add((t.currency ?? "").trim().toUpperCase())
    const balance_after = t.balance_after === null || t.balance_after === undefined
      ? t.balance_after
      : toUsd(Number(t.balance_after), t.currency, fxRates).usd
    return { ...t, amount: conv.usd, balance_after }
  })
  if (missingRateCurrencies.size > 0) {
    notes.push(`No IRS yearly-average exchange rate on file for ${Array.from(missingRateCurrencies).sort().join(", ")} (${taxYear}) — those amounts are shown unconverted; add the rate so the P&L is fully in USD.`)
  }

  const pnl = computePnlTotals(transactions, { defaultUncategorizedBySign: input.defaultUncategorizedBySign })

  // ── Per-bank cash positions (gate 1 inputs) ──
  const bankKeys = Array.from(new Set(transactions.map(t => `${t.bank_name} ${t.account_type ?? "Checking"}`)))
  const banks: BankCashPosition[] = bankKeys.map(key => {
    const rows = transactions
      .filter(t => `${t.bank_name} ${t.account_type ?? "Checking"}` === key)
      .sort((a, b) => a.transaction_date.localeCompare(b.transaction_date))
    const firstWithBalance = rows.find(r => r.balance_after !== null)
    const lastWithBalance = [...rows].reverse().find(r => r.balance_after !== null)
    return {
      bank_key: key,
      derived_beginning: firstWithBalance ? Number(firstWithBalance.balance_after) - Number(firstWithBalance.amount) : null,
      reported_ending: lastWithBalance ? Number(lastWithBalance.balance_after) : null,
      net_movement: rows.reduce((s, r) => s + Number(r.amount), 0),
    }
  })

  // ── Capital roll-forward per member ──
  const allocatable = members.filter(m => m.pct !== null) as Array<ResolvedMember & { pct: number }>

  // ── Beginning cash source (prior return → statements → none) ──
  // Prior return wins (year-over-year tie-out). With no validated prior, fall
  // back to the statements' opening balances — but ONLY when every account
  // carries a running balance (a partial figure would mislead) AND there are
  // members to hold the matching opening equity (so the balance sheet still
  // ties: assets = equity). Otherwise leave it blank for staff to resolve.
  const priorCash = priorEndingCash(priorReturn)
  const allBanksHaveOpening = banks.length > 0 && banks.every(b => b.derived_beginning !== null)
  const statementOpening = allBanksHaveOpening ? banks.reduce((s, b) => s + (b.derived_beginning as number), 0) : null
  const usingStatementOpening = priorCash === null && statementOpening !== null && allocatable.length > 0

  const contribTxs = transactions.filter(t => t.category === "contribution")
  const distTxs = transactions.filter(t => t.category === "distribution")

  const byMember = new Map<string, { contributions: number; distributions: number }>()
  for (const m of allocatable) byMember.set(m.name, { contributions: 0, distributions: 0 })
  let unattributedContrib = 0
  let unattributedDist = 0

  for (const t of contribTxs) {
    const m = attributeToMember(t.counterparty, allocatable) ?? attributeToMember(t.description, allocatable)
    if (m) byMember.get(m.name)!.contributions += Number(t.amount)
    else unattributedContrib += Number(t.amount)
  }
  for (const t of distTxs) {
    const m = attributeToMember(t.counterparty, allocatable) ?? attributeToMember(t.description, allocatable)
    if (m) byMember.get(m.name)!.distributions += Math.abs(Number(t.amount))
    else unattributedDist += Math.abs(Number(t.amount))
  }
  if (unattributedContrib !== 0 || unattributedDist !== 0) {
    notes.push(
      `Owner movements not matched to a member by name (spread by ownership % so totals tie — confirm with the client): ` +
      `contributions ${unattributedContrib.toFixed(2)}, distributions ${unattributedDist.toFixed(2)}.`,
    )
  }

  const memberCapital: MemberCapital[] = allocatable.map(m => {
    const own = byMember.get(m.name)!
    const share = m.pct / 100
    const contributions = own.contributions + unattributedContrib * share
    const distributions = own.distributions + unattributedDist * share
    // No validated prior → seed opening capital from the statements' opening cash
    // (by ownership %) so the balance sheet ties; else use the prior K-1 figure.
    const beginning = usingStatementOpening ? statementOpening! * share : priorBeginningCapital(priorReturn, m.name)
    const incomeShare = pnl.netIncome * share
    return {
      name: m.name,
      pct: m.pct,
      beginning_capital: beginning,
      contributions,
      distributions,
      income_share: incomeShare,
      ending_capital: beginning + contributions + incomeShare - distributions,
    }
  })

  // ── Balance sheet (cash basis v1) ──
  const beginningCash = priorCash ?? (usingStatementOpening ? statementOpening : null)
  const beginningCashSource: FinancialDraft["beginning_cash_source"] =
    priorCash !== null ? "prior_return" : (usingStatementOpening ? "statements" : null)
  const startCash = beginningCash ?? 0
  if (usingStatementOpening) {
    notes.push(`Beginning cash taken from your bank statements' opening balances (${statementOpening!.toFixed(2)}) — no prior-year return on file. Opening equity seeded from the same figure so the balance sheet ties; staff confirm during review.`)
  } else if (beginningCash === null && priorReturn && priorReturn.case === "filed_elsewhere") {
    notes.push("Prior return is not validated — beginning cash assumed 0 until staff resolve it (gate 2 will not pass).")
  }
  const netMovement = transactions.reduce((s, t) => s + Number(t.amount), 0)
  const endingCash = startCash + netMovement
  const beginningCapitalTotal = memberCapital.reduce((s, m) => s + m.beginning_capital, 0)
  const endingCapitalTotal = memberCapital.reduce((s, m) => s + m.ending_capital, 0)

  return {
    tax_year: taxYear,
    pnl,
    members: memberCapital,
    banks,
    beginning_cash: beginningCash,
    beginning_cash_source: beginningCashSource,
    beginning_capital_total: beginningCapitalTotal,
    ending_cash: endingCash,
    total_assets: endingCash,
    total_liabilities: 0,
    ending_capital_total: endingCapitalTotal,
    unattributed: { contributions: unattributedContrib, distributions: unattributedDist },
    notes,
  }
}
