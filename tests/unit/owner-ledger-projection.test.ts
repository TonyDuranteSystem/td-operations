import { describe, it, expect } from "vitest"
import {
  buildOwnerLedgerRow,
  isClientInvoicePayment,
  isOwnerLedgerFeed,
  OWNER_ACCOUNT_ID,
  type ProjectableFeed,
  type OpenInvoiceRef,
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

/**
 * THE RULE (Antonio, 2026-07-27): Finance keeps a deposit ONLY when something concrete proves
 * a client is paying an invoice. Everything else — including anything unrecognised — goes to
 * My Finances, where he can send it back with one click.
 */
describe("isClientInvoicePayment — what STAYS in Finance", () => {
  it("a card charge with its payment reference stays", () => {
    expect(isClientInvoicePayment({ ...base, source: "stripe", raw_data: { payment_intent: "pi_3T5A2O" } })).toBe(true)
  })

  it("an invoice number in the text keeps it in Finance", () => {
    expect(isClientInvoicePayment({ ...base, sender_name: "WISE US INC - INV-001389 -WR", memo: null })).toBe(true)
  })

  it("a payer email keeps it in Finance", () => {
    expect(isClientInvoicePayment({ ...base, memo: "payment from aman@simpleholdingsusa.com" })).toBe(true)
  })

  it("a feed already tied to an invoice stays", () => {
    expect(isClientInvoicePayment({ ...base, matched_payment_id: "pay-1" })).toBe(true)
  })

  it("an amount matching something a client owes keeps it in Finance", () => {
    const owed: OpenInvoiceRef[] = [{ amount: 1000, currency: "USD" }]
    expect(isClientInvoicePayment({ ...base, amount: 1019.25 }, owed)).toBe(true)
  })

  it("PART-PAYMENT: $500 against a $2,200 invoice — the wide tolerance keeps it in Finance", () => {
    // The Council broke the earlier rule on exactly this: a client part-payment matched no
    // invoice under a 5% tolerance and was swept out. The veto uses max(20%, $50).
    const owed: OpenInvoiceRef[] = [{ amount: 500, currency: "USD" }, { amount: 2200, currency: "USD" }]
    expect(isClientInvoicePayment({ ...base, amount: 500, sender_name: "Some Wire", memo: null }, owed)).toBe(true)
  })

  it("CURRENCY: a EUR deposit is NOT kept by a same-numbered USD invoice", () => {
    const owed: OpenInvoiceRef[] = [{ amount: 1019.25, currency: "USD" }]
    expect(isClientInvoicePayment({ ...base, currency: "EUR", sender_name: "Wire", memo: null }, owed)).toBe(false)
  })
})

describe("isOwnerLedgerFeed — what goes to MY FINANCES", () => {
  it("a Stripe payout goes (nothing proves it is a client)", () => {
    expect(isOwnerLedgerFeed(base)).toBe(true)
  })

  it("money TD spent goes", () => {
    expect(isOwnerLedgerFeed({ ...base, status: "outgoing", sender_name: "Tony Durante LLC" })).toBe(true)
  })

  it("a bank reward goes", () => {
    expect(isOwnerLedgerFeed({ ...base, source: "mercury_api", sender_name: "Mercury", memo: "Cash bonus for referring ATCOACHING LLC." })).toBe(true)
  })

  it("THE DEFAULT: an unrecognised deposit goes to My Finances (not left in Finance)", () => {
    expect(isOwnerLedgerFeed({ ...base, sender_name: "Unknown Wire", memo: null, raw_data: {} })).toBe(true)
  })

  it("outgoing money is never treated as a client payment even if it names a client", () => {
    expect(isClientInvoicePayment({ ...base, status: "outgoing", memo: "INV-001389" })).toBe(false)
  })
})

describe("buildOwnerLedgerRow — the safety rules", () => {
  it("ALWAYS pins the owner account — never a client's", () => {
    expect(buildOwnerLedgerRow(base)!.account_id).toBe(OWNER_ACCOUNT_ID)
  })

  it("signs the amount — money out negative, money in positive", () => {
    expect(buildOwnerLedgerRow({ ...base, status: "outgoing", amount: 25000 })!.amount).toBe(-25000)
    expect(buildOwnerLedgerRow({ ...base, amount: 1019.25 })!.amount).toBe(1019.25)
  })

  it("produces a non-blank deterministic reference so it can be sent back", () => {
    expect(buildOwnerLedgerRow(base)!.transaction_ref).toBe("feed:abc-123")
  })

  it("derives the tax year, preserves currency, always lands uncategorized", () => {
    const row = buildOwnerLedgerRow({ ...base, transaction_date: "2025-12-31", currency: "eur" })!
    expect(row.tax_year).toBe(2025)
    expect(row.currency).toBe("EUR")
    expect(row.category).toBe("uncategorized")
  })

  it("maps the bank label so cash groups per account", () => {
    expect(buildOwnerLedgerRow({ ...base, source: "mercury_api" })!.bank_name).toBe("Mercury")
  })

  it("refuses a row it cannot build safely rather than corrupting the books", () => {
    expect(buildOwnerLedgerRow({ ...base, amount: Number.NaN })).toBeNull()
    expect(buildOwnerLedgerRow({ ...base, transaction_date: "not-a-date" })).toBeNull()
  })

  it("rounds to cents (no floating-point dust)", () => {
    expect(buildOwnerLedgerRow({ ...base, amount: 0.1 + 0.2 })!.amount).toBe(0.3)
  })
})
