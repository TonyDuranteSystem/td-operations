/**
 * Cross-year carry-forward: year N's beginning balances come from OUR corrected
 * year N-1 books, not a stale extraction of the originally-filed prior return
 * (the Dynamiq trap — 2025 was starting from the mis-filed 2024's $1.14M cash).
 * buildPriorFromDraft maps a corrected N-1 draft into the prior-return record the
 * engine reads for N; this pins that cash AND per-member capital carry.
 */
import { describe, it, expect } from "vitest"
import { buildPriorFromDraft } from "@/lib/tax/financials-orchestration"
import { buildFinancialDraft, priorEndingCash, type DraftTransaction } from "@/lib/tax/financials-engine"
import { resolveOwnership } from "@/lib/tax/ownership-resolution"

const MEMBERS = resolveOwnership({
  priorK1s: [],
  wizardMembers: [{ name: "Sofia Marinoni", pct: 50 }, { name: "Donato Renato Berini", pct: 50 }],
  accountContacts: [],
})
let id = 0
function tx(p: Partial<DraftTransaction>): DraftTransaction {
  return { id: `t${++id}`, transaction_date: "2024-06-15", description: "", counterparty: null, amount: 0, currency: "USD", category: "expense", subcategory: null, bank_name: "Chase", account_type: "USD", balance_after: null, ...p }
}

describe("cross-year carry — buildPriorFromDraft feeds next year's beginning", () => {
  it("N-1 ending cash + per-member capital become N's beginning (cash + capital)", () => {
    // Corrected 2024: opened 100k, +60k income → ends 160k, 50/50 members.
    const prior = buildFinancialDraft({
      taxYear: 2024, members: MEMBERS.members, priorReturn: null, defaultUncategorizedBySign: true,
      transactions: [tx({ amount: 60000, category: "income" })],
      providedBalances: [{ bank_key: "Chase USD", currency: "USD", opening_balance: 100000, closing_balance: 160000, source: "client" }],
    })
    expect(prior.ending_cash).toBeCloseTo(160000, 2)
    const sofia24 = prior.members.find(m => m.name === "Sofia Marinoni")!.ending_capital

    // Synthesize the prior-return record from the corrected 2024 draft.
    const rec = buildPriorFromDraft(prior, 2024, "2026-01-01T00:00:00Z")
    expect(priorEndingCash(rec)).toBeCloseTo(160000, 2)

    // 2025 reads it: begins from the corrected 2024 close, not a stale figure.
    const y25 = buildFinancialDraft({
      taxYear: 2025, members: MEMBERS.members, priorReturn: rec, defaultUncategorizedBySign: true,
      transactions: [tx({ amount: -1000, category: "expense" })],
    })
    expect(y25.beginning_cash).toBeCloseTo(160000, 2)
    expect(y25.beginning_cash_source).toBe("prior_return")
    expect(y25.members.find(m => m.name === "Sofia Marinoni")!.beginning_capital).toBeCloseTo(sofia24, 2)
    expect(y25.members.find(m => m.name === "Donato Renato Berini")!.beginning_capital).toBeCloseTo(prior.members.find(m => m.name === "Donato Renato Berini")!.ending_capital, 2)
  })
})
