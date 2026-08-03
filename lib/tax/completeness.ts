/**
 * Financials completeness summary (generic, all clients) — PURE.
 *
 * After the engine computes the P&L + Balance Sheet, the portal review tells
 * the client, in plain language, WHAT is complete and WHAT is still uncertain —
 * then lets them either provide more or accept as-is (owning the
 * responsibility). This module turns the structured draft + the verification
 * gates into a list of machine CODES (the UI renders bilingual text — see
 * components/portal/tax-financials-review.tsx) with the numbers each line needs
 * (amount off, owner-movement totals, etc.).
 *
 * Scope (CPA-correct, 2026-06-23): we file the LLC's US return from the LLC's
 * own books. The only completeness concern is whether those books are whole —
 * a missing LLC account, missing months, an unbalanced sheet, unresolved
 * ownership. We do NOT ask about the owners' personal / home-country activity:
 * the LLC invoices everything, and what owners do outside the US is not our
 * concern and not on the return. (An earlier "income question" built on the
 * opposite premise was removed.)
 *
 * Soft-warn ALL balance-sheet/tie-out gaps — never hard-block; these clients
 * may owe no US tax and the balance sheet is informational, so the client can
 * accept as-is and own it. Since 2026-08-03 NO gate is blocking at all — gate 6
 * was the last one and is now informational (Antonio: a client may confirm with
 * items still undecided, "we just suggest but they know the truth"), so
 * `can_accept_as_is` is effectively always true and the field is kept as the
 * seam for any FUTURE blocking gate. What still refuses a confirm lives in the
 * route/UI: the coverage questions and in-flight ingestion. No prose parsing —
 * driven off structured fields so the mapping is unit-testable.
 */

import type { FinancialDraft } from "./financials-engine"
import type { GateResult } from "./verification-gates"

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

export interface CompletenessSummary {
  items: CompletenessItem[]
  /** Accept-as-is is allowed when no BLOCKING gate fails. Non-substantive gaps
   *  are soft-warns and never block. Coverage questions are enforced separately
   *  by the caller (orchestration/route), as before. */
  can_accept_as_is: boolean
}

export interface CompletenessInput {
  gates: GateResult[]
  draft: FinancialDraft
  /** Currencies present with no IRS rate on file (from the engine), if any. */
  missingFxCurrencies?: string[]
}

const gate = (gates: GateResult[], id: number) => gates.find(g => g.id === id)

export function buildCompletenessSummary(input: CompletenessInput): CompletenessSummary {
  const { gates, draft, missingFxCurrencies } = input
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
    // Read the ONE authoritative residual (assets − (liabilities + capital +
    // fx_translation_adjustment + uncategorized cash)). Never re-sum the
    // components here — a hand re-sum silently drops the FX + uncategorized
    // terms and disagrees with gate 3 / the Excel / the portal check, which is
    // exactly the term-dropping bug balance_sheet_check exists to prevent.
    items.push({ code: "balance_sheet_off", severity: "warn", amount: draft.balance_sheet_check })
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

  const noBlockingGate = gates.every(g => !(g.blocking && g.status === "fail"))

  return { items, can_accept_as_is: noBlockingGate }
}
