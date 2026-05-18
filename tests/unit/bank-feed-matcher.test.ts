import { describe, it, expect } from "vitest"
import { isStripePayoutFeed, resolveInvoiceStatusAfterPayment, isMatchableInvoiceStatus } from "@/lib/bank-feed-matcher"

describe("isStripePayoutFeed", () => {
  // mercury (Plaid) pattern: full text in memo and sender_name
  it("matches mercury Plaid Stripe payout via memo", () => {
    expect(
      isStripePayoutFeed(
        "STRIPE; TRANSFER; TONY DURANTE LLC; Merchant name: STRIPE",
        null,
      ),
    ).toBe(true)
  })

  // mercury_api pattern: memo is "STRIPE — STRIPE; TRANSFER; ..."
  it("matches mercury_api Stripe payout via memo", () => {
    expect(
      isStripePayoutFeed(
        "STRIPE — STRIPE; TRANSFER; TONY DURANTE LLC",
        "STRIPE; TRANSFER; TONY DURANTE LLC",
      ),
    ).toBe(true)
  })

  // match via sender_reference alone when memo is absent
  it("matches when only sender_reference contains STRIPE; TRANSFER", () => {
    expect(isStripePayoutFeed(null, "STRIPE; TRANSFER; TONY DURANTE LLC")).toBe(true)
  })

  // case-insensitive
  it("matches lowercase variant", () => {
    expect(isStripePayoutFeed("stripe; transfer; tony durante llc", null)).toBe(true)
  })

  // ordinary client wire — should not match
  it("does not match a regular client wire", () => {
    expect(isStripePayoutFeed("Payment from Acme LLC INV-001234", null)).toBe(false)
  })

  // memo mentions Stripe but not a payout transfer
  it("does not match a Stripe charge feed (source=stripe)", () => {
    expect(isStripePayoutFeed("Charge by Stripe for subscription", null)).toBe(false)
  })

  // nulls
  it("returns false when both fields are null", () => {
    expect(isStripePayoutFeed(null, null)).toBe(false)
  })

  it("returns false when both fields are empty strings", () => {
    expect(isStripePayoutFeed("", "")).toBe(false)
  })
})

describe("isMatchableInvoiceStatus", () => {
  it("matches Draft — created at contract signing, real obligation", () => {
    expect(isMatchableInvoiceStatus("Draft")).toBe(true)
  })

  it("matches Sent", () => {
    expect(isMatchableInvoiceStatus("Sent")).toBe(true)
  })

  it("matches Overdue", () => {
    expect(isMatchableInvoiceStatus("Overdue")).toBe(true)
  })

  it("matches Partial", () => {
    expect(isMatchableInvoiceStatus("Partial")).toBe(true)
  })

  it("excludes Paid", () => {
    expect(isMatchableInvoiceStatus("Paid")).toBe(false)
  })

  it("excludes Voided", () => {
    expect(isMatchableInvoiceStatus("Voided")).toBe(false)
  })

  it("excludes Cancelled", () => {
    expect(isMatchableInvoiceStatus("Cancelled")).toBe(false)
  })
})

describe("resolveInvoiceStatusAfterPayment", () => {
  it("marks Paid when payment covers the full balance", () => {
    const result = resolveInvoiceStatusAfterPayment(1000, 0, 1000)
    expect(result.newStatus).toBe("Paid")
    expect(result.newAmountPaid).toBe(1000)
    expect(result.newAmountDue).toBe(0)
  })

  it("marks Partial when payment is less than the full balance", () => {
    const result = resolveInvoiceStatusAfterPayment(1000, 0, 200)
    expect(result.newStatus).toBe("Partial")
    expect(result.newAmountPaid).toBe(200)
    expect(result.newAmountDue).toBe(800)
  })

  it("accumulates correctly for installments — second payment of five", () => {
    const result = resolveInvoiceStatusAfterPayment(1000, 200, 200)
    expect(result.newStatus).toBe("Partial")
    expect(result.newAmountPaid).toBe(400)
    expect(result.newAmountDue).toBe(600)
  })

  it("marks Paid on the final installment", () => {
    const result = resolveInvoiceStatusAfterPayment(1000, 800, 200)
    expect(result.newStatus).toBe("Paid")
    expect(result.newAmountPaid).toBe(1000)
    expect(result.newAmountDue).toBe(0)
  })

  it("clamps amount_due to 0 if overpaid", () => {
    const result = resolveInvoiceStatusAfterPayment(1000, 900, 200)
    expect(result.newStatus).toBe("Paid")
    expect(result.newAmountDue).toBe(0)
  })
})
