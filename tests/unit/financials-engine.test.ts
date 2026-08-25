import { describe, it, expect } from "vitest"
import { buildFinancialDraft, attributeToMember, priorEndingCash, type DraftTransaction } from "@/lib/tax/financials-engine"
import { evaluateGates, canConfirm } from "@/lib/tax/verification-gates"
import { resolveOwnership } from "@/lib/tax/ownership-resolution"
import type { PriorReturnCaseRecord } from "@/lib/tax/prior-return-case"

let id = 0
function tx(p: Partial<DraftTransaction>): DraftTransaction {
  return {
    id: `t${++id}`, transaction_date: "2025-06-15", description: "", counterparty: null,
    amount: 0, currency: "USD", category: "expense", subcategory: null,
    bank_name: "Mercury", account_type: "Checking", balance_after: null, ...p,
  }
}

const MEMBERS = resolveOwnership({
  priorK1s: [],
  wizardMembers: [{ name: "Sofia Marinoni", pct: 60 }, { name: "Marco Bianchi", pct: 40 }],
  accountContacts: [],
})

/** Validated prior return: ending cash 10k, capital 10k (Sofia 6k / Marco 4k). */
const PRIOR: PriorReturnCaseRecord = {
  case: "filed_elsewhere",
  status: "validated",
  extracted: {
    form_type: "1065", tax_year: 2024, ein: null,
    schedule_l: {
      beginning: { cash: 0, total_assets: 0, total_liabilities: 0, capital: 0 },
      ending: { cash: 10_000, total_assets: 10_000, total_liabilities: 0, capital: 10_000 },
    },
    m2: { beginning_capital: 0, ending_capital: 10_000 },
    k1s: [
      { partner_name: "Sofia Marinoni", ownership_pct: 60, ending_capital: 6_000 },
      { partner_name: "Marco Bianchi", ownership_pct: 40, ending_capital: 4_000 },
    ],
  },
  issues: [], source: "test", extracted_at: "2026-01-01T00:00:00Z",
}

describe("attributeToMember", () => {
  it("matches exact, embedded, and normalized names; null otherwise", () => {
    expect(attributeToMember("Sofia Marinoni", MEMBERS.members)?.name).toBe("Sofia Marinoni")
    expect(attributeToMember("Wire to SOFIA MARINONI — owner draw", MEMBERS.members)?.name).toBe("Sofia Marinoni")
    expect(attributeToMember("STRIPE", MEMBERS.members)).toBeNull()
    expect(attributeToMember(null, MEMBERS.members)).toBeNull()
  })
})

describe("buildFinancialDraft + evaluateGates — coherent year", () => {
  // Year: revenue 50k in, expenses 20k out, Sofia contributes 5k, Marco takes 8k distribution.
  // Cash: 10k + 50k − 20k + 5k − 8k = 37k. Net income 30k.
  // Capital: 10k + 5k + 30k − 8k = 37k → A = L + C ties.
  const transactions: DraftTransaction[] = [
    tx({ amount: 50_000, category: "income", subcategory: "revenue", balance_after: 60_000 }),
    tx({ amount: -20_000, category: "expense", balance_after: 40_000, transaction_date: "2025-07-01" }),
    tx({ amount: 5_000, category: "contribution", counterparty: "Sofia Marinoni", balance_after: 45_000, transaction_date: "2025-08-01" }),
    tx({ amount: -8_000, category: "distribution", counterparty: "Marco Bianchi", balance_after: 37_000, transaction_date: "2025-09-01" }),
  ]

  const draft = buildFinancialDraft({ taxYear: 2025, transactions, members: MEMBERS.members, priorReturn: PRIOR })
  const gates = evaluateGates({ draft, ownership: MEMBERS, priorReturn: PRIOR })

  it("computes the P&L and cash correctly", () => {
    expect(draft.pnl.netIncome).toBe(30_000)
    expect(draft.beginning_cash).toBe(10_000)
    expect(draft.ending_cash).toBe(37_000)
  })

  it("rolls capital forward per member from prior K-1 beginning capital", () => {
    const sofia = draft.members.find(m => m.name === "Sofia Marinoni")!
    const marco = draft.members.find(m => m.name === "Marco Bianchi")!
    expect(sofia.beginning_capital).toBe(6_000)
    expect(sofia.contributions).toBe(5_000)
    expect(sofia.income_share).toBe(18_000)
    expect(sofia.ending_capital).toBe(29_000)
    expect(marco.ending_capital).toBe(4_000 + 12_000 - 8_000) // 8_000
    expect(draft.ending_capital_total).toBe(37_000)
  })

  it("all seven gates pass and confirm is allowed", () => {
    expect(gates.map(g => `${g.id}:${g.status}`)).toEqual(["1:pass", "2:pass", "3:pass", "4:pass", "5:pass", "6:pass", "7:pass"])
    expect(canConfirm(gates)).toBe(true)
  })
})

