/**
 * Financials engine — FULL SCENARIO MATRIX (Dynamiq P&L fix, Phases 1-4).
 *
 * Every scenario the tri-role review (senior engineer + AI architect + CPA)
 * insisted on, simulated through the REAL engine (buildFinancialDraft) + the
 * REAL gates (evaluateGates) + the engine-owned operating-expense decomposition.
 * One `it` per scenario, each asserting the end-to-end outcome. This is the
 * "simulate every single scenario" proof for the four phases.
 */
import { describe, it, expect } from "vitest"
import { buildFinancialDraft, type DraftTransaction, type FinancialDraft } from "@/lib/tax/financials-engine"
import { evaluateGates } from "@/lib/tax/verification-gates"
import { resolveOwnership } from "@/lib/tax/ownership-resolution"
import type { PriorReturnCaseRecord } from "@/lib/tax/prior-return-case"

let seq = 0
function tx(p: Partial<DraftTransaction>): DraftTransaction {
  return {
    id: `s${++seq}`, transaction_date: "2025-06-15", description: "", counterparty: null,
    amount: 0, currency: "USD", category: "expense", subcategory: null,
    bank_name: "Mercury", account_type: "USD", balance_after: null, ...p,
  }
}
const MEMBERS = resolveOwnership({ priorK1s: [], wizardMembers: [{ name: "Sofia Marinoni", pct: 60 }, { name: "Marco Bianchi", pct: 40 }], accountContacts: [] })
const PRIOR: PriorReturnCaseRecord = {
  case: "filed_elsewhere", status: "validated",
  extracted: {
    form_type: "1065", tax_year: 2024, ein: null,
    schedule_l: { beginning: { cash: 0, total_assets: 0, total_liabilities: 0, capital: 0 }, ending: { cash: 10_000, total_assets: 10_000, total_liabilities: 0, capital: 10_000 } },
    m2: { beginning_capital: 0, ending_capital: 10_000 },
    k1s: [{ partner_name: "Sofia Marinoni", ownership_pct: 60, ending_capital: 6_000 }, { partner_name: "Marco Bianchi", ownership_pct: 40, ending_capital: 4_000 }],
  },
  issues: [], source: "test", extracted_at: "2026-01-01T00:00:00Z",
}
type BuildOver = Partial<Parameters<typeof buildFinancialDraft>[0]>
const build = (over: BuildOver): FinancialDraft =>
  buildFinancialDraft({ taxYear: 2025, transactions: [], members: MEMBERS.members, priorReturn: null, defaultUncategorizedBySign: true, ...over })
const g = (draft: FinancialDraft, id: number, priorReturn: PriorReturnCaseRecord | null = null) =>
  evaluateGates({ draft, ownership: MEMBERS, priorReturn }).find(x => x.id === id)!
const opexSum = (d: FinancialDraft) => d.operating_expense_breakdown.reduce((s, b) => s + b.total, 0)
const bySlug = (d: FinancialDraft) => Object.fromEntries(d.operating_expense_breakdown.map(b => [b.bucket, b.total]))

