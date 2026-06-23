/**
 * The six verification gates (Slice 7, master plan §4) — PURE.
 *
 * Every gate returns pass / na (with the reason) / fail (with what's wrong).
 * NEVER silent: a gate that can't run says why, a gate that fails says what
 * to fix. The client sees passed gates as checkmarks (Slice 8); confirm is
 * blocked while gate 6 (uncategorized == 0) fails — that one is HARD.
 *
 * Tolerances: $1 on cash identities (plan-specified), 0.5% on ownership.
 */

import type { FinancialDraft } from "./financials-engine"
import type { OwnershipResolution } from "./ownership-resolution"
import type { PriorReturnCaseRecord } from "./prior-return-case"

const CASH_TOLERANCE = 1.0
const PCT_TOLERANCE = 0.5

export type GateStatus = "pass" | "na" | "fail"

export interface GateResult {
  id: 1 | 2 | 3 | 4 | 5 | 6
  title: string
  status: GateStatus
  detail: string
  /** True for gates whose failure blocks client confirm (gate 6). */
  blocking: boolean
}

export interface EvaluateGatesInput {
  draft: FinancialDraft
  ownership: OwnershipResolution
  priorReturn: PriorReturnCaseRecord | null
}

const close = (a: number, b: number, tol = CASH_TOLERANCE) => Math.abs(a - b) <= tol

