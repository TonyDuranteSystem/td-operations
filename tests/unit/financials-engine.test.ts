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

  it("all six gates pass and confirm is allowed", () => {
    expect(gates.map(g => `${g.id}:${g.status}`)).toEqual(["1:pass", "2:pass", "3:pass", "4:pass", "5:pass", "6:pass"])
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
  it("gate 6 fails HARD on uncategorized; confirm blocked", () => {
    const transactions = [tx({ amount: -100, category: "uncategorized" })]
    const draft = buildFinancialDraft({ taxYear: 2025, transactions, members: MEMBERS.members, priorReturn: null })
    const gates = evaluateGates({ draft, ownership: MEMBERS, priorReturn: null })
    const g6 = gates.find(g => g.id === 6)!
    expect(g6.status).toBe("fail")
    expect(g6.blocking).toBe(true)
    expect(canConfirm(gates)).toBe(false)
  })

  it("gate 2 fails when prior ending cash does not match derived beginnings (missing January)", () => {
    // Statement-derived beginning = 12_000 (first balance 11_900 on a −100 tx), prior says 10_000.
    const transactions = [tx({ amount: -100, category: "expense", balance_after: 11_900 })]
    const draft = buildFinancialDraft({ taxYear: 2025, transactions, members: MEMBERS.members, priorReturn: PRIOR })
    const gates = evaluateGates({ draft, ownership: MEMBERS, priorReturn: PRIOR })
    expect(gates.find(g => g.id === 2)!.status).toBe("fail")
    expect(gates.find(g => g.id === 2)!.detail).toContain("missing")
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

  it("gate 1 fails when beginning + movements ≠ ending (partial export)", () => {
    const transactions = [
      tx({ amount: -100, category: "expense", balance_after: 900, transaction_date: "2025-01-05" }),
      // a later balance that implies missing transactions in between:
      tx({ amount: -50, category: "expense", balance_after: 500, transaction_date: "2025-11-30" }),
    ]
    const draft = buildFinancialDraft({ taxYear: 2025, transactions, members: MEMBERS.members, priorReturn: null })
    const gates = evaluateGates({ draft, ownership: MEMBERS, priorReturn: null })
    expect(gates.find(g => g.id === 1)!.status).toBe("fail")
    expect(gates.find(g => g.id === 1)!.detail).toContain("entire year")
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

// S2 slice 4 — prior-return vs verified-openings clash (the Dynamiq $750k discovery).
describe("prior_opening_clash", () => {
  const tx = (over: Record<string, unknown>) => ({
    id: "t1", transaction_date: "2024-06-01", description: "x", counterparty: null,
    amount: 100, currency: "USD", category: "income", subcategory: null,
    bank_name: "Mercury", account_type: "Checking", balance_after: null, ...over,
  })
  const priorReturn = {
    case: "filed_elsewhere",
    status: "validated",
    extracted: { schedule_l: { ending: { cash: 1_142_397 } }, k1s: [] },
  } as never

  it("flags when the prior return and provided openings disagree materially — prior still wins the pick", () => {
    const d = buildFinancialDraft({
      taxYear: 2024,
      transactions: [tx({})] as never,
      members: [{ name: "Sofia", pct: 100 }] as never,
      priorReturn,
      providedBalances: [{ bank_key: "Mercury Checking", currency: "USD", opening_balance: 218_084.89, closing_balance: null, source: "client" }],
    })
    expect(d.prior_opening_clash).not.toBeNull()
    expect(d.prior_opening_clash?.delta).toBeCloseTo(1_142_397 - 218_084.89, 2)
    expect(d.beginning_cash_source).toBe("prior_return")
    expect(d.notes.join(" ")).toMatch(/amendment/)
  })

  it("no flag within materiality or when either side is missing", () => {
    const close = buildFinancialDraft({
      taxYear: 2024,
      transactions: [tx({})] as never,
      members: [{ name: "Sofia", pct: 100 }] as never,
      priorReturn,
      providedBalances: [{ bank_key: "Mercury Checking", currency: "USD", opening_balance: 1_142_395, closing_balance: null, source: "client" }],
    })
    expect(close.prior_opening_clash).toBeNull()
    const noProvided = buildFinancialDraft({
      taxYear: 2024, transactions: [tx({})] as never,
      members: [{ name: "Sofia", pct: 100 }] as never, priorReturn,
    })
    expect(noProvided.prior_opening_clash).toBeNull()
  })
})