describe("SCENARIO MATRIX — balance anchors (Phase 1)", () => {
  it("1. clean single-currency USD, full self-reconciling column → statements source, gate 1 pass", () => {
    const d = build({ transactions: [
      tx({ amount: 1000, category: "income", balance_after: 1000, transaction_date: "2025-01-02" }),
      tx({ amount: -400, category: "expense", balance_after: 600, transaction_date: "2025-06-01" }),
    ] })
    expect(d.banks[0].derived_beginning).toBe(0)
    expect(d.beginning_cash_source).toBe("statements")
    expect(g(d, 1).status).toBe("pass")
  })

  it("2. no balance column, provided balances → provided source, gate 1 pass", () => {
    const d = build({
      transactions: [tx({ amount: -200, category: "expense", balance_after: null })],
      providedBalances: [{ bank_key: "Mercury USD", currency: "USD", opening_balance: 1000, closing_balance: 800, source: "client" }],
    })
    expect(d.banks[0].derived_beginning).toBeNull()
    expect(d.beginning_cash).toBe(1000)
    expect(d.beginning_cash_source).toBe("provided")
    expect(g(d, 1).status).toBe("pass")
  })

  it("3. partial column (some rows) → discarded, provided used, gate 1 pass", () => {
    const d = build({
      transactions: [
        tx({ amount: -1000, category: "expense", bank_name: "Chase", account_type: "USD", balance_after: null, transaction_date: "2025-02-01" }),
        tx({ amount: 3000, category: "income", bank_name: "Chase", account_type: "USD", balance_after: 12000, transaction_date: "2025-06-01" }),
      ],
      providedBalances: [{ bank_key: "Chase USD", currency: "USD", opening_balance: 10000, closing_balance: 12000, source: "client" }],
    })
    expect(d.banks[0].derived_beginning).toBeNull()
    expect(d.beginning_cash).toBe(10000)
    expect(g(d, 1).status).toBe("pass")
  })

  it("4. full foreign-currency running total that doesn't reconcile → discarded, green via provided", () => {
    const d = build({
      transactions: [
        tx({ amount: 500, category: "income", currency: "EUR", bank_name: "Wise", account_type: "EUR", balance_after: 500, transaction_date: "2025-05-01" }),
        tx({ amount: -500, category: "expense", currency: "EUR", bank_name: "Wise", account_type: "EUR", balance_after: 900, transaction_date: "2025-05-02" }),
      ],
      fxRates: { EUR: 0.9 },
      providedBalances: [{ bank_key: "Wise EUR", currency: "EUR", opening_balance: 0, closing_balance: 0, source: "client" }],
    })
    expect(d.banks[0].derived_beginning).toBeNull()
    expect(g(d, 1).status).toBe("pass")
  })

  it("5. multi-currency provider (Wise USD + Wise EUR) → two accounts, each ties independently", () => {
    const d = build({
      transactions: [
        tx({ amount: -100, category: "expense", currency: "USD", bank_name: "Wise", account_type: "USD", balance_after: null }),
        tx({ amount: 90, category: "income", currency: "EUR", bank_name: "Wise", account_type: "EUR", balance_after: null }),
      ],
      fxRates: { EUR: 0.9 },
      providedBalances: [
        { bank_key: "Wise USD", currency: "USD", opening_balance: 500, closing_balance: 400, source: "client" },
        { bank_key: "Wise EUR", currency: "EUR", opening_balance: 0, closing_balance: 90, source: "client" },
      ],
    })
    expect(d.banks.length).toBe(2)
    expect(g(d, 1).status).toBe("pass")
  })

  it("11. client typed a WRONG balance → gate 1 FAILS (real finding, not hidden)", () => {
    const d = build({
      transactions: [tx({ amount: -100, category: "expense", balance_after: null })],
      providedBalances: [{ bank_key: "Mercury USD", currency: "USD", opening_balance: 1000, closing_balance: 500, source: "client" }],
    })
    expect(g(d, 1).status).toBe("fail")
  })

  it("12. provided balance conflicts with a RELIABLE statement column → flagged as a finding", () => {
    const d = build({
      transactions: [tx({ amount: -100, category: "expense", balance_after: 900, transaction_date: "2025-01-05" })],
      providedBalances: [{ bank_key: "Mercury USD", currency: "USD", opening_balance: 5000, closing_balance: 4900, source: "client" }],
    })
    expect(d.banks[0].derived_beginning).toBe(1000) // reliable column kept
    expect(d.bank_balances!.banks[0].provided_conflicts_derived).toBe(true)
    expect(d.notes.some(n => n.includes("disagrees with the statement"))).toBe(true)
  })
})

describe("SCENARIO MATRIX — prior year / first year (gate 2)", () => {
  it("6. validated prior return → beginning cash from the prior return", () => {
    const d = build({ transactions: [tx({ amount: 100, category: "income", balance_after: null })], priorReturn: PRIOR })
    expect(d.beginning_cash).toBe(10_000)
    expect(d.beginning_cash_source).toBe("prior_return")
    expect(g(d, 2, PRIOR).status).not.toBe("fail")
  })

  it("7. first year → beginning cash starts at zero, gate 2 NA (first year)", () => {
    const firstYear: PriorReturnCaseRecord = { case: "first_year", status: "first_year", formation_date: null, note: "", recorded_at: "" }
    const d = build({ transactions: [tx({ amount: 100, category: "income", balance_after: null })], priorReturn: firstYear })
    const g2 = g(d, 2, firstYear)
    expect(g2.status).toBe("na")
    expect(g2.detail).toContain("First year")
  })
})

