/**
 * Categorization eval metrics (Smart Categorization v2, Phase 1 — 2026-07-03).
 *
 * PURE: given predicted rows and golden labels, compute the decision-grade
 * metrics the approved plan gates releases on. No DB, no network — the runner
 * (scripts/qa/categorization-eval.ts) assembles inputs; this file is the
 * unit-tested measurement core.
 *
 * Design requirements from the adversarial reviews:
 * - DOLLAR-WEIGHTED precision, not just row counts (two wrong $50k rows must
 *   outweigh twenty wrong $3 rows).
 * - Per-SOURCE attribution (rule / ai:high / uncategorized) and per-confidence
 *   precision — the calibration evidence for the ai:high ≥98% gate.
 * - Named critical-error classes with their own bounds:
 *     · owner_draw_as_expense — a distribution booked as expense (wrong tax
 *       deduction, the worst error class);
 *     · transfer_leg_misbooked — an internal-transfer leg booked as
 *       income/expense (corrupts the P&L one-sidedly).
 * - |ΔP&L$|: the dollar distance between the predicted P&L and the golden one
 *   (for an informational, attestation-based P&L this is the headline metric).
 * - Question-group count: the actual UX outcome (how many decisions a human
 *   still faces).
 * - Declared FX convention: amounts are converted with the provided per-
 *   currency rates (IRS yearly average — same convention as the engine).
 */

export interface EvalRow {
  id: string
  amount: number
  currency: string
  /** Predicted bookkeeping category (engine output). */
  predicted: string
  /** How the prediction was made: 'rule' | 'ai:high' | 'legacy' | 'none' (still uncategorized). */
  source: string
  /** Golden label (human-reconciled truth). */
  label: string
  /** Merchant-root grouping key (for the question-group count). */
  groupKey?: string
}

export interface EvalGates {
  /** Minimum dollar-weighted precision for auto-applied rows (default 0.98). */
  minAutoAppliedPrecision: number
  /** Max share of auto-applied DOLLARS in the owner_draw_as_expense class (default 0.005). */
  maxOwnerDrawAsExpense: number
  /** Max count of transfer legs auto-booked as income/expense (default 0). */
  maxTransferLegMisbooked: number
}

export const DEFAULT_GATES: EvalGates = {
  minAutoAppliedPrecision: 0.98,
  maxOwnerDrawAsExpense: 0.005,
  maxTransferLegMisbooked: 0,
}

export interface EvalReport {
  totalRows: number
  totalAbsDollars: number
  /** Rows the system decided on its own (rule or ai:high) — the auto rate. */
  autoRate: number
  autoRateDollars: number
  /** Dollar-weighted precision over ALL auto-decided rows. */
  autoAppliedPrecisionDollars: number
  /** Row-count precision over the same set (secondary). */
  autoAppliedPrecisionRows: number
  /** Per-source breakdown: source → { rows, dollars, correctRows, correctDollars, precisionDollars }. */
  bySource: Record<string, { rows: number; dollars: number; correctRows: number; correctDollars: number; precisionDollars: number }>
  /** Critical classes. */
  ownerDrawAsExpenseDollars: number
  ownerDrawAsExpenseShare: number
  transferLegMisbookedCount: number
  transferLegMisbookedDollars: number
  /** Residual human work: distinct group keys among still-undecided rows. */
  openQuestionGroups: number
  /** |ΔP&L$|: dollar distance between predicted and golden net income. */
  pnlDeltaDollars: number
  /** Gate results. */
  gates: { pass: boolean; failures: string[] }
}

/** Categories that feed net income (mirror of computePnlTotals semantics —
 *  conversion is excluded from the P&L entirely). */
const INCOME_CATS = new Set(["income"])
const COST_CATS = new Set(["expense", "fee", "cogs"])

function netIncomeUsd(rows: EvalRow[], pick: (r: EvalRow) => string, fx: (currency: string) => number): number {
  let net = 0
  for (const r of rows) {
    const cat = pick(r)
    const usd = r.amount / fx(r.currency)
    if (INCOME_CATS.has(cat)) net += usd
    else if (COST_CATS.has(cat)) net += usd // costs are negative amounts; adding keeps sign
    else if (cat === "refund") net += usd
  }
  return net
}