describe("we_filed auto-carry-forward reads identically to a client upload", () => {
  // Same numbers as PRIOR, but sourced from OUR own filed return (we_filed/validated).
  const WE_FILED: PriorReturnCaseRecord = {
    case: "we_filed", status: "validated", tax_return_id: "tr-1",
    note: "read from our filed return", recorded_at: "2026-01-01T00:00:00Z",
    extracted: PRIOR.case === "filed_elsewhere" ? PRIOR.extracted : (undefined as never),
    issues: [], source: "drive:abc",
  }
  const transactions: DraftTransaction[] = [
    tx({ amount: 50_000, category: "income", subcategory: "revenue", balance_after: 60_000 }),
    tx({ amount: -20_000, category: "expense", balance_after: 40_000, transaction_date: "2025-07-01" }),
    tx({ amount: 5_000, category: "contribution", counterparty: "Sofia Marinoni", balance_after: 45_000, transaction_date: "2025-08-01" }),
    tx({ amount: -8_000, category: "distribution", counterparty: "Marco Bianchi", balance_after: 37_000, transaction_date: "2025-09-01" }),
  ]
  const draft = buildFinancialDraft({ taxYear: 2025, transactions, members: MEMBERS.members, priorReturn: WE_FILED })
  const gates = evaluateGates({ draft, ownership: MEMBERS, priorReturn: WE_FILED })

  it("feeds beginning cash + per-member beginning capital from our filed return", () => {
    expect(priorEndingCash(WE_FILED)).toBe(10_000)
    expect(draft.beginning_cash).toBe(10_000)
    expect(draft.beginning_cash_source).toBe("prior_return")
    expect(draft.members.find(m => m.name === "Sofia Marinoni")!.beginning_capital).toBe(6_000)
  })

  it("gate 2 ties out (not 'staff tie out') and all gates pass", () => {
    expect(gates.find(g => g.id === 2)!.status).toBe("pass")
    expect(canConfirm(gates)).toBe(true)
  })
})

describe("we_filed non-validated statuses keep staff tie-out / mismatch wording", () => {
  const transactions = [tx({ amount: 100, category: "income", balance_after: 100 })]
  const make = (status: "on_file" | "claim_mismatch") =>
    ({ case: "we_filed", status, tax_return_id: status === "on_file" ? "t" : null, note: "", recorded_at: "" }) as PriorReturnCaseRecord

  it("on_file → NA, staff tie out (no auto numbers)", () => {
    const prior = make("on_file")
    const draft = buildFinancialDraft({ taxYear: 2025, transactions, members: MEMBERS.members, priorReturn: prior })
    expect(priorEndingCash(prior)).toBeNull()
    expect(draft.beginning_cash_source).not.toBe("prior_return")
    const g2 = evaluateGates({ draft, ownership: MEMBERS, priorReturn: prior }).find(g => g.id === 2)!
    expect(g2.status).toBe("na")
    expect(g2.detail).toContain("staff tie out")
  })

  it("claim_mismatch → fail (we have no record)", () => {
    const prior = make("claim_mismatch")
    const draft = buildFinancialDraft({ taxYear: 2025, transactions, members: MEMBERS.members, priorReturn: prior })
    const g2 = evaluateGates({ draft, ownership: MEMBERS, priorReturn: prior }).find(g => g.id === 2)!
    expect(g2.status).toBe("fail")
  })
})

