/**
 * Financials completeness summary (generic, all clients) — PURE.
 *
 * After the engine computes the P&L + Balance Sheet, the portal review must
 * tell the client, in plain language, WHAT is complete and WHAT is still
 * uncertain — then let them either provide more or accept as-is (owning the
 * responsibility). This module turns the structured draft + the verification
 * gates into:
 *   - a list of machine CODES (the UI renders bilingual text — see
 *     components/portal/tax-financials-review.tsx) with the numbers each line
 *     needs (amount off, owner-movement totals, etc.);
 *   - a targeted INCOME question that fires only when there is meaningful
 *     foreign-currency / cross-account movement (evidence of an account we may
 *     not see). It must be ANSWERED before accept-as-is — so finalizing never
 *     silently ships understated income (which flows to partners' home-country
 *     returns). Either answer unblocks (the client owns it); "earn_spend" just
 *     surfaces a prominent warning + is recorded for staff/K-1 follow-up.
 *
 * Design (Antonio, dev_task 95127bb2): soft-warn ALL balance-sheet/tie-out
 * gaps (never hard-block — these clients owe no US tax and the balance sheet
 * is informational), but REQUIRE the income question on suspected-missing
 * income. No prose parsing — everything is driven off structured fields so the
 * mapping is unit-testable.
 */

import type { FinancialDraft } from "./financials-engine"
import type { GateResult } from "./verification-gates"

/** Foreign/conversion movement (USD, absolute) at/above which the income
 *  question is required. Below this a stray FX fee shouldn't nag the client.
 *  A single tunable knob — change here, both the gate and the UI follow. */
export const FOREIGN_ACTIVITY_FLOOR = 1000

export type IncomeAnswer = "earn_spend" | "parked_only"

export type CompletenessCode =
  | "reconciliation_gap"        // gate 1 fail — a statement doesn't add up
  | "no_prior_year"             // beginning cash came from statements, not a prior return
  | "balance_sheet_off"         // gate 3 fail — assets ≠ liabilities + capital
  | "capital_rollforward"       // gate 4 fail — M-2 arithmetic doesn't tie
  | "ownership_incomplete"      // gate 5 fail — ownership % not fully resolved
  | "unattributed_owner_moves"  // contributions/distributions not matched to a member
  | "missing_fx_rate"           // a non-USD currency has no IRS rate on file

export interface CompletenessItem {
  code: CompletenessCode
  /** warn = the client should consider acting; info = FYI, low-stakes. */
  severity: "warn" | "info"
  /** A signed/absolute figure the UI may interpolate (e.g. balance-sheet gap). */
  amount?: number
  /** Free detail the UI may show verbatim (bank keys, currency codes). */
  detail?: string
}

export interface IncomeQuestionState {
  /** True when foreign/conversion movement ≥ FOREIGN_ACTIVITY_FLOOR. */
  required: boolean
  /** The absolute foreign/conversion total (USD) that drove `required`. */
  foreign_total: number
  /** The client's recorded answer, or null if not answered yet. */
  answer: IncomeAnswer | null
}

export interface CompletenessSummary {
  items: CompletenessItem[]
  income_question: IncomeQuestionState
  /** Accept-as-is is allowed when no BLOCKING gate fails AND the income
   *  question (if required) has been answered. Non-substantive gaps are
   *  soft-warns and never block. Coverage questions are enforced separately
   *  by the caller (orchestration/route), as before. */
  can_accept_as_is: boolean
}

export interface CompletenessInput {
  gates: GateResult[]
  draft: FinancialDraft
  /** Σ |amount| over conversion rows + non-USD rows (USD), computed by the
   *  caller from the year's transactions. */
  foreignActivityTotal: number
  /** Currencies present with no IRS rate on file (from the engine), if any. */
  missingFxCurrencies?: string[]
  /** The client's recorded income answer (financials_meta.income_attestation). */
  incomeAnswer: IncomeAnswer | null
}

const gate = (gates: GateResult[], id: number) => gates.find(g => g.id === id)

export function buildCompletenessSummary(input: CompletenessInput): CompletenessSummary {
  const { gates, draft, foreignActivityTotal, missingFxCurrencies, incomeAnswer } = input
  const items: CompletenessItem[] = []

  // Gate 1 — a statement doesn't reconcile (missing months / filtered export).
  const g1 = gate(gates, 1)
  if (g1?.status === "fail") {
    items.push({ code: "reconciliation_gap", severity: "warn", detail: g1.detail })
  }

  // No prior-year return — beginning balances came from the statements' opening.
  if (draft.beginning_cash_source === "statements") {
    items.push({ code: "no_prior_year", severity: "info", amount: draft.beginning_cash ?? 0 })
  }

  // Gate 3 — balance sheet doesn't balance (the headline "is anything missing?").
  const g3 = gate(gates, 3)
  if (g3?.status === "fail") {
    const off = draft.total_assets - (draft.total_liabilities + draft.ending_capital_total)
    items.push({ code: "balance_sheet_off", severity: "warn", amount: off })
  }

  // Gate 4 — capital roll-forward arithmetic (rare; informational for the client).
  const g4 = gate(gates, 4)
  if (g4?.status === "fail") items.push({ code: "capital_rollforward", severity: "info" })

  // Gate 5 — ownership %s not resolved (K-1 allocation needs them).
  const g5 = gate(gates, 5)
  if (g5?.status === "fail") items.push({ code: "ownership_incomplete", severity: "warn", detail: g5.detail })

  // Owner money in/out we couldn't match to a specific member by name.
  const um = draft.unattributed
  if (Math.abs(um.contributions) > 0.005 || Math.abs(um.distributions) > 0.005) {
    items.push({
      code: "unattributed_owner_moves",
      severity: "info",
      amount: Math.abs(um.contributions) + Math.abs(um.distributions),
    })
  }

  // A non-USD currency with no IRS yearly-average rate on file — those amounts
  // are shown unconverted until the rate is added.
  if (missingFxCurrencies && missingFxCurrencies.length > 0) {
    items.push({ code: "missing_fx_rate", severity: "warn", detail: missingFxCurrencies.join(", ") })
  }

  const incomeRequired = foreignActivityTotal >= FOREIGN_ACTIVITY_FLOOR
  const income_question: IncomeQuestionState = {
    required: incomeRequired,
    foreign_total: foreignActivityTotal,
    answer: incomeAnswer,
  }

  const noBlockingGate = gates.every(g => !(g.blocking && g.status === "fail"))
  const incomeSatisfied = !incomeRequired || incomeAnswer !== null

  return {
    items,
    income_question,
    can_accept_as_is: noBlockingGate && incomeSatisfied,
  }
}
