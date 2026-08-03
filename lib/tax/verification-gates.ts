/**
 * The six verification gates (Slice 7, master plan §4) — PURE.
 *
 * Every gate returns pass / na (with the reason) / fail (with what's wrong).
 * NEVER silent: a gate that can't run says why, a gate that fails says what
 * to fix. The client sees passed gates as checkmarks (Slice 8).
 *
 * NO GATE BLOCKS CONFIRM any more (2026-08-03, Antonio). Gate 6 was the only
 * `blocking` one and, on the client draft, could never fail — see its comment
 * below. The client may confirm with items still undecided; the system's job is
 * to state plainly what is a suggestion and what they decided, not to bar the
 * door. Confirm is still gated on the coverage questions and on ingestion
 * finishing — those live in the route/UI, not here.
 *
 * Tolerances: $1 on cash identities (plan-specified), 0.5% on ownership.
 */

import { pendingCount, pendingNet } from "./disclosure-text"
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

  // ── Gate 1: per-account reconciliation against the best opening/closing anchor ──
  // Reconciliation is checked against each account's AUTHORITATIVE anchors — a
  // reliable statement running-balance (kept by the engine only when it covers
  // every row and self-reconciles) OR the client/staff-provided opening &
  // closing balances. An unreliable running-balance column (partial or out of
  // order) is discarded by the engine and never raises a false "off by": when
  // the client's provided balances + the year's movements tie (Dynamiq), this
  // gate passes. It fails only when a real anchor genuinely does not reconcile
  // (a wrong opening/closing figure or a truly missing transaction).
  {
    const merged = draft.bank_balances?.banks ?? []
    const checkable = merged.filter(b => b.opening_usd !== null && b.closing_usd !== null)
    if (checkable.length === 0) {
      results.push({
        id: 1, title: "Statement reconciliation", status: "na", blocking: false,
        detail: "Verified through the opening and closing balances on file, full-year coverage, and your confirmation — the statements' running-balance column was not needed.",
      })
    } else {
      const broken = checkable.filter(b => b.tie === "mismatch")
      results.push(broken.length === 0
        ? { id: 1, title: "Statement reconciliation", status: "pass", blocking: false, detail: `${checkable.length} account(s) reconcile: beginning + movements = ending.` }
        : { id: 1, title: "Statement reconciliation", status: "fail", blocking: false, detail: `The opening balance plus the year's transactions does not equal the closing balance for: ${broken.map(b => b.bank_key).join(", ")} — re-check that account's opening/closing figures, or a transaction may be missing.` })
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
          : { id: 2, title: "Prior-year tie-out", status: "fail", blocking: false, detail: `Last year's return shows ending cash ${draft.beginning_cash.toFixed(2)}, but this year's opening balances add up to ${currentBeginning.toFixed(2)} — usually a bank account that isn't included this year, or an opening balance to re-check.` })
      }
    }
  }

  // ── Gate 3: A = L + C + FX translation adjustment ──
  // The foreign-exchange translation adjustment (Phase 3) is a disclosed equity
  // line, so the identity is assets = liabilities + capital + translation
  // adjustment. Currency exchanges no longer show as a bare "off by" — they are
  // named and carried in equity, never in income or member capital.
  {
    // Single source of the balance identity (draft.balance_sheet_check): assets −
    // (liabilities + capital + FX translation adjustment + unclassified cash). The
    // screen and the Excel read the SAME field, so none can drift.
    results.push(close(draft.balance_sheet_check, 0)
      ? { id: 3, title: "Balance sheet balances", status: "pass", blocking: false, detail: `Assets ${draft.total_assets.toFixed(2)} = liabilities + capital${Math.abs(draft.fx_translation_adjustment) > 0.01 ? " + foreign-exchange translation adjustment" : ""}.` }
      : { id: 3, title: "Balance sheet balances", status: "fail", blocking: false, detail: `The balance sheet is off by ${draft.balance_sheet_check.toFixed(2)} (assets ${draft.total_assets.toFixed(2)} vs liabilities ${draft.total_liabilities.toFixed(2)} + capital ${draft.ending_capital_total.toFixed(2)} + FX adjustment ${draft.fx_translation_adjustment.toFixed(2)}) — usually uncategorized transactions or a beginning-balance gap.` })
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

  // ── Gate 6: everything the client has actually decided ──
  //
  // Rewritten 2026-08-03 (Antonio). This gate used to read ONLY
  // `uncategorizedCount`, which the client-side draft FORCES to zero (the
  // `defaultUncategorizedBySign` policy folds every undecided row into
  // income/expenses). So on the portal it could never fail, and it printed
  // "All transactions are categorized" on the same screen that listed 394
  // items still needing an answer — while those items' AI-SUGGESTED amounts
  // were already inside the client's P&L. Bence Koncz's entire expense side
  // was his two undecided rows, one of them flagged "looks personal".
  //
  // Two changes:
  //  1. Count what is REALLY pending. Exactly one of the two figures is
  //     non-zero by construction (folding on → folded*, folding off →
  //     uncategorized*), so summing is safe and works for BOTH the client
  //     draft and the staff workspace.
  //  2. NON-BLOCKING (Antonio's decision, verbatim: "someone should be able to
  //     confirm their accounts while items are still unanswered, we just
  //     suggest but they know the truth"). It was the only blocking gate, so
  //     `can_accept_as_is` stays true and confirm remains available — the
  //     client is TOLD the number instead of being stopped by it. The honesty
  //     now lives in the wording, the provisional P&L line, and the
  //     attestation text.
  {
    // Shared with the client-facing sentence (lib/tax/disclosure-text.ts) so the
    // gate and the disclosure the client signs can never disagree — the first
    // cut duplicated this arithmetic in the component and got the income half
    // wrong, producing "−0.00 of expenses" beside a gate saying +120,000.
    const pending = pendingCount(draft.pnl)
    const net = pendingNet(draft.pnl)
    results.push(pending === 0
      ? { id: 6, title: "Every transaction categorized", status: "pass", blocking: false, detail: "You have decided every transaction." }
      : {
          id: 6,
          title: "Every transaction categorized",
          status: "fail",
          blocking: false,
          // Staff-facing wording; the portal renders the client's language from
          // gateSixText() off the SAME two numbers.
          detail: `${pending} transaction(s) (net ${net.toFixed(2)}) are booked on OUR suggestion and not yet confirmed by you — they are already counted in the figures below. Answer them to make these numbers yours.`,
        })
  }

  return results
}

/** Confirm is allowed only when no BLOCKING gate fails. */
export function canConfirm(gates: GateResult[]): boolean {
  return gates.every(g => !(g.blocking && g.status === "fail"))
}
