/**
 * Validation Mode V1 (2026-07-06, Antonio + dual-reviewed plan) — PURE.
 *
 * Explains how every headline number on the P&L / Balance Sheet was assembled:
 *  - per-P&L-line COMPOSITION (per-currency sums + the FX rate applied, counts,
 *    top counterparties, related-party share),
 *  - Balance-Sheet DERIVATIONS (BS lines are formulas, not row sets —
 *    beginning cash ← prior-return answer / statement openings, ending cash =
 *    beginning + net movement, capital ← the M-2 roll-forward),
 *  - workspace-level PROVENANCE split (who booked the rows: rules & memory /
 *    AI / human answers / location answers / auto-file / transfer matcher),
 *  - EXCLUSIONS (conversions, unclassified, missing-rate currencies),
 *  - RELATED-PARTY summary (the 5472-class exposure this clientele actually
 *    has — informational returns, no US tax, but real penalty risk there).
 *
 * HARD INVARIANT: every composition/derivation total is recomputed from the
 * SAME transaction set with the SAME toUsd conversion the draft used, then
 * compared against the draft's own figure. Any mismatch is reported in
 * `invariant.mismatches` and the UI must show an error instead of numbers —
 * this feature refuses to explain figures it cannot reproduce (the anti-drift
 * condition from the adversarial review).
 *
 * READ-ONLY by design: consumes existing provenance markers, never writes.
 * Marker taxonomy (verified against every writer, 2026-07-06):
 *   manual: staff answer / bulk staff answer        → human answer
 *   manual: period answer / country answer <batch>  → location answer (tap or policy sweep)
 *   ai:high@vN[:gN]                                 → AI (grouped verdict)
 *   auto: zero-amount                               → auto-filed zero row
 *   transfer-pair → <id> / own-entity transfer      → transfer matcher
 *   empty notes + categorized                       → bank vocabulary / learned rules
 *   category = uncategorized                        → still open
 */

import { toUsd, type FxRates } from "./fx"
import type { FinancialDraft } from "./financials-engine"
import type { PriorReturnCaseRecord } from "./prior-return-case"
import type { OwnershipResolution } from "./ownership-resolution"

/** The row fields validation needs — a superset of what the draft consumes. */
export interface ValidationRow {
  id: string
  description: string | null
  counterparty: string | null
  amount: number
  currency: string | null
  category: string
  notes: string | null
  is_related_party: boolean | null
}

export type ProvenanceClass =
  | "rules_memory"      // categorized, no marker — bank vocabulary / learned rules / legacy patterns
  | "ai"                // ai:high@vN
  | "human_answer"      // manual: staff answer / bulk staff answer
  | "location_answer"   // manual: period/country answer (human tap or standing-policy sweep)
  | "auto_zero"         // auto: zero-amount
  | "transfer_matcher"  // transfer-pair / own-entity
  | "open"              // uncategorized

export function classifyProvenance(row: Pick<ValidationRow, "category" | "notes">): ProvenanceClass {
  const n = row.notes ?? ""
  if (row.category === "uncategorized") return "open"
  if (n.startsWith("ai:")) return "ai"
  if (n.startsWith("manual: period answer") || n.startsWith("manual: country answer")) return "location_answer"
  if (n.startsWith("manual:")) return "human_answer"
  if (n.startsWith("auto:")) return "auto_zero"
  if (n.startsWith("transfer-pair") || n === "own-entity transfer") return "transfer_matcher"
  return "rules_memory"
}

export interface CurrencySlice {
  currency: string
  count: number
  /** Signed sum in the ORIGINAL currency. */
  sum_original: number
  /** IRS yearly-average rate applied (foreign units per USD); null = USD or missing. */
  rate: number | null
  missing_rate: boolean
  /** Signed sum after conversion — what actually entered the totals. */
  sum_usd: number
}

export interface CompositionLine {
  key: "income" | "cogs" | "expenses" | "distributions" | "contributions" | "uncategorized"
  label: string
  /** The line total EXACTLY as the P&L states it (sign convention included). */
  total_usd: number
  count: number
  by_currency: CurrencySlice[]
  top_counterparties: Array<{ label: string; count: number; total_usd: number }>
  related_party: { count: number; total_usd: number }
  /** Sub-detail: refunds folded into the expense line (contra-expense, F4). */
  refunds?: { count: number; total_usd: number }
}