describe("gate failure modes", () => {
  // Rewritten 2026-08-03. Gate 6 used to be HARD and to read only
  // `uncategorizedCount` — which the CLIENT draft forces to zero — so on the
  // portal it could never fail: it printed "All transactions are categorized"
  // beside a queue of 394 unanswered items whose suggested amounts were already
  // in the client's P&L. Now it reports the real number and does NOT block
  // (Antonio, verbatim: "someone should be able to confirm their accounts while
  // items are still unanswered, we just suggest but they know the truth").
  it("gate 6 reports uncategorized WITHOUT blocking confirm (folding off — staff workspace)", () => {
    const transactions = [tx({ amount: -100, category: "uncategorized" })]
    const draft = buildFinancialDraft({ taxYear: 2025, transactions, members: MEMBERS.members, priorReturn: null })
    const gates = evaluateGates({ draft, ownership: MEMBERS, priorReturn: null })
    const g6 = gates.find(g => g.id === 6)!
    expect(g6.status).toBe("fail")
    expect(g6.detail).toContain("1 transaction(s)")
    expect(g6.blocking).toBe(false)
    expect(canConfirm(gates)).toBe(true)
  })

  // THE REGRESSION THAT SHIPPED TO CLIENTS: with the by-sign policy on (every
  // client portal draft) the row is folded into expenses and uncategorizedCount
  // is forced to 0. Gate 6 must STILL name it — reading uncategorizedCount
  // alone is what made the screen lie. If someone reverts gate 6 to that field,
  // this test goes red.
  it("gate 6 still names undecided rows when the client draft folds them in (by-sign policy)", () => {
    const transactions = [tx({ amount: -100, category: "uncategorized" })]
    const draft = buildFinancialDraft({
      taxYear: 2025, transactions, members: MEMBERS.members, priorReturn: null,
      defaultUncategorizedBySign: true,
    })
    // Precondition: the policy really did hide it from the old field.
    expect(draft.pnl.uncategorizedCount).toBe(0)
    expect(draft.pnl.foldedUncategorizedCount).toBe(1)
    const gates = evaluateGates({ draft, ownership: MEMBERS, priorReturn: null })
    const g6 = gates.find(g => g.id === 6)!
    expect(g6.status).toBe("fail")
    expect(g6.detail).toContain("1 transaction(s)")
    expect(g6.detail).not.toContain("All transactions are categorized")
    // ...and confirm is still available — honesty, not a barrier.
    expect(g6.blocking).toBe(false)
    expect(canConfirm(gates)).toBe(true)
  })

  it("gate 6 passes only when NOTHING is pending under either policy", () => {
    const transactions = [tx({ amount: -100, category: "expense" })]
    for (const defaultUncategorizedBySign of [false, true]) {
      const draft = buildFinancialDraft({
        taxYear: 2025, transactions, members: MEMBERS.members, priorReturn: null,
        defaultUncategorizedBySign,
      })
      const g6 = evaluateGates({ draft, ownership: MEMBERS, priorReturn: null }).find(g => g.id === 6)!
      expect(g6.status).toBe("pass")
    }
  })

  it("gate 2 fails when prior ending cash does not match derived beginnings (missing January)", () => {
    // Statement-derived beginning = 12_000 (first balance 11_900 on a −100 tx), prior says 10_000.
    const transactions = [tx({ amount: -100, category: "expense", balance_after: 11_900 })]
    const draft = buildFinancialDraft({ taxYear: 2025, transactions, members: MEMBERS.members, priorReturn: PRIOR })
    const gates = evaluateGates({ draft, ownership: MEMBERS, priorReturn: PRIOR })
    expect(gates.find(g => g.id === 2)!.status).toBe("fail")
    expect(gates.find(g => g.id === 2)!.detail).toContain("isn't included this year")
  })

  it("gate 2 is NA-with-reason for first year and for declared never-filed", () => {
    const firstYear: PriorReturnCaseRecord = { case: "first_year", status: "first_year", formation_date: "2025-02-01", note: "", recorded_at: "" }
    const transactions = [tx({ amount: 100, category: "income" })]
    const draft = buildFinancialDraft({ taxYear: 2025, transactions, members: MEMBERS.members, priorReturn: firstYear })
    const gates = evaluateGates({ draft, ownership: MEMBERS, priorReturn: firstYear })
    expect(gates.find(g => g.id === 2)!.status).toBe("na")
    expect(gates.find(g => g.id === 2)!.detail).toContain("First year")
  })

  it("gate 2 fails on a quarantined prior return (staff reviewing)", () => {
    const quarantined: PriorReturnCaseRecord = {
      case: "filed_elsewhere", status: "quarantined",
      extracted: { form_type: "1065", tax_year: 2024, ein: null, schedule_l: null, m2: null, k1s: [] },
      issues: [{ code: "NO_SCHEDULE_L", message: "x" }], source: "t", extracted_at: "",
    }
    const transactions = [tx({ amount: 100, category: "income" })]
    const draft = buildFinancialDraft({ taxYear: 2025, transactions, members: MEMBERS.members, priorReturn: quarantined })
    const gates = evaluateGates({ draft, ownership: MEMBERS, priorReturn: quarantined })
    expect(gates.find(g => g.id === 2)!.status).toBe("fail")
  })

  it("gate 1 is NA when CSVs carry no balance column", () => {
    const transactions = [tx({ amount: 100, category: "income", balance_after: null })]
    const draft = buildFinancialDraft({ taxYear: 2025, transactions, members: MEMBERS.members, priorReturn: null })
    const gates = evaluateGates({ draft, ownership: MEMBERS, priorReturn: null })
    expect(gates.find(g => g.id === 1)!.status).toBe("na")
  })

  it("discards a full-coverage running-balance column that does not reconcile (no provided balances) → gate 1 NA, no false alarm", () => {
    const transactions = [
      tx({ amount: -100, category: "expense", balance_after: 900, transaction_date: "2025-01-05" }),
      // a later balance that does not follow from the movements (ordering/format artifact or a real gap):
      tx({ amount: -50, category: "expense", balance_after: 500, transaction_date: "2025-11-30" }),
    ]
    const draft = buildFinancialDraft({ taxYear: 2025, transactions, members: MEMBERS.members, priorReturn: null })
    // The unreliable column is NOT used as an anchor (Dynamiq fix)…
    expect(draft.banks[0].derived_beginning).toBeNull()
    expect(draft.banks[0].reported_ending).toBeNull()
    expect(draft.notes.join(" ")).toContain("did not reconcile")
    // …and with no provided balances there is nothing to reconcile against → NA, not a false "re-export" alarm.
    const gates = evaluateGates({ draft, ownership: MEMBERS, priorReturn: null })
    expect(gates.find(g => g.id === 1)!.status).toBe("na")
  })

  it("gate 1 FAILS when the client's provided opening+closing do not tie to the movements", () => {
    const transactions = [
      tx({ amount: -100, category: "expense", balance_after: null, transaction_date: "2025-01-05" }),
      tx({ amount: -50, category: "expense", balance_after: null, transaction_date: "2025-11-30" }),
    ]
    // Client says opened 1000, closed 500, but −150 of movements ⇒ closing should be 850.
    const draft = buildFinancialDraft({
      taxYear: 2025, transactions, members: MEMBERS.members, priorReturn: null,
      providedBalances: [{ bank_key: "Mercury Checking", currency: "USD", opening_balance: 1000, closing_balance: 500, source: "client" }],
    })
    const gates = evaluateGates({ draft, ownership: MEMBERS, priorReturn: null })
    expect(gates.find(g => g.id === 1)!.status).toBe("fail")
  })

  it("gate 5 fails when ownership is unresolved; gate 4 NA without members", () => {
    const noMembers = resolveOwnership({ priorK1s: [], wizardMembers: [{ name: "A B", pct: null }], accountContacts: [] })
    const transactions = [tx({ amount: 100, category: "income" })]
    const draft = buildFinancialDraft({ taxYear: 2025, transactions, members: noMembers.members, priorReturn: null })
    const gates = evaluateGates({ draft, ownership: noMembers, priorReturn: null })
    expect(gates.find(g => g.id === 5)!.status).toBe("fail")
    expect(gates.find(g => g.id === 5)!.detail).toContain("A B")
    expect(gates.find(g => g.id === 4)!.status).toBe("na")
  })
})

