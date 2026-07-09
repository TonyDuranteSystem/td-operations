/**
 * END-TO-END QA (logic level) for the bank account-identity feature.
 * Simulates every scenario through the REAL engine (buildFinancialDraft),
 * the REAL transfer matcher, and the REAL resolver — deterministic, no DB.
 *
 * Scenarios:
 *   A. Split-name heal via account_ref (Sofia/Dynamiq Chase bug).
 *   B. Split-name heal via canonical fallback (history rows, no account_ref).
 *   C. Two accounts at the same bank stay separate.
 *   D. Multi-currency (Wise) splits by currency, one identity.
 *   E. Crypto (Kraken) grouped under one identity.
 *   F. Transfers: cross-account matched; same-account NOT; the Dynamiq
 *      same-account-two-names case NOT mis-booked as a transfer.
 *   G. Backfill mapping over the real distinct names seen in production.
 */
import { describe, it, expect } from "vitest"
import { buildFinancialDraft, type DraftTransaction } from "@/lib/tax/financials-engine"
import { resolveOwnership } from "@/lib/tax/ownership-resolution"
import { matchTransferPairs, type TransferCandidate } from "@/lib/tax/transfer-matcher"
import { canonicalBankName, buildAccountRef } from "@/lib/tax/bank-identity"

const MEMBERS = resolveOwnership({
  priorK1s: [], accountContacts: [],
  wizardMembers: [{ name: "Owner", pct: 100 }],
})

let id = 0
function tx(p: Partial<DraftTransaction>): DraftTransaction {
  return {
    id: `t${++id}`, transaction_date: "2025-06-15", description: "", counterparty: null,
    amount: 0, currency: "USD", category: "expense", subcategory: null,
    bank_name: "Mercury", account_type: "USD", account_ref: null, balance_after: null, ...p,
  }
}
const bankKeys = (txs: DraftTransaction[]) =>
  buildFinancialDraft({ taxYear: 2025, transactions: txs, members: MEMBERS.members, priorReturn: null })
    .banks.map(b => b.bank_key).sort()

describe("A. split-name heal via account_ref (the Sofia/Dynamiq Chase bug)", () => {
  it("the SAME account under two bank-name spellings becomes ONE bank position", () => {
    const chaseA = buildAccountRef({ rawBankName: "Chase", accountNumber: "5678" }).account_ref
    const chaseB = buildAccountRef({ rawBankName: "JPMorgan Chase Bank, N.A.", accountNumber: "5678" }).account_ref
    expect(chaseA).toBe(chaseB)
    const keys = bankKeys([
      tx({ amount: -100, bank_name: "Chase", account_ref: chaseA, transaction_date: "2025-02-01" }),
      tx({ amount: -200, bank_name: "JPMorgan Chase Bank, N.A.", account_ref: chaseB, transaction_date: "2025-01-15" }),
    ])
    expect(keys).toEqual(["Chase#5678 USD"])
  })
})

describe("B. split-name heal via canonical fallback (history rows, account_ref null)", () => {
  it("un-backfilled rows still collapse by canonical name", () => {
    const keys = bankKeys([
      tx({ amount: -100, bank_name: "Chase", account_ref: null }),
      tx({ amount: -200, bank_name: "JPMorgan Chase Bank, N.A.", account_ref: null }),
    ])
    expect(keys).toEqual(["Chase USD"])
  })
})

describe("C. two accounts at the same bank stay separate", () => {
  it("distinct account numbers → two bank positions", () => {
    const keys = bankKeys([
      tx({ amount: -100, bank_name: "Chase", account_ref: buildAccountRef({ rawBankName: "Chase", accountNumber: "1111" }).account_ref }),
      tx({ amount: -200, bank_name: "Chase", account_ref: buildAccountRef({ rawBankName: "Chase", accountNumber: "2222" }).account_ref }),
    ])
    expect(keys).toEqual(["Chase#1111 USD", "Chase#2222 USD"])
  })
})