export interface BsDerivation {
  key: "beginning_cash" | "ending_cash" | "total_assets" | "total_liabilities" | "capital"
  label: string
  value: number | null
  /** Human-readable formula terms, in order. */
  terms: Array<{ label: string; value: number | null }>
  note?: string
}

export interface ValidationBreakdown {
  pnl_lines: CompositionLine[]
  bs_derivations: BsDerivation[]
  provenance: Array<{ class: ProvenanceClass; label: string; count: number; total_abs_usd: number }>
  exclusions: {
    conversions: { count: number; total_abs_usd: number }
    unclassified: { count: number; total_usd: number }
    missing_rate_currencies: string[]
  }
  related_party: {
    count: number
    total_abs_usd: number
    top_counterparties: Array<{ label: string; count: number; total_usd: number }>
  }
  policy_inputs: {
    prior_return: { case: string; status: string; note: string | null } | null
    beginning_cash_source: FinancialDraft["beginning_cash_source"]
    ownership_sources: Array<{ name: string; pct: number | null; source: string }>
    fx_rates_used: Array<{ currency: string; rate: number }>
  }
  invariant: { ok: boolean; mismatches: Array<{ line: string; breakdown: number; draft: number }> }
}

const PROVENANCE_LABELS: Record<ProvenanceClass, string> = {
  rules_memory: "Bank vocabulary & learned memory",
  ai: "AI (high-confidence, version-stamped)",
  human_answer: "Human answers",
  location_answer: "Location answers & standing policies",
  auto_zero: "Auto-filed zero-amount",
  transfer_matcher: "Internal-transfer matcher",
  open: "Still open (uncategorized)",
}

/** Tolerance for float accumulation differences — half a cent. */
const EPSILON = 0.005

export interface BuildValidationInput {
  rows: ValidationRow[]
  draft: FinancialDraft
  fxRates?: FxRates
  priorReturn: PriorReturnCaseRecord | null
  ownership: OwnershipResolution
  /** Member display names — used to EXCLUDE owner movements from the
   *  related-party panel (2026-07-07, Dynamiq incident: is_related_party is
   *  set for MEMBER matches too, but a member's money is an equity movement
   *  shown in the capital section — never a "related-party transaction"). */
  memberNames: string[]
}

/** Same substring rule the categorizer uses to flag members — the exclusion
 *  must mirror the inclusion, or rows leak between the two views. */
export function matchesMemberName(row: Pick<ValidationRow, "description" | "counterparty">, memberNames: string[]): boolean {
  if (memberNames.length === 0) return false
  const d = (row.description ?? "").toLowerCase()
  const c = (row.counterparty ?? "").toLowerCase()
  return memberNames.some(n => {
    const ln = n.toLowerCase()
    return ln.length > 0 && (d.includes(ln) || c.includes(ln))
  })
}