describe("unattributed owner movements", () => {
  it("spreads by ownership % so M-2 still ties, and notes the gap", () => {
    const transactions: DraftTransaction[] = [
      tx({ amount: 10_000, category: "contribution", counterparty: "TOP UP" }), // matches nobody
    ]
    const draft = buildFinancialDraft({ taxYear: 2025, transactions, members: MEMBERS.members, priorReturn: null })
    expect(draft.unattributed.contributions).toBe(10_000)
    expect(draft.members.find(m => m.name === "Sofia Marinoni")!.contributions).toBe(6_000)
    expect(draft.members.find(m => m.name === "Marco Bianchi")!.contributions).toBe(4_000)
    expect(draft.notes.join(" ")).toContain("confirm with the client")
    const gates = evaluateGates({ draft, ownership: MEMBERS, priorReturn: null })
    expect(gates.find(g => g.id === 4)!.status).toBe("pass")
  })
})

describe("Phase 1 — balance-anchor reliability (Dynamiq fix)", () => {
  it("ignores a PARTIAL running-balance column and uses the client's provided balances; reconciles green", () => {
    // Chase-like: several rows, only some carry a balance; provided opening/closing are correct.
    const transactions = [
      tx({ amount: -1000, category: "expense", bank_name: "Chase", account_type: "USD", balance_after: null, transaction_date: "2025-02-01" }),
      tx({ amount: 3000, category: "income", bank_name: "Chase", account_type: "USD", balance_after: 12000, transaction_date: "2025-06-01" }),
      tx({ amount: -500, category: "expense", bank_name: "Chase", account_type: "USD", balance_after: null, transaction_date: "2025-09-01" }),
    ]
    // net movement = -1000 + 3000 - 500 = 1500; client opened 10000, closed 11500.
    const draft = buildFinancialDraft({
      taxYear: 2025, transactions, members: MEMBERS.members, priorReturn: null,
      providedBalances: [{ bank_key: "Chase USD", currency: "USD", opening_balance: 10000, closing_balance: 11500, source: "client" }],
    })
    expect(draft.banks[0].derived_beginning).toBeNull() // partial column discarded
    expect(draft.beginning_cash).toBe(10000)            // from provided, not the column
    expect(draft.beginning_cash_source).toBe("provided")
    const gates = evaluateGates({ draft, ownership: MEMBERS, priorReturn: null })
    expect(gates.find(g => g.id === 1)!.status).toBe("pass")
  })

  it("keeps a FULL, self-reconciling column as the anchor (statements source)", () => {
    const transactions = [
      tx({ amount: -100, category: "expense", bank_name: "Relay", account_type: "USD", balance_after: 900, transaction_date: "2025-03-01" }),
      tx({ amount: 400, category: "income", bank_name: "Relay", account_type: "USD", balance_after: 1300, transaction_date: "2025-04-01" }),
    ]
    // opening = 900 − (−100) = 1000; movements +300; ending 1300 ✓ reconciles
    const draft = buildFinancialDraft({ taxYear: 2025, transactions, members: MEMBERS.members, priorReturn: null })
    expect(draft.banks[0].derived_beginning).toBe(1000)
    expect(draft.banks[0].reported_ending).toBe(1300)
    expect(draft.beginning_cash_source).toBe("statements")
    expect(evaluateGates({ draft, ownership: MEMBERS, priorReturn: null }).find(g => g.id === 1)!.status).toBe("pass")
  })

  it("discards an out-of-order foreign-currency running total but stays green via provided balances (Wise EUR)", () => {
    // Wise EUR: full coverage, but the running total does not walk in date order → not reliable.
    const transactions = [
      tx({ amount: 500, category: "income", currency: "EUR", bank_name: "Wise", account_type: "EUR", balance_after: 500, transaction_date: "2025-05-01" }),
      tx({ amount: -500, category: "expense", currency: "EUR", bank_name: "Wise", account_type: "EUR", balance_after: 900, transaction_date: "2025-05-02" }),
    ]
    // Native chain does not reconcile (500-(-? )); client provided EUR opening 0 / closing 0.
    const draft = buildFinancialDraft({
      taxYear: 2025, transactions, members: MEMBERS.members, priorReturn: null, fxRates: { EUR: 0.9 },
      providedBalances: [{ bank_key: "Wise EUR", currency: "EUR", opening_balance: 0, closing_balance: 0, source: "client" }],
    })
    expect(draft.banks[0].derived_beginning).toBeNull()
    const g1 = evaluateGates({ draft, ownership: MEMBERS, priorReturn: null }).find(g => g.id === 1)!
    expect(g1.status).toBe("pass")
  })
})