export function evaluateGates(input: EvaluateGatesInput): GateResult[] {
  const { draft, ownership, priorReturn } = input
  const results: GateResult[] = []

  // ── Gate 1: per-statement reconciliation (where balances exist) ──
  {
    const checkable = draft.banks.filter(b => b.derived_beginning !== null && b.reported_ending !== null)
    if (checkable.length === 0) {
      results.push({
        id: 1, title: "Statement reconciliation", status: "na", blocking: false,
        detail: "The uploaded CSV files carry no running-balance column — verified instead through full-year coverage, the prior-year tie-out, and your confirmation.",
      })
    } else {
      const broken = checkable.filter(b => !close((b.derived_beginning as number) + b.net_movement, b.reported_ending as number))
      results.push(broken.length === 0
        ? { id: 1, title: "Statement reconciliation", status: "pass", blocking: false, detail: `${checkable.length} account(s) reconcile: beginning + movements = ending.` }
        : { id: 1, title: "Statement reconciliation", status: "fail", blocking: false, detail: `Does not reconcile for: ${broken.map(b => b.bank_key).join(", ")} — usually a partial export (missing months or filtered transactions). Re-export the entire year.` })
    }
  }

  // ── Gate 2: prior ending cash == current beginning ──
  {
    if (!priorReturn || priorReturn.status === "failed") {
      results.push({ id: 2, title: "Prior-year tie-out", status: "na", blocking: false, detail: "No prior-return answer on file yet — complete the prior-return step." })
    } else if (priorReturn.case === "first_year" || priorReturn.case === "never_filed") {
      results.push({ id: 2, title: "Prior-year tie-out", status: "na", blocking: false, detail: priorReturn.case === "first_year" ? "First year — beginning balances start at zero." : "No prior return exists (declared) — beginning balances start at zero." })
    } else if (priorReturn.case === "we_filed" && priorReturn.status === "claim_mismatch") {
      results.push({ id: 2, title: "Prior-year tie-out", status: "fail", blocking: false, detail: "You said we filed last year's return but we found no record — staff will verify before review can finish." })
    } else if (priorReturn.case === "we_filed" && priorReturn.status === "on_file") {
      results.push({ id: 2, title: "Prior-year tie-out", status: "na", blocking: false, detail: "Prior return is on file with us — staff tie out the beginning balances during review." })
    } else if ((priorReturn.case === "filed_elsewhere" || priorReturn.case === "we_filed") && priorReturn.status === "quarantined") {
      results.push({ id: 2, title: "Prior-year tie-out", status: "fail", blocking: false, detail: "The prior return did not pass verification — staff are reviewing it." })
    } else if (draft.beginning_cash === null) {
      results.push({ id: 2, title: "Prior-year tie-out", status: "na", blocking: false, detail: "The prior return has no readable cash balance — staff tie out manually." })
    } else {
      const derivable = draft.banks.filter(b => b.derived_beginning !== null)
      if (derivable.length < draft.banks.length) {
        results.push({ id: 2, title: "Prior-year tie-out", status: "na", blocking: false, detail: "Not every account's CSV carries balances — the prior-year figure is used as the beginning cash; staff confirm during review." })
      } else {
        const currentBeginning = derivable.reduce((s, b) => s + (b.derived_beginning as number), 0)
        results.push(close(currentBeginning, draft.beginning_cash)
          ? { id: 2, title: "Prior-year tie-out", status: "pass", blocking: false, detail: `Last year's ending cash (${draft.beginning_cash.toFixed(2)}) matches this year's beginning balances.` }
          : { id: 2, title: "Prior-year tie-out", status: "fail", blocking: false, detail: `Last year's return shows ending cash ${draft.beginning_cash.toFixed(2)}, but this year's statements begin at ${currentBeginning.toFixed(2)} — usually a missing bank account or a missing January. Add the missing account or re-export the full year.` })
      }
    }
  }

  // ── Gate 3: A = L + C ──
  {
    const rhs = draft.total_liabilities + draft.ending_capital_total
    results.push(close(draft.total_assets, rhs)
      ? { id: 3, title: "Balance sheet balances", status: "pass", blocking: false, detail: `Assets ${draft.total_assets.toFixed(2)} = liabilities + capital.` }
      : { id: 3, title: "Balance sheet balances", status: "fail", blocking: false, detail: `Assets ${draft.total_assets.toFixed(2)} ≠ liabilities ${draft.total_liabilities.toFixed(2)} + capital ${draft.ending_capital_total.toFixed(2)} (off by ${(draft.total_assets - rhs).toFixed(2)}) — usually uncategorized transactions or a beginning-balance gap.` })
  }

  // ── Gate 4: M-2 ties (roll-forward arithmetic) ──
  {
    const computed = draft.beginning_capital_total
      + draft.members.reduce((s, m) => s + m.contributions, 0)
      + draft.members.reduce((s, m) => s + m.income_share, 0)
      - draft.members.reduce((s, m) => s + m.distributions, 0)
    results.push(draft.members.length === 0
      ? { id: 4, title: "Capital accounts (M-2)", status: "na", blocking: false, detail: "No members with ownership % resolved yet — see gate 5." }
      : close(computed, draft.ending_capital_total)
        ? { id: 4, title: "Capital accounts (M-2)", status: "pass", blocking: false, detail: "Beginning capital + contributions + income − distributions = ending capital, for every member." }
        : { id: 4, title: "Capital accounts (M-2)", status: "fail", blocking: false, detail: `Capital roll-forward does not tie (computed ${computed.toFixed(2)} vs ${draft.ending_capital_total.toFixed(2)}).` })
  }

  // ── Gate 5: K-1 allocation — Σ shares == net income AND Σ % == 100 ──
  {
    if (!ownership.complete) {
      const parts = [
        ownership.missing.length ? `missing % for ${ownership.missing.join(", ")}` : "",
        Math.abs(ownership.totalPct - 100) > PCT_TOLERANCE ? `percentages sum to ${ownership.totalPct}%` : "",
      ].filter(Boolean).join("; ")
      results.push({ id: 5, title: "K-1 allocation", status: "fail", blocking: false, detail: `Ownership is not fully resolved (${parts}) — K-1s are blocked until staff/you confirm the percentages.` })
    } else {
      const sumShares = draft.members.reduce((s, m) => s + m.income_share, 0)
      results.push(close(sumShares, draft.pnl.netIncome)
        ? { id: 5, title: "K-1 allocation", status: "pass", blocking: false, detail: `K-1 shares sum to net income; ownership totals ${ownership.totalPct}%.` }
        : { id: 5, title: "K-1 allocation", status: "fail", blocking: false, detail: `K-1 shares (${sumShares.toFixed(2)}) do not sum to net income (${draft.pnl.netIncome.toFixed(2)}).` })
    }
  }

  // ── Gate 6: uncategorized == 0 — HARD, blocks confirm ──
  {
    results.push(draft.pnl.uncategorizedCount === 0
      ? { id: 6, title: "Every transaction categorized", status: "pass", blocking: true, detail: "All transactions are categorized." }
      : { id: 6, title: "Every transaction categorized", status: "fail", blocking: true, detail: `${draft.pnl.uncategorizedCount} transaction(s) still need an answer (net ${draft.pnl.uncategorizedTotal.toFixed(2)}) — answer the remaining questions to continue.` })
  }

  return results
}

/** Confirm is allowed only when no BLOCKING gate fails. */
export function canConfirm(gates: GateResult[]): boolean {
  return gates.every(g => !(g.blocking && g.status === "fail"))
}