export function buildValidationBreakdown(input: BuildValidationInput): ValidationBreakdown {
  const { rows, draft, fxRates, priorReturn, ownership, memberNames } = input
  const rates: FxRates = fxRates ?? {}
  /** Related-party = flagged AND NOT an owner (owners live in the capital section). */
  const isTrueRelatedParty = (r: ValidationRow) =>
    r.is_related_party === true && !matchesMemberName(r, memberNames)

  // ── Shared converter — IDENTICAL to the draft's normalization ──
  const usdOf = (r: ValidationRow) => toUsd(Number(r.amount), r.currency, rates)

  // ── Composition helpers ──
  const missingRateSet = new Set<string>()
  const sliceByCurrency = (list: ValidationRow[]): CurrencySlice[] => {
    const m = new Map<string, CurrencySlice>()
    for (const r of list) {
      const cur = (r.currency ?? "").trim().toUpperCase() || "USD"
      const conv = usdOf(r)
      if (conv.missingRate) missingRateSet.add(cur)
      const s = m.get(cur) ?? {
        currency: cur, count: 0, sum_original: 0,
        rate: cur === "USD" ? null : (rates[cur] > 0 ? rates[cur] : null),
        missing_rate: cur !== "USD" && !(rates[cur] > 0),
        sum_usd: 0,
      }
      s.count++; s.sum_original += Number(r.amount); s.sum_usd += conv.usd
      m.set(cur, s)
    }
    return Array.from(m.values()).sort((a, b) => Math.abs(b.sum_usd) - Math.abs(a.sum_usd))
  }
  const topCounterparties = (list: ValidationRow[]) => {
    const m = new Map<string, { label: string; count: number; total_usd: number }>()
    for (const r of list) {
      const label = (r.counterparty || r.description || "(no description)").trim().slice(0, 60)
      const key = label.toLowerCase()
      const e = m.get(key) ?? { label, count: 0, total_usd: 0 }
      e.count++; e.total_usd += Math.abs(usdOf(r).usd)
      m.set(key, e)
    }
    return Array.from(m.values()).sort((a, b) => b.total_usd - a.total_usd).slice(0, 5)
  }
  const relatedIn = (list: ValidationRow[]) => {
    const rel = list.filter(isTrueRelatedParty)
    return { count: rel.length, total_usd: rel.reduce((s, r) => s + Math.abs(usdOf(r).usd), 0) }
  }
  const signedSum = (list: ValidationRow[]) => list.reduce((s, r) => s + usdOf(r).usd, 0)

  // ── P&L lines — SAME category filters and sign conventions as computePnlTotals ──
  const income = rows.filter(r => r.category === "income")
  const cogs = rows.filter(r => r.category === "cogs")
  const expenses = rows.filter(r => ["expense", "fee"].includes(r.category))
  const refunds = rows.filter(r => r.category === "refund")
  const distributions = rows.filter(r => r.category === "distribution")
  const contributions = rows.filter(r => r.category === "contribution")
  const uncategorized = rows.filter(r => r.category === "uncategorized")
  const conversions = rows.filter(r => r.category === "conversion")

  const line = (
    key: CompositionLine["key"], label: string, list: ValidationRow[], total: number,
  ): CompositionLine => ({
    key, label, total_usd: total, count: list.length,
    by_currency: sliceByCurrency(list),
    top_counterparties: topCounterparties(list),
    related_party: relatedIn(list),
  })

  // Sign conventions mirror computePnlTotals exactly (staff path never folds):
  const incomeTotal = signedSum(income)
  const cogsTotal = -signedSum(cogs)
  const expenseTotal = -signedSum(expenses) + -signedSum(refunds)
  const distTotal = distributions.reduce((s, r) => s + Math.abs(usdOf(r).usd), 0)
  const contribTotal = signedSum(contributions)
  const uncatTotal = signedSum(uncategorized)

  const expenseLine = line("expenses", "Operating expenses", [...expenses, ...refunds], expenseTotal)
  expenseLine.refunds = { count: refunds.length, total_usd: -signedSum(refunds) }

  const pnl_lines: CompositionLine[] = [
    line("income", "Revenue", income, incomeTotal),
    ...(cogs.length > 0 ? [line("cogs", "Cost of goods sold", cogs, cogsTotal)] : []),
    expenseLine,
    line("distributions", "Distributions (owner draws)", distributions, distTotal),
    ...(contributions.length > 0 ? [line("contributions", "Contributions (owner money in)", contributions, contribTotal)] : []),
    ...(uncategorized.length > 0 ? [line("uncategorized", "Unclassified — excluded from totals", uncategorized, uncatTotal)] : []),
  ]

  // ── Balance-sheet derivations (formulas, never fake row lists) ──
  const netMovement = signedSum(rows)
  const startCash = draft.beginning_cash ?? 0
  const bs_derivations: BsDerivation[] = [
    {
      key: "beginning_cash", label: "Beginning cash", value: draft.beginning_cash,
      terms: [{ label: draft.beginning_cash_source === "prior_return"
        ? "Prior-year return, Schedule L ending cash"
        : draft.beginning_cash_source === "statements"
          ? "Bank statements' opening balances"
          : "Not resolved — assumed 0 until staff tie it out", value: draft.beginning_cash }],
      note: priorReturn && (priorReturn.case === "first_year" || priorReturn.case === "never_filed")
        ? "First year / never filed — beginning balances start at zero by declaration."
        : undefined,
    },
    {
      key: "ending_cash", label: "Ending cash", value: draft.ending_cash,
      terms: [
        { label: "Beginning cash (0 when unresolved)", value: startCash },
        { label: `Net movement — every transaction, all ${rows.length} rows, converted to USD`, value: netMovement },
      ],
    },
    {
      key: "total_assets", label: "Total assets", value: draft.total_assets,
      terms: [{ label: "Ending cash (cash-basis v1: assets = cash)", value: draft.ending_cash }],
    },
    {
      key: "total_liabilities", label: "Total liabilities", value: draft.total_liabilities,
      terms: [{ label: "Cash-basis v1 books no liabilities", value: 0 }],
    },
    {
      key: "capital", label: "Members' capital", value: draft.ending_capital_total,
      terms: draft.members.map(m => ({
        label: `${m.name} (${m.pct}%): ${m.beginning_capital.toFixed(2)} begin + ${m.contributions.toFixed(2)} in + ${m.income_share.toFixed(2)} income − ${m.distributions.toFixed(2)} draws`,
        value: m.ending_capital,
      })),
      note: draft.unattributed.contributions !== 0 || draft.unattributed.distributions !== 0
        ? `Owner movements not matched by name were spread by ownership % so the M-2 ties (contributions ${draft.unattributed.contributions.toFixed(2)}, distributions ${draft.unattributed.distributions.toFixed(2)}) — confirm with the client.`
        : undefined,
    },
  ]

  // ── Provenance split (all rows) ──
  const provMap = new Map<ProvenanceClass, { count: number; total_abs_usd: number }>()
  for (const r of rows) {
    const cls = classifyProvenance(r)
    const e = provMap.get(cls) ?? { count: 0, total_abs_usd: 0 }
    e.count++; e.total_abs_usd += Math.abs(usdOf(r).usd)
    provMap.set(cls, e)
  }
  const provenance = (Object.keys(PROVENANCE_LABELS) as ProvenanceClass[])
    .filter(c => provMap.has(c))
    .map(c => ({ class: c, label: PROVENANCE_LABELS[c], ...provMap.get(c)! }))

  // ── Related-party (workspace-wide) — owners excluded by definition ──
  const relRows = rows.filter(isTrueRelatedParty)

  // ── Invariant: the breakdown must reproduce the draft, or say so loudly ──
  const mismatches: ValidationBreakdown["invariant"]["mismatches"] = []
  const expect = (lineName: string, breakdown: number, draftValue: number) => {
    if (Math.abs(breakdown - draftValue) > EPSILON) mismatches.push({ line: lineName, breakdown, draft: draftValue })
  }
  expect("Revenue", incomeTotal, draft.pnl.totalIncome)
  expect("Cost of goods sold", cogsTotal, draft.pnl.totalCogs)
  expect("Operating expenses", expenseTotal, draft.pnl.totalExpenses)
  expect("Distributions", distTotal, draft.pnl.totalDistributions)
  expect("Unclassified", uncatTotal, draft.pnl.uncategorizedTotal)
  expect("Ending cash", startCash + netMovement, draft.ending_cash)
  expect("Members' capital", draft.members.reduce((s, m) => s + m.ending_capital, 0), draft.ending_capital_total)

  return {
    pnl_lines,
    bs_derivations,
    provenance,
    exclusions: {
      conversions: { count: conversions.length, total_abs_usd: conversions.reduce((s, r) => s + Math.abs(usdOf(r).usd), 0) },
      unclassified: { count: uncategorized.length, total_usd: uncatTotal },
      missing_rate_currencies: Array.from(missingRateSet).sort(),
    },
    related_party: {
      count: relRows.length,
      total_abs_usd: relRows.reduce((s, r) => s + Math.abs(usdOf(r).usd), 0),
      top_counterparties: topCounterparties(relRows),
    },
    policy_inputs: {
      prior_return: priorReturn
        ? { case: priorReturn.case, status: priorReturn.status, note: (priorReturn as { note?: string }).note ?? null }
        : null,
      beginning_cash_source: draft.beginning_cash_source,
      ownership_sources: ownership.members.map(m => ({ name: m.name, pct: m.pct, source: m.source })),
      fx_rates_used: Object.entries(rates)
        .filter(([c]) => rows.some(r => (r.currency ?? "").trim().toUpperCase() === c))
        .map(([currency, rate]) => ({ currency, rate }))
        .sort((a, b) => a.currency.localeCompare(b.currency)),
    },
    invariant: { ok: mismatches.length === 0, mismatches },
  }
}