describe("Phase 2 — operating-expense breakdown (parts == total, USD basis)", () => {
  it("sums to pnl.totalExpenses on the converted, refund-netted basis (multi-currency)", () => {
    const txs = [
      tx({ amount: -1000, category: "expense", currency: "USD", ai_bucket: "software" }),
      tx({ amount: -92.4, category: "expense", currency: "EUR", bank_name: "Wise", account_type: "EUR", ai_bucket: "software" }), // €92.4 / 0.924 = $100
      tx({ amount: -50, category: "fee", currency: "USD", ai_bucket: "bank_fee" }),
      tx({ amount: 30, category: "refund", currency: "USD", ai_bucket: "software" }), // contra-expense
      tx({ amount: 500, category: "income", currency: "USD" }), // not opex
    ]
    const draft = buildFinancialDraft({ taxYear: 2025, transactions: txs, members: MEMBERS.members, priorReturn: null, defaultUncategorizedBySign: true, fxRates: { EUR: 0.924 } })
    const sum = draft.operating_expense_breakdown.reduce((s, b) => s + b.total, 0)
    expect(sum).toBeCloseTo(draft.pnl.totalExpenses, 2)
    const bySlug = Object.fromEntries(draft.operating_expense_breakdown.map(b => [b.bucket, b.total]))
    expect(bySlug["software"]).toBeCloseTo(1070, 2) // 1000 + 100 (from EUR) − 30 refund
    expect(bySlug["bank_fee"]).toBeCloseTo(50, 2)
    expect(draft.notes.some(n => n.includes("Internal check"))).toBe(false)
  })

  it("folds rows with no ai_bucket into 'other' and still ties", () => {
    const txs = [
      tx({ amount: -200, category: "expense", currency: "USD" }),        // no ai_bucket → other
      tx({ amount: -800, category: "uncategorized", currency: "USD" }),  // folded outflow → other
    ]
    const draft = buildFinancialDraft({ taxYear: 2025, transactions: txs, members: MEMBERS.members, priorReturn: null, defaultUncategorizedBySign: true })
    const sum = draft.operating_expense_breakdown.reduce((s, b) => s + b.total, 0)
    expect(sum).toBeCloseTo(draft.pnl.totalExpenses, 2)
    expect(draft.operating_expense_breakdown.find(b => b.bucket === "other")!.total).toBeCloseTo(1000, 2)
  })
})

describe("Phase 3 — foreign-exchange translation adjustment (balance sheet ties honestly)", () => {
  it("records the conversion residual in equity; BS ties; net income & member capital untouched", () => {
    const txs = [
      tx({ amount: 10000, category: "income", currency: "USD", bank_name: "Relay", account_type: "USD" }),
      // Cross-currency exchange with a spot-vs-average residual: send $5000, receive €4000 (=$4444.44 at 0.9).
      tx({ amount: -5000, category: "conversion", currency: "USD", bank_name: "Wise", account_type: "USD" }),
      tx({ amount: 4000, category: "conversion", currency: "EUR", bank_name: "Wise", account_type: "EUR" }),
    ]
    const draft = buildFinancialDraft({ taxYear: 2025, transactions: txs, members: MEMBERS.members, priorReturn: null, defaultUncategorizedBySign: true, fxRates: { EUR: 0.9 } })
    expect(draft.fx_translation_adjustment).toBeCloseTo(-555.56, 2) // −5000 + 4444.44
    // Balance sheet ties WITH the adjustment (would have been "off by 555.56" before).
    const g3 = evaluateGates({ draft, ownership: MEMBERS, priorReturn: null }).find(g => g.id === 3)!
    expect(g3.status).toBe("pass")
    // Net income excludes conversions; member capital is NOT touched by the adjustment.
    expect(draft.pnl.netIncome).toBeCloseTo(10000, 2)
    expect(draft.members.find(m => m.name === "Sofia Marinoni")!.ending_capital).toBeCloseTo(6000, 2)
    expect(draft.members.find(m => m.name === "Marco Bianchi")!.ending_capital).toBeCloseTo(4000, 2)
    expect(draft.notes.some(n => n.includes("translation adjustment"))).toBe(true)
    expect(draft.notes.some(n => n.includes("may be missing"))).toBe(false) // small vs volume → no alarm
  })

  it("raises the 'possible missing leg/account' alarm when the residual is large vs the exchange volume", () => {
    const txs = [
      tx({ amount: 5000, category: "income", currency: "USD", bank_name: "Relay", account_type: "USD" }),
      tx({ amount: -1000, category: "conversion", currency: "USD", bank_name: "Wise", account_type: "USD" }), // unmatched leg
    ]
    const draft = buildFinancialDraft({ taxYear: 2025, transactions: txs, members: MEMBERS.members, priorReturn: null, defaultUncategorizedBySign: true })
    expect(draft.fx_translation_adjustment).toBeCloseTo(-1000, 2)
    expect(draft.notes.some(n => n.includes("may be missing"))).toBe(true)
    expect(evaluateGates({ draft, ownership: MEMBERS, priorReturn: null }).find(g => g.id === 3)!.status).toBe("pass")
  })
})