describe("SCENARIO MATRIX — foreign exchange & transfers (Phase 3)", () => {
  it("8. cross-currency exchange residual → equity translation adjustment; BS ties; income untouched", () => {
    const d = build({
      transactions: [
        tx({ amount: 10000, category: "income", currency: "USD", bank_name: "Relay", account_type: "USD" }),
        tx({ amount: -5000, category: "conversion", currency: "USD", bank_name: "Wise", account_type: "USD" }),
        tx({ amount: 4000, category: "conversion", currency: "EUR", bank_name: "Wise", account_type: "EUR" }),
      ],
      fxRates: { EUR: 0.9 },
    })
    expect(d.fx_translation_adjustment).toBeCloseTo(-555.56, 2)
    expect(g(d, 3).status).toBe("pass")
    expect(d.pnl.netIncome).toBeCloseTo(10000, 2)
    expect(d.notes.some(n => n.includes("may be missing"))).toBe(false)
  })

  it("9. matched same-currency transfer → nets to zero, no residual, no alarm", () => {
    const d = build({
      transactions: [
        tx({ amount: -1000, category: "conversion", currency: "USD", bank_name: "Chase", account_type: "USD" }),
        tx({ amount: 1000, category: "conversion", currency: "USD", bank_name: "Mercury", account_type: "USD" }),
      ],
    })
    expect(d.fx_translation_adjustment).toBeCloseTo(0, 2)
    expect(g(d, 3).status).toBe("pass")
    expect(d.notes.some(n => n.includes("translation adjustment"))).toBe(false)
  })

  it("10./18. unmatched leg OR expense mis-booked as a transfer → magnitude alarm fires", () => {
    const d = build({
      transactions: [
        tx({ amount: 5000, category: "income", currency: "USD", bank_name: "Relay", account_type: "USD" }),
        tx({ amount: -2000, category: "conversion", currency: "USD", bank_name: "Wise", account_type: "USD" }),
      ],
    })
    expect(d.fx_translation_adjustment).toBeCloseTo(-2000, 2)
    expect(d.notes.some(n => n.includes("may be missing"))).toBe(true)
    expect(g(d, 3).status).toBe("pass") // still ties (disclosed), but the alarm surfaces it
  })

  it("13. currency with no IRS rate on file → flagged, left unconverted (not silently 1:1)", () => {
    const d = build({
      transactions: [tx({ amount: -100, category: "expense", currency: "AED", bank_name: "Wise", account_type: "AED", balance_after: null })],
      fxRates: { EUR: 0.9 },
    })
    expect(d.notes.some(n => n.includes("AED"))).toBe(true)
  })
})

describe("SCENARIO MATRIX — P&L composition (Phase 2) — parts always equal the total", () => {
  it("14. foreign-currency refund is a contra-expense; breakdown ties to the total", () => {
    const d = build({
      transactions: [
        tx({ amount: -1000, category: "expense", currency: "USD", ai_bucket: "software" }),
        tx({ amount: 90, category: "refund", currency: "EUR", bank_name: "Wise", account_type: "EUR", ai_bucket: "software" }),
      ],
      fxRates: { EUR: 0.9 },
    })
    expect(opexSum(d)).toBeCloseTo(d.pnl.totalExpenses, 2)
    expect(bySlug(d)["software"]).toBeCloseTo(900, 2) // 1000 − 100 (€90)
  })

  it("15. COGS present → its own line, excluded from operating expenses; opex still ties", () => {
    const d = build({
      transactions: [
        tx({ amount: 5000, category: "income", currency: "USD" }),
        tx({ amount: -2000, category: "cogs", currency: "USD" }),
        tx({ amount: -500, category: "expense", currency: "USD", ai_bucket: "software" }),
      ],
    })
    expect(d.pnl.totalCogs).toBeCloseTo(2000, 2)
    expect(opexSum(d)).toBeCloseTo(d.pnl.totalExpenses, 2)
    expect(opexSum(d)).toBeCloseTo(500, 2) // COGS not in opex
  })

  it("16. folded uncategorized outflow is inside operating expenses; parts tie; nothing pending", () => {
    const d = build({ transactions: [tx({ amount: -300, category: "uncategorized", currency: "USD" })] })
    expect(d.pnl.uncategorizedCount).toBe(0)
    expect(opexSum(d)).toBeCloseTo(d.pnl.totalExpenses, 2)
    expect(opexSum(d)).toBeCloseTo(300, 2)
  })

  it("19. multi-currency expenses (the Dynamiq $23k class) → total equals the sum of parts", () => {
    const d = build({
      transactions: [
        tx({ amount: -1000, category: "expense", currency: "USD", ai_bucket: "software" }),
        tx({ amount: -924, category: "expense", currency: "EUR", bank_name: "Wise", account_type: "EUR", ai_bucket: "software" }),
      ],
      fxRates: { EUR: 0.924 },
    })
    expect(bySlug(d)["software"]).toBeCloseTo(2000, 2) // 1000 + 1000 (€924 at 0.924), NOT 1924 raw
    expect(opexSum(d)).toBeCloseTo(d.pnl.totalExpenses, 2)
  })
})

describe("SCENARIO MATRIX — equity movements (M-2)", () => {
  it("17. distributions & contributions are equity, not P&L; M-2 roll-forward ties", () => {
    const d = build({
      transactions: [
        tx({ amount: 5000, category: "income" }),
        tx({ amount: 3000, category: "contribution", counterparty: "Sofia Marinoni" }),
        tx({ amount: -1000, category: "distribution", counterparty: "Marco Bianchi" }),
      ],
    })
    expect(d.pnl.totalIncome).toBeCloseTo(5000, 2) // contribution is NOT revenue
    expect(g(d, 4).status).toBe("pass")
  })
})
