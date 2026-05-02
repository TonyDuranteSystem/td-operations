import { describe, it, expect } from "vitest"
import { isStripePayoutFeed } from "@/lib/bank-feed-matcher"

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