describe("Dynamiq 2024 reproduction — the real per-bank figures now reconcile", () => {
  it("beginning 218,084.89 / ending 391,863.70 from the client's provided balances; gate 1 & 3 pass (issues 1,3,4,5)", () => {
    // Real 2024 figures from Sofia's statements: opening → closing per account.
    const banks = [
      { key: "Chase USD", bank: "Chase", ccy: "USD", open: 196686.10, close: 269139.16 },
      { key: "Mercury USD", bank: "Mercury", ccy: "USD", open: 1674.67, close: 103112.40 },
      { key: "Relay USD", bank: "Relay", ccy: "USD", open: 0, close: 11144.73 },
      { key: "Wise USD", bank: "Wise", ccy: "USD", open: 19724.12, close: 8467.41 },
      { key: "Wise EUR", bank: "Wise", ccy: "EUR", open: 0, close: 0 }, // no net movement
    ]
    // One row per account carrying the real net movement, NO balance column
    // (mirrors Mercury/Chase where the running-balance column is absent/partial,
    // so the engine must fall back to the client's provided balances).
    const txs: DraftTransaction[] = banks.flatMap(b => {
      const net = Number((b.close - b.open).toFixed(2))
      if (net === 0) return []
      return [tx({ amount: net, category: net >= 0 ? "income" : "expense", currency: b.ccy, bank_name: b.bank, account_type: b.ccy, balance_after: null })]
    })
    const providedBalances = banks.map(b => ({ bank_key: b.key, currency: b.ccy, opening_balance: b.open, closing_balance: b.close, source: "client" as const }))
    const draft = buildFinancialDraft({ taxYear: 2024, transactions: txs, members: MEMBERS.members, priorReturn: null, defaultUncategorizedBySign: true, fxRates: { EUR: 0.924 }, providedBalances })
    expect(draft.beginning_cash).toBeCloseTo(218084.89, 2)   // was inflated to 229,513.89
    expect(draft.ending_cash).toBeCloseTo(391863.70, 2)      // was inflated to 403,292.70
    expect(draft.beginning_cash_source).toBe("provided")
    const gates = evaluateGates({ draft, ownership: MEMBERS, priorReturn: null })
    expect(gates.find(g => g.id === 1)!.status).toBe("pass") // no false "off by" / "doesn't add up"
    expect(gates.find(g => g.id === 3)!.status).toBe("pass") // balance sheet ties
  })
})

describe("beginningCta / ending_cta (dev_task d909e086 — carried-forward FX/CTA position)", () => {
  it("omitted beginningCta: ending_cta === fx_translation_adjustment exactly, balance_sheet_check unchanged from before this field existed", () => {
    const txs = [
      tx({ amount: 5000, category: "income" }),
      tx({ amount: -1000, category: "conversion" }),
    ]
    const draft = buildFinancialDraft({ taxYear: 2025, transactions: txs, members: MEMBERS.members, priorReturn: null, defaultUncategorizedBySign: true })
    expect(draft.ending_cta).toBeCloseTo(draft.fx_translation_adjustment, 2)
    expect(draft.balance_sheet_check).toBeCloseTo(
      draft.ending_cash - (draft.ending_capital_total + draft.fx_translation_adjustment + draft.pnl.uncategorizedTotal), 2,
    )
  })

  it("beginningCta carries through additively: ending_cta = beginningCta + this year's own movement", () => {
    const txs = [tx({ amount: -1000, category: "conversion" })]
    const draft = buildFinancialDraft({ taxYear: 2025, transactions: txs, members: MEMBERS.members, priorReturn: null, defaultUncategorizedBySign: true, beginningCta: 2500 })
    expect(draft.fx_translation_adjustment).toBeCloseTo(-1000, 2)
    expect(draft.ending_cta).toBeCloseTo(1500, 2) // 2500 + (-1000)
  })

  it("a nonzero beginningCta shifts the balance identity — a year that would otherwise 'tie' now correctly shows off-by-beginningCta if capital/cash don't also account for it", () => {
    const txs = [tx({ amount: 5000, category: "income" })] // no conversions this year
    const withoutCarry = buildFinancialDraft({ taxYear: 2025, transactions: txs, members: MEMBERS.members, priorReturn: null, defaultUncategorizedBySign: true })
    const withCarry = buildFinancialDraft({ taxYear: 2025, transactions: txs, members: MEMBERS.members, priorReturn: null, defaultUncategorizedBySign: true, beginningCta: 300 })
    expect(withoutCarry.balance_sheet_check).toBeCloseTo(0, 2) // ties: no FX, no carry
    expect(withCarry.balance_sheet_check).toBeCloseTo(withoutCarry.balance_sheet_check - 300, 2) // the carried CTA is now unaccounted-for equity — correctly surfaced, not silently dropped
  })
})

