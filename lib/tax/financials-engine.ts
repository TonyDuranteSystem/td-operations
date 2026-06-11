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
  /** Prior Schedule L ending cash — the current year's beginning cash. Null = no validated prior (first year / never filed / quarantined). */
  beginning_cash: number | null
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
  const { taxYear, transactions, members, priorReturn } = input
  const notes: string[] = []
  const pnl = computePnlTotals(transactions)

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
    const beginning = priorBeginningCapital(priorReturn, m.name)
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
  const beginningCash = priorEndingCash(priorReturn)
  const startCash = beginningCash ?? 0
  if (beginningCash === null && priorReturn && priorReturn.case === "filed_elsewhere") {
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
    beginning_capital_total: beginningCapitalTotal,
    ending_cash: endingCash,
    total_assets: endingCash,
    total_liabilities: 0,
    ending_capital_total: endingCapitalTotal,
    unattributed: { contributions: unattributedContrib, distributions: unattributedDist },
    notes,
  }
}