describe("D. multi-currency (Wise) — one identity, split by currency", () => {
  it("Wise USD and Wise EUR are two positions under one institution, no account number", () => {
    const ref = buildAccountRef({ rawBankName: "Wise", accountNumber: null }).account_ref // "Wise"
    expect(ref).toBe("Wise")
    const keys = bankKeys([
      tx({ amount: -100, bank_name: "Wise", account_ref: ref, currency: "USD", account_type: "USD" }),
      tx({ amount: -50, bank_name: "Wise", account_ref: ref, currency: "EUR", account_type: "EUR" }),
    ])
    expect(keys).toEqual(["Wise EUR", "Wise USD"])
  })
})

describe("E. crypto (Kraken) grouped under one identity", () => {
  it("Kraken's legal name collapses and needs no account number", () => {
    const r = buildAccountRef({ rawBankName: "Kraken (Payward Interactive, Inc.)" })
    expect(r.account_ref).toBe("Kraken")
    expect(r.needsAccountNumber).toBe(false)
    const keys = bankKeys([
      tx({ amount: -10, bank_name: "Kraken (Payward Interactive, Inc.)", account_ref: "Kraken" }),
      tx({ amount: -20, bank_name: "Kraken", account_ref: "Kraken" }),
    ])
    expect(keys).toEqual(["Kraken USD"])
  })
})

describe("F. transfer classification with account identity", () => {
  const cand = (p: Partial<TransferCandidate>): TransferCandidate => ({
    id: `c${++id}`, transaction_date: "2025-03-10", amount: 0, currency: "USD",
    bank_name: "Chase", account_type: "USD", account_ref: null, category: "uncategorized", ...p,
  })

  it("a real cross-account move IS matched as a transfer", () => {
    const pairs = matchTransferPairs([
      cand({ amount: -1000, bank_name: "Chase", account_ref: "Chase#1111", transaction_date: "2025-03-10" }),
      cand({ amount: 1000, bank_name: "Mercury", account_ref: "Mercury#9999", transaction_date: "2025-03-11" }),
    ])
    expect(pairs.length).toBe(1)
  })

  it("two legs of the SAME account are NOT matched (not a transfer)", () => {
    const pairs = matchTransferPairs([
      cand({ amount: -1000, account_ref: "Chase#1111", transaction_date: "2025-03-10" }),
      cand({ amount: 1000, account_ref: "Chase#1111", transaction_date: "2025-03-11" }),
    ])
    expect(pairs.length).toBe(0)
  })

  it("the Dynamiq case: same account under two bank NAMES is NOT mis-booked as a transfer", () => {
    const pairs = matchTransferPairs([
      cand({ amount: -1000, bank_name: "JPMorgan Chase Bank, N.A.", account_ref: "Chase#5678", transaction_date: "2025-01-20" }),
      cand({ amount: 1000, bank_name: "Chase", account_ref: "Chase#5678", transaction_date: "2025-02-02" }),
    ])
    expect(pairs.length).toBe(0)
  })
})

describe("G. backfill mapping over the real production distinct names", () => {
  it("collapses drift and leaves genuinely-unknown names flagged (as-is)", () => {
    expect(canonicalBankName("Chase")).toBe("Chase")
    expect(canonicalBankName("JPMorgan Chase Bank, N.A.")).toBe("Chase")
    expect(canonicalBankName("Slash")).toBe("Slash")
    expect(canonicalBankName("Slash Financial, Inc.")).toBe("Slash")
    expect(canonicalBankName("Kraken (Payward Interactive, Inc.)")).toBe("Kraken")
    expect(canonicalBankName("Wise")).toBe("Wise")
    expect(canonicalBankName("Relay")).toBe("Relay")
    expect(canonicalBankName("Mercury")).toBe("Mercury")
    // Not real institutions → left exactly as-is (no false merge)
    expect(canonicalBankName("unknown")).toBe("unknown")
    expect(canonicalBankName("Bank")).toBe("Bank")
  })
})