describe("priorEndingCash", () => {
  it("reads only VALIDATED filed_elsewhere extractions", () => {
    expect(priorEndingCash(PRIOR)).toBe(10_000)
    expect(priorEndingCash(null)).toBeNull()
    expect(priorEndingCash({ case: "first_year", status: "first_year", formation_date: null, note: "", recorded_at: "" })).toBeNull()
  })
})

describe("beginning cash — statement-opening fallback (no prior return)", () => {
  // Two banks, each earliest row carries a running balance → derived openings.
  // Mercury: first row amount -100, balance_after 900 → opening 1000.
  // Relay:   first row amount +500, balance_after 1500 → opening 1000.
  const baseTxs = [
    tx({ transaction_date: "2025-01-05", amount: -100, category: "expense", bank_name: "Mercury", account_type: "Checking", balance_after: 900 }),
    tx({ transaction_date: "2025-01-10", amount: 500, category: "income", bank_name: "Relay", account_type: "USD", balance_after: 1500 }),
  ]

  it("uses summed statement openings as beginning cash and tags the source", () => {
    const draft = buildFinancialDraft({ taxYear: 2025, transactions: baseTxs, members: MEMBERS.members, priorReturn: null })
    expect(draft.beginning_cash).toBe(2000)
    expect(draft.beginning_cash_source).toBe("statements")
  })

  it("keeps the balance sheet tied (assets = capital) with seeded opening equity", () => {
    const draft = buildFinancialDraft({ taxYear: 2025, transactions: baseTxs, members: MEMBERS.members, priorReturn: null })
    expect(draft.beginning_capital_total).toBe(2000) // opening equity seeded from opening cash
    expect(Math.abs(draft.total_assets - (draft.total_liabilities + draft.ending_capital_total))).toBeLessThan(0.01)
  })

  it("falls back to blank when an account carries no running balance (partial data)", () => {
    const partial = [
      baseTxs[0],
      tx({ transaction_date: "2025-01-10", amount: 500, category: "income", bank_name: "Relay", account_type: "USD", balance_after: null }),
    ]
    const draft = buildFinancialDraft({ taxYear: 2025, transactions: partial, members: MEMBERS.members, priorReturn: null })
    expect(draft.beginning_cash).toBeNull()
    expect(draft.beginning_cash_source).toBeNull()
  })

  it("prefers the prior return over the statements when one is validated", () => {
    const draft = buildFinancialDraft({ taxYear: 2025, transactions: baseTxs, members: MEMBERS.members, priorReturn: PRIOR })
    expect(draft.beginning_cash).toBe(10_000) // prior Schedule L ending cash, not the statements
    expect(draft.beginning_cash_source).toBe("prior_return")
  })

  it("does not invent beginning cash when there are no members to hold the equity", () => {
    const noMembers = resolveOwnership({ priorK1s: [], wizardMembers: [], accountContacts: [] })
    const draft = buildFinancialDraft({ taxYear: 2025, transactions: baseTxs, members: noMembers.members, priorReturn: null })
    expect(draft.beginning_cash).toBeNull()
    expect(draft.beginning_cash_source).toBeNull()
  })
})

describe("buildFinancialDraft — foreign-currency conversion to USD (Phase 2)", () => {
  it("converts a EUR expense to USD by the IRS rate (÷ rate) and leaves USD rows alone", () => {
    const txs = [
      tx({ amount: 1000, category: "income", currency: "USD", bank_name: "Relay", account_type: "USD" }),
      tx({ amount: -88.6, category: "expense", currency: "EUR", bank_name: "Wise", account_type: "EUR" }), // €88.6 / 0.886 = $100
    ]
    const draft = buildFinancialDraft({ taxYear: 2025, transactions: txs, members: MEMBERS.members, priorReturn: null, fxRates: { EUR: 0.886 } })
    expect(draft.pnl.totalIncome).toBeCloseTo(1000, 2)
    expect(draft.pnl.totalExpenses).toBeCloseTo(100, 2) // converted from EUR, not 88.6
  })

  it("flags a non-USD row with no rate on file (left unconverted, noted)", () => {
    const txs = [tx({ amount: -100, category: "expense", currency: "AED", bank_name: "Wise", account_type: "AED" })]
    const draft = buildFinancialDraft({ taxYear: 2025, transactions: txs, members: MEMBERS.members, priorReturn: null, fxRates: { EUR: 0.886 } })
    expect(draft.notes.some(n => n.includes("AED"))).toBe(true)
    expect(draft.pnl.totalExpenses).toBeCloseTo(100, 2) // unconverted fallback, not dropped
  })

  it("is a no-op when no fxRates are provided (all-USD path unchanged)", () => {
    const txs = [tx({ amount: -200, category: "expense", currency: "USD", bank_name: "Relay", account_type: "USD" })]
    const draft = buildFinancialDraft({ taxYear: 2025, transactions: txs, members: MEMBERS.members, priorReturn: null })
    expect(draft.pnl.totalExpenses).toBeCloseTo(200, 2)
    expect(draft.notes.some(n => n.toLowerCase().includes("exchange rate"))).toBe(false)
  })
})

