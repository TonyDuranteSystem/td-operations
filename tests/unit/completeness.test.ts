import { describe, it, expect } from "vitest"
import { buildCompletenessSummary, type CompletenessInput } from "@/lib/tax/completeness"
import type { GateResult } from "@/lib/tax/verification-gates"
import type { FinancialDraft } from "@/lib/tax/financials-engine"

// ── Minimal fixtures ──
function gate(id: 1 | 2 | 3 | 4 | 5 | 6, status: "pass" | "na" | "fail", blocking = false): GateResult {
  return { id, title: `gate ${id}`, status, detail: `detail ${id}`, blocking }
}

/** All six gates passing, no blocking failures. */
function passingGates(): GateResult[] {
  return [gate(1, "pass"), gate(2, "na"), gate(3, "pass"), gate(4, "pass"), gate(5, "pass"), gate(6, "pass", true)]
}

function draft(over: Partial<FinancialDraft> = {}): FinancialDraft {
  return {
    tax_year: 2025,
    // pnl shape isn't read by completeness — a stub satisfies the type at runtime.
    pnl: { totalIncome: 0, totalCogs: 0, grossProfit: 0, totalExpenses: 0, netIncome: 0, totalDistributions: 0, totalContributions: 0, uncategorizedCount: 0, uncategorizedTotal: 0 } as FinancialDraft["pnl"],
    members: [],
    banks: [],
    beginning_cash: 0,
    beginning_cash_source: null,
    beginning_capital_total: 0,
    bank_balances: null,
    operating_expense_breakdown: [],
    ending_cash: 0,
    total_assets: 0,
    total_liabilities: 0,
    ending_capital_total: 0,
    fx_translation_adjustment: 0,
    conversion_gross: 0,
    balance_sheet_check: 0,
    unattributed: { contributions: 0, distributions: 0 },
    notes: [],
    ...over,
  }
}

function input(over: Partial<CompletenessInput> = {}): CompletenessInput {
  return { gates: passingGates(), draft: draft(), ...over }
}

describe("buildCompletenessSummary", () => {
  it("a clean all-USD return has no items and accepts as-is", () => {
    const r = buildCompletenessSummary(input())
    expect(r.items).toEqual([])
    expect(r.can_accept_as_is).toBe(true)
  })

  it("emits balance_sheet_off reading the authoritative balance_sheet_check when gate 3 fails", () => {
    const gates = passingGates().map(g => g.id === 3 ? gate(3, "fail") : g)
    const r = buildCompletenessSummary(input({
      gates,
      draft: draft({ total_assets: 1000, total_liabilities: 0, ending_capital_total: 250, balance_sheet_check: 750 }),
    }))
    const bs = r.items.find(i => i.code === "balance_sheet_off")
    expect(bs).toBeTruthy()
    expect(bs!.severity).toBe("warn")
    expect(bs!.amount).toBeCloseTo(750, 6)
  })

  it("balance_sheet_off uses balance_sheet_check, NOT a re-sum of assets − capital (multi-currency regression)", () => {
    // Multi-currency client: a hand re-sum (total_assets − (liabilities + capital) = 900)
    // would DROP the FX translation line and disagree with gate 3 / the Excel. The
    // authoritative residual is balance_sheet_check. Old buggy code returned 900; the
    // fixed code must return the check value.
    const gates = passingGates().map(g => g.id === 3 ? gate(3, "fail") : g)
    const r = buildCompletenessSummary(input({
      gates,
      draft: draft({
        total_assets: 1000,
        total_liabilities: 0,
        ending_capital_total: 100,
        fx_translation_adjustment: 850,
        balance_sheet_check: 50,
      }),
    }))
    const bs = r.items.find(i => i.code === "balance_sheet_off")
    expect(bs!.amount).toBeCloseTo(50, 6)
    // guard against a regression back to the component re-sum
    expect(bs!.amount).not.toBeCloseTo(900, 6)
  })

  it("emits reconciliation_gap (gate 1) and ownership_incomplete (gate 5) on failure", () => {
    const gates = passingGates().map(g => (g.id === 1 || g.id === 5) ? gate(g.id, "fail") : g)
    const r = buildCompletenessSummary(input({ gates }))
    expect(r.items.map(i => i.code)).toEqual(expect.arrayContaining(["reconciliation_gap", "ownership_incomplete"]))
  })

  it("emits no_prior_year (info) only when beginning cash came from statements", () => {
    expect(buildCompletenessSummary(input()).items.find(i => i.code === "no_prior_year")).toBeUndefined()
    const r = buildCompletenessSummary(input({ draft: draft({ beginning_cash_source: "statements", beginning_cash: 4200 }) }))
    const npy = r.items.find(i => i.code === "no_prior_year")
    expect(npy?.severity).toBe("info")
    expect(npy?.amount).toBe(4200)
  })

  it("emits unattributed_owner_moves when contributions/distributions didn't match a member", () => {
    const r = buildCompletenessSummary(input({ draft: draft({ unattributed: { contributions: 0, distributions: 5000 } }) }))
    const u = r.items.find(i => i.code === "unattributed_owner_moves")
    expect(u?.amount).toBeCloseTo(5000, 6)
    // sub-cent residue does NOT trip it
    expect(buildCompletenessSummary(input({ draft: draft({ unattributed: { contributions: 0.001, distributions: 0 } }) }))
      .items.find(i => i.code === "unattributed_owner_moves")).toBeUndefined()
  })

  it("emits missing_fx_rate listing the currencies", () => {
    const r = buildCompletenessSummary(input({ missingFxCurrencies: ["AED", "GBP"] }))
    expect(r.items.find(i => i.code === "missing_fx_rate")?.detail).toBe("AED, GBP")
  })

  it("soft-warn gaps (gates 1/3/5 failing, non-blocking) never block accept-as-is", () => {
    const gates = passingGates().map(g => (g.id === 1 || g.id === 3 || g.id === 5) ? gate(g.id, "fail") : g)
    expect(buildCompletenessSummary(input({ gates })).can_accept_as_is).toBe(true)
  })

  it("a BLOCKING gate failure (gate 6) does block accept-as-is", () => {
    const gates = passingGates().map(g => g.id === 6 ? gate(6, "fail", true) : g)
    expect(buildCompletenessSummary(input({ gates })).can_accept_as_is).toBe(false)
  })
})