export function computeEvalReport(
  rows: EvalRow[],
  opts?: { gates?: Partial<EvalGates>; fxRateToUsd?: Record<string, number> },
): EvalReport {
  const gates = { ...DEFAULT_GATES, ...(opts?.gates ?? {}) }
  const fx = (currency: string) => {
    const r = opts?.fxRateToUsd?.[currency]
    return currency === "USD" || !r ? 1 : r
  }
  const usdAbs = (r: EvalRow) => Math.abs(r.amount) / fx(r.currency)

  const totalAbsDollars = rows.reduce((s, r) => s + usdAbs(r), 0)
  const auto = rows.filter(r => r.source === "rule" || r.source === "ai:high" || r.source === "legacy")

  const bySource: EvalReport["bySource"] = {}
  for (const r of rows) {
    const key = r.source
    const e = bySource[key] ?? { rows: 0, dollars: 0, correctRows: 0, correctDollars: 0, precisionDollars: 0 }
    e.rows++
    e.dollars += usdAbs(r)
    if (r.predicted === r.label) { e.correctRows++; e.correctDollars += usdAbs(r) }
    bySource[key] = e
  }
  for (const e of Object.values(bySource)) e.precisionDollars = e.dollars > 0 ? e.correctDollars / e.dollars : 1

  const autoDollars = auto.reduce((s, r) => s + usdAbs(r), 0)
  const autoCorrectDollars = auto.filter(r => r.predicted === r.label).reduce((s, r) => s + usdAbs(r), 0)
  const autoCorrectRows = auto.filter(r => r.predicted === r.label).length

  // Critical classes (measured over AUTO-decided rows — human answers are out of scope here).
  const ownerDraw = auto.filter(r => r.label === "distribution" && COST_CATS.has(r.predicted))
  const ownerDrawDollars = ownerDraw.reduce((s, r) => s + usdAbs(r), 0)
  const transferLegs = auto.filter(r => r.label === "conversion" && (INCOME_CATS.has(r.predicted) || COST_CATS.has(r.predicted)))
  const transferLegDollars = transferLegs.reduce((s, r) => s + usdAbs(r), 0)

  const open = rows.filter(r => r.source === "none")
  const openQuestionGroups = new Set(open.map(r => r.groupKey ?? r.id)).size

  const pnlDelta = Math.abs(
    netIncomeUsd(rows, r => r.predicted, fx) - netIncomeUsd(rows, r => r.label, fx),
  )

  const autoAppliedPrecisionDollars = autoDollars > 0 ? autoCorrectDollars / autoDollars : 1
  const ownerDrawShare = autoDollars > 0 ? ownerDrawDollars / autoDollars : 0

  const failures: string[] = []
  if (autoAppliedPrecisionDollars < gates.minAutoAppliedPrecision) {
    failures.push(`auto-applied dollar precision ${(autoAppliedPrecisionDollars * 100).toFixed(2)}% < gate ${(gates.minAutoAppliedPrecision * 100).toFixed(0)}%`)
  }
  if (ownerDrawShare > gates.maxOwnerDrawAsExpense) {
    failures.push(`owner-draw-as-expense ${(ownerDrawShare * 100).toFixed(2)}% of auto dollars > gate ${(gates.maxOwnerDrawAsExpense * 100).toFixed(2)}%`)
  }
  if (transferLegs.length > gates.maxTransferLegMisbooked) {
    failures.push(`${transferLegs.length} transfer leg(s) auto-booked as income/expense (gate: ${gates.maxTransferLegMisbooked})`)
  }

  return {
    totalRows: rows.length,
    totalAbsDollars,
    autoRate: rows.length > 0 ? auto.length / rows.length : 0,
    autoRateDollars: totalAbsDollars > 0 ? autoDollars / totalAbsDollars : 0,
    autoAppliedPrecisionDollars,
    autoAppliedPrecisionRows: auto.length > 0 ? autoCorrectRows / auto.length : 1,
    bySource,
    ownerDrawAsExpenseDollars: ownerDrawDollars,
    ownerDrawAsExpenseShare: ownerDrawShare,
    transferLegMisbookedCount: transferLegs.length,
    transferLegMisbookedDollars: transferLegDollars,
    openQuestionGroups,
    pnlDeltaDollars: pnlDelta,
    gates: { pass: failures.length === 0, failures },
  }
}