/**
 * WHICH OWNER — the client's confirmation must reach the K-1.
 *
 * A flagged payment carries only a SURNAME by construction (that is why we ask),
 * so name-matching can never attribute it. Without reading the client's answer,
 * a draw they just confirmed belongs to one partner is spread across all of them
 * by ownership % — withdrawals appear on the K-1 of a partner who received
 * nothing, and the totals still tie so no gate notices.
 */
describe("confirmed owner attribution (2026-08-04)", () => {
  const members = [
    { name: "Gabriele Finelli", pct: 50, source: "wizard" as const },
    { name: "Matthew Finelli", pct: 50, source: "wizard" as const },
  ]
  const draw = (notes: string | null) => tx({
    id: "d1", description: "Sent money to M. Finelli", counterparty: "M. FINELLI",
    amount: -40000, category: "distribution", subcategory: "member_distribution", notes,
  })
  const build = (notes: string | null) => buildFinancialDraft({
    taxYear: 2025, transactions: [draw(notes)], members, priorReturn: null,
  })

  it("credits the confirmed owner in full", () => {
    const d = build("manual: client answer (owner_draw) | Member: Gabriele Finelli")
    const g = d.members.find(m => m.name === "Gabriele Finelli")!
    const m = d.members.find(m => m.name === "Matthew Finelli")!
    expect(g.distributions).toBe(40000)
    expect(m.distributions).toBe(0)
  })

  it("without the confirmation it is split across BOTH — the bug this prevents", () => {
    const d = build("manual: client answer (owner_draw)")
    expect(d.members.find(m => m.name === "Gabriele Finelli")!.distributions).toBe(20000)
    expect(d.members.find(m => m.name === "Matthew Finelli")!.distributions).toBe(20000)
  })

  it("an unknown name in the note falls back to spreading, never to a wrong partner", () => {
    const d = build("manual: client answer (owner_draw) | Member: Someone Else")
    expect(d.members.find(m => m.name === "Gabriele Finelli")!.distributions).toBe(20000)
  })

  it("credits the deterministic exact-name-match parser's bare note too, not just the client-answer shape (2026-08-23 bug-hunter fix)", () => {
    // bank-statement-parser.ts writes a bare "Member: X" (no leading pipe) when
    // a payee/description exactly matches a member's full name — this used to
    // fall through to spreading (see the test above) because this file's own
    // confirmedMemberFromNotes only recognized "| Member: X". It now delegates
    // to the shared reader, which recognizes both shapes.
    const d = build("Member: Gabriele Finelli")
    expect(d.members.find(m => m.name === "Gabriele Finelli")!.distributions).toBe(40000)
    expect(d.members.find(m => m.name === "Matthew Finelli")!.distributions).toBe(0)
  })
})

/**
 * THE K-1 READER MUST SURVIVE TRAILERS AFTER THE MEMBER NAME. The answer note
 * carries a candidate breadcrumb ("| Of: A; B") after "| Member: X". Reading
 * to end-of-string swallowed the trailer into the name, the match failed, and
 * the confirmed draw silently fell back to being spread across every partner —
 * undoing the exact fix the reader exists for.
 */
describe("confirmed owner attribution survives note trailers", () => {
  const members = [
    { name: "Gabriele Finelli", pct: 50, source: "wizard" as const },
    { name: "Matthew Finelli", pct: 50, source: "wizard" as const },
  ]
  it("credits the right owner when the note carries the candidate breadcrumb", () => {
    // MATTHEW deliberately — the SECOND member in the array. Reading the name
    // to end-of-string swallows the breadcrumb, and because name matching is
    // token-subset based, the polluted string then matches BOTH brothers — so
    // find() silently returns whoever is FIRST in the array, not who the
    // client confirmed. Confirming the second member is what exposes it.
    const d = buildFinancialDraft({
      taxYear: 2025, members, priorReturn: null,
      transactions: [tx({
        id: "d1", description: "Sent money to M. Finelli", counterparty: "M. FINELLI",
        amount: -40000, category: "distribution", subcategory: "member_distribution",
        notes: "manual: client answer (owner_draw) | Member: Matthew Finelli | Of: Gabriele Finelli; Matthew Finelli",
      })],
    })
    expect(d.members.find(m => m.name === "Matthew Finelli")!.distributions).toBe(40000)
    expect(d.members.find(m => m.name === "Gabriele Finelli")!.distributions).toBe(0)
  })
})
