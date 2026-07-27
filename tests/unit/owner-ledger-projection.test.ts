import { describe, it, expect } from "vitest"
import {
  buildOwnerLedgerRow,
  isOwnerLedgerFeed,
  OWNER_ACCOUNT_ID,
  type ProjectableFeed,
} from "@/lib/finance/owner-ledger-projection"

const base: ProjectableFeed = {
  id: "abc-123",
  transaction_date: "2026-07-24",
  amount: 1019.25,
  currency: "USD",
  source: "relay",
  sender_name: "STRIPE - TRANSFER",
  memo: "STRIPE - TRANSFER",
  status: "needs_review",
}

describe("isOwnerLedgerFeed — what belongs in the owner's books", () => {
  it("a Stripe payout does", () => {
    expect(isOwnerLedgerFeed(base)).toBe(true)
  })

  it("money TD spent does", () => {
    expect(isOwnerLedgerFeed({ ...base, sender_name: "Anything", memo: "x", status: "outgoing" })).toBe(true)
  })

  it("a Mercury bank reward does", () => {
    expect(
      isOwnerLedgerFeed({
        ...base,
        source: "mercury_api",
        sender_name: "Mercury",
        memo: "Cash bonus for referring ATCOACHING LLC.",
        raw_data: { counterpartyName: "Mercury" },
      }),
    ).toBe(true)
  })

  it("a real client payment does NOT — it stays in Finance", () => {
    expect(
      isOwnerLedgerFeed({ ...base, sender_name: "WISE US INC - INV-001389", memo: "WISE US INC - INV-001389", raw_data: {} }),
    ).toBe(false)
  })

  it("a client card charge does NOT", () => {
    expect(
      isOwnerLedgerFeed({
        ...base,
        source: "stripe",
        sender_name: "Bilaal Rajan",
        memo: "visa ••••9765",
        raw_data: { object: "charge", payment_intent: "pi_x" },
      }),
    ).toBe(false)
  })
})

describe("buildOwnerLedgerRow — the six safety rules", () => {
  it("1. ALWAYS pins the owner account — never a client's", () => {
    const row = buildOwnerLedgerRow(base)!
    expect(row.account_id).toBe(OWNER_ACCOUNT_ID)
  })

  it("2. signs the amount — money out is negative, money in positive", () => {
    expect(buildOwnerLedgerRow({ ...base, status: "outgoing", amount: 25000 })!.amount).toBe(-25000)
    expect(buildOwnerLedgerRow({ ...base, amount: 1019.25 })!.amount).toBe(1019.25)
  })

  it("3. always produces a non-blank, deterministic reference", () => {
    const row = buildOwnerLedgerRow(base)!
    expect(row.transaction_ref).toBe("feed:abc-123")
    expect(row.transaction_ref.trim()).not.toBe("")
  })

  it("4. derives the tax year from the transaction date", () => {
    expect(buildOwnerLedgerRow({ ...base, transaction_date: "2025-12-31" })!.tax_year).toBe(2025)
  })

  it("5. preserves the row's own currency (no FX guessing)", () => {
    expect(buildOwnerLedgerRow({ ...base, currency: "eur" })!.currency).toBe("EUR")
  })

  it("6. always lands uncategorized — nothing is auto-booked as income", () => {
    expect(buildOwnerLedgerRow(base)!.category).toBe("uncategorized")
  })

  it("maps the bank label so cash groups per account", () => {
    expect(buildOwnerLedgerRow({ ...base, source: "relay" })!.bank_name).toBe("Relay")
    expect(buildOwnerLedgerRow({ ...base, source: "mercury_api" })!.bank_name).toBe("Mercury")
    expect(buildOwnerLedgerRow({ ...base, source: "airwallex_api" })!.bank_name).toBe("Airwallex")
  })

  it("refuses a row it cannot build safely rather than corrupting the books", () => {
    expect(buildOwnerLedgerRow({ ...base, amount: Number.NaN })).toBeNull()
    expect(buildOwnerLedgerRow({ ...base, transaction_date: "not-a-date" })).toBeNull()
  })

  it("rounds to cents (no floating-point dust in the books)", () => {
    expect(buildOwnerLedgerRow({ ...base, amount: 0.1 + 0.2 })!.amount).toBe(0.3)
  })

  it("falls back to a description when the memo is empty", () => {
    expect(buildOwnerLedgerRow({ ...base, memo: null, sender_name: null })!.description).toBe("Bank transaction")
  })
})
