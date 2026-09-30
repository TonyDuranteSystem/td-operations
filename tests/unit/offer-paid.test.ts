import { describe, it, expect } from "vitest"
import { offerCountsAsPaid } from "@/lib/offers/offer-paid"

describe("offerCountsAsPaid", () => {
  it("a completed offer is paid", () => {
    expect(offerCountsAsPaid({ offerStatus: "completed" })).toBe(true)
  })
  it("sent / viewed offers are not paid", () => {
    expect(offerCountsAsPaid({ offerStatus: "sent" })).toBe(false)
    expect(offerCountsAsPaid({ offerStatus: "viewed", activationStatus: null })).toBe(false)
  })
  it("signed but awaiting payment is not paid", () => {
    expect(offerCountsAsPaid({ offerStatus: "signed", activationStatus: "awaiting_payment" })).toBe(false)
  })
  it("signed with the payment confirmed or activated is paid", () => {
    expect(offerCountsAsPaid({ offerStatus: "signed", activationStatus: "activated" })).toBe(true)
    expect(offerCountsAsPaid({ offerStatus: "signed", activationStatus: "payment_confirmed" })).toBe(true)
    expect(offerCountsAsPaid({ offerStatus: "signed", activationStatus: "awaiting_payment", paymentConfirmedAt: "2026-09-29T10:00:00Z" })).toBe(true)
  })
  it("missing values are not paid", () => {
    expect(offerCountsAsPaid({ offerStatus: null })).toBe(false)
    expect(offerCountsAsPaid({ offerStatus: undefined, activationStatus: "" })).toBe(false)
  })
})
