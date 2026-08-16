import { describe, it, expect } from "vitest"
import { buildFinancialDraft, type DraftTransaction } from "@/lib/tax/financials-engine"
import { evaluateGates } from "@/lib/tax/verification-gates"
import { resolveOwnership } from "@/lib/tax/ownership-resolution"
import { buildCarriedForwardRecord, buildStaffCorrectionRecord, type CarryPayload } from "@/lib/tax/prior-return-case"

let id = 0
function tx(p: Partial<DraftTransaction>): DraftTransaction {
  return {
    id: `g${++id}`, transaction_date: "2025-06-15", description: "", counterparty: null,
    amount: 0, currency: "USD", category: "expense", subcategory: null,
    bank_name: "Mercury", account_type: "Checking", balance_after: null, ...p,
  }
}

const TWO_MEMBERS = resolveOwnership({
  priorK1s: [],
  wizardMembers: [{ name: "Sofia Marinoni", pct: 50 }, { name: "Donato Renato Berini", pct: 50 }],
  accountContacts: [],
})

const carryPayload = (over: Partial<CarryPayload> = {}): CarryPayload => ({
  beginning_cash: 391863.70,
  beginning_cta: 0,
  members: [
    { contact_id: null, name: "Sofia Marinoni", beginning_capital: 216862.38 },
    { contact_id: null, name: "Donato Renato Berini", beginning_capital: 216862.38 },
  ],
  unresolved_members: [],
  ...over,
})

describe("gate 7 — capital account continuity (dev_task d909e086)", () => {
  it("na when beginning capital did NOT come from a prior-year return (first-year / no-prior-data client) — never false-flags this", () => {
    const draft = buildFinancialDraft({ taxYear: 2025, transactions: [tx({ amount: 1000, category: "income" })], members: TWO_MEMBERS.members, priorReturn: null, defaultUncategorizedBySign: true })
    expect(draft.beginning_cash_source).toBeNull() // no statements/provided/prior — genuinely nothing
    const gates = evaluateGates({ draft, ownership: TWO_MEMBERS, priorReturn: null })
    expect(gates.find(g => g.id === 7)!.status).toBe("na")
  })

  it("na when beginning cash came from statement openings, not a prior return — the OTHER branch with no 'match' concept", () => {
    const draft = buildFinancialDraft({
      taxYear: 2025,
      transactions: [tx({ amount: 500, category: "income", balance_after: 1500 }), tx({ amount: -1000, category: "expense", balance_after: 1000, transaction_date: "2025-01-01" })],
      members: TWO_MEMBERS.members, priorReturn: null, defaultUncategorizedBySign: true,
    })
    if (draft.beginning_cash_source === "prior_return") throw new Error("test setup: expected a statements-derived beginning, got prior_return")
    const gates = evaluateGates({ draft, ownership: TWO_MEMBERS, priorReturn: null })
    expect(gates.find(g => g.id === 7)!.status).toBe("na")
  })

  it("pass when beginning capital came from a validated carried_forward record and every current member matches its k1s by name", () => {
    const prior = buildCarriedForwardRecord(carryPayload(), 2024, "2026-08-14T00:00:00Z")
    const draft = buildFinancialDraft({ taxYear: 2025, transactions: [tx({ amount: 100, category: "income" })], members: TWO_MEMBERS.members, priorReturn: prior, defaultUncategorizedBySign: true })
    expect(draft.beginning_cash_source).toBe("prior_return")
    const gates = evaluateGates({ draft, ownership: TWO_MEMBERS, priorReturn: prior })
    const g7 = gates.find(g => g.id === 7)!
    expect(g7.status).toBe("pass")
  })

  it("fail when a currently-active member has no matching k1 — names them, never silently passes over the 0-fallback", () => {
    const prior = buildStaffCorrectionRecord(carryPayload({
      members: [{ contact_id: null, name: "Sofia Marinoni", beginning_capital: 216862.38 }], // Donato missing
    }), 2024, "staff@x", "2026-08-14T00:00:00Z")
    const draft = buildFinancialDraft({ taxYear: 2025, transactions: [tx({ amount: 100, category: "income" })], members: TWO_MEMBERS.members, priorReturn: prior, defaultUncategorizedBySign: true })
    const gates = evaluateGates({ draft, ownership: TWO_MEMBERS, priorReturn: prior })
    const g7 = gates.find(g => g.id === 7)!
    expect(g7.status).toBe("fail")
    expect(g7.detail).toContain("Donato Renato Berini")
    expect(g7.detail).not.toContain("Sofia Marinoni") // only the genuinely unmatched member is named
  })

  it("round-4 bug-hunter major: still checks when the prior return's CASH is unreadable but its K-1s are real — beginning_cash_source lands null (not 'prior_return'), yet member capital still silently resolves from the same extraction", () => {
    const prior = buildStaffCorrectionRecord(carryPayload(), 2024, "staff@x", "z")
    if (prior.case !== "staff_corrected") throw new Error("narrowing")
    prior.extracted.schedule_l!.ending.cash = null // the field priorEndingCash reads — capital reads a DIFFERENT field (k1s) independently
    const draft = buildFinancialDraft({ taxYear: 2025, transactions: [tx({ amount: 100, category: "income" })], members: TWO_MEMBERS.members, priorReturn: prior, defaultUncategorizedBySign: true })
    expect(draft.beginning_cash_source).toBeNull() // confirms the gap's premise: NOT "prior_return"
    expect(draft.members.find(m => m.name === "Sofia Marinoni")?.beginning_capital).toBeCloseTo(216862.38, 2) // capital still resolved
    const gates = evaluateGates({ draft, ownership: TWO_MEMBERS, priorReturn: prior })
    expect(gates.find(g => g.id === 7)!.status).toBe("pass") // gate 7 must still CHECK, not silently report na
  })

  it("also catches the pre-existing zero-K1s bug (dev_task fdec1847) as a side effect — an empty k1s array fails every member identically", () => {
    const prior = buildStaffCorrectionRecord(carryPayload({ members: [] }), 2024, "staff@x", "z")
    const draft = buildFinancialDraft({ taxYear: 2025, transactions: [tx({ amount: 100, category: "income" })], members: TWO_MEMBERS.members, priorReturn: prior, defaultUncategorizedBySign: true })
    const gates = evaluateGates({ draft, ownership: TWO_MEMBERS, priorReturn: prior })
    const g7 = gates.find(g => g.id === 7)!
    expect(g7.status).toBe("fail")
    expect(g7.detail).toContain("Sofia Marinoni")
    expect(g7.detail).toContain("Donato Renato Berini")
  })
})

