/**
 * Never chase a client whose money is already in the bank waiting for a click.
 *
 * Two changes in this batch created this risk together: the ambiguity guard parks a payment
 * for review instead of applying it, and un-matching now restores an invoice to its true
 * Sent/Overdue state instead of hiding it as a Draft. Without this filter the nightly pass
 * emails "Payment Overdue" to a client who has paid.
 */

import { describe, it, expect } from "vitest"
import { suppressWhilePaymentAwaitsReview } from "@/lib/billing/dunning"

describe("suppressWhilePaymentAwaitsReview", () => {
  it("holds back an invoice with a payment pinned for review", () => {
    const { keep, suppressed } = suppressWhilePaymentAwaitsReview(
      ["inv-a", "inv-b", "inv-c"],
      [{ matched_payment_id: "inv-b" }],
    )
    expect(suppressed).toEqual(["inv-b"])
    expect(keep).toEqual(["inv-a", "inv-c"])
  })

  it("chases normally when nothing is awaiting review", () => {
    const { keep, suppressed } = suppressWhilePaymentAwaitsReview(["inv-a"], [])
    expect(keep).toEqual(["inv-a"])
    expect(suppressed).toEqual([])
  })

  it("ignores review rows that carry no invoice pointer", () => {
    const { keep } = suppressWhilePaymentAwaitsReview(["inv-a"], [{ matched_payment_id: null }])
    expect(keep).toEqual(["inv-a"])
  })

  it("holds every invoice that has a pinned payment, not just the first", () => {
    const { keep, suppressed } = suppressWhilePaymentAwaitsReview(
      ["inv-a", "inv-b"],
      [{ matched_payment_id: "inv-a" }, { matched_payment_id: "inv-b" }],
    )
    expect(suppressed).toEqual(["inv-a", "inv-b"])
    expect(keep).toEqual([])
  })

  it("is a pause, not a cancellation — the same invoice returns once the review clears", () => {
    const held = suppressWhilePaymentAwaitsReview(["inv-a"], [{ matched_payment_id: "inv-a" }])
    expect(held.keep).toEqual([])
    const released = suppressWhilePaymentAwaitsReview(["inv-a"], [])
    expect(released.keep).toEqual(["inv-a"])
  })
})