describe("gate 2 — honest wording for carried_forward / staff_corrected (round-2/3 bug-hunter finding)", () => {
  it("carried_forward that ties: distinct message, never the generic 'Last year's return shows...' (which would misrepresent a computed figure as a filed one)", () => {
    const prior = buildCarriedForwardRecord(carryPayload(), 2024, "z")
    const banks = [{ key: "Mercury USD", ccy: "USD", open: 391863.70, close: 391863.70 }]
    const txs = banks.flatMap(() => [])
    const providedBalances = banks.map(b => ({ bank_key: b.key, currency: b.ccy, opening_balance: b.open, closing_balance: b.close, source: "client" as const }))
    const draft = buildFinancialDraft({ taxYear: 2025, transactions: txs as DraftTransaction[], members: TWO_MEMBERS.members, priorReturn: prior, defaultUncategorizedBySign: true, providedBalances })
    const gates = evaluateGates({ draft, ownership: TWO_MEMBERS, priorReturn: prior })
    const g2 = gates.find(g => g.id === 2)!
    expect(g2.detail).toContain("carried from our own corrected")
    expect(g2.detail).not.toContain("Last year's return shows")
  })

  it("staff_corrected: its own distinct wording, not carried_forward's and not the generic branch's", () => {
    const prior = buildStaffCorrectionRecord(carryPayload(), 2024, "staff@x", "z")
    const draft = buildFinancialDraft({ taxYear: 2025, transactions: [], members: TWO_MEMBERS.members, priorReturn: prior, defaultUncategorizedBySign: true })
    const gates = evaluateGates({ draft, ownership: TWO_MEMBERS, priorReturn: prior })
    const g2 = gates.find(g => g.id === 2)!
    expect(g2.detail).toContain("entered by staff")
  })
})
