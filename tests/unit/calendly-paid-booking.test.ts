/**
 * WS-A Calendly trigger — paid-booking detection (dev job c0a61e44).
 * Fixtures mirror REAL production deliveries (the Aug-5 paid booking and the
 * free bookings around it), not hand-rolled ideals.
 */
import { describe, it, expect } from "vitest"
import {
  extractPaidBooking,
  paidCallIdempotencyKey,
  paidCallDescription,
} from "@/lib/calendly/paid-booking"

/** Real paid delivery shape (production webhook_events, Aug-5). */
function paidPayload(overrides: Record<string, unknown> = {}) {
  return {
    event: "invitee.created",
    payload: {
      email: "info@luvain.it",
      name: "Alessandro",
      payment: {
        terms: "",
        amount: 257,
        currency: "EUR",
        provider: "stripe",
        successful: true,
        external_id: "ch_3U13QkIHsqD3wMA909sGP2zj",
        ...overrides,
      },
    },
  }
}

/** Real FREE delivery shape: the payment key EXISTS and is null. */
const freePayload = {
  event: "invitee.created",
  payload: { email: "someone@example.com", name: "Someone", payment: null },
}

describe("extractPaidBooking — structural detection only", () => {
  it("reads a real paid booking: amount, currency, charge id", () => {
    expect(extractPaidBooking(paidPayload())).toEqual({
      amount: 257,
      currency: "EUR",
      chargeId: "ch_3U13QkIHsqD3wMA909sGP2zj",
      provider: "stripe",
    })
  })

  it("the OTHER real amount/currency works identically — nothing hardcodes 257", () => {
    const wenTing = paidPayload({ amount: 157, currency: "USD", external_id: "ch_3Tc0nNIHsqD3wMA907ysHn9N" })
    expect(extractPaidBooking(wenTing)).toMatchObject({ amount: 157, currency: "USD" })
  })

  it("a FREE booking (payment key present, value null) is not a paid call", () => {
    expect(extractPaidBooking(freePayload)).toBe(null)
  })

  it("payment key absent entirely → null", () => {
    expect(extractPaidBooking({ event: "invitee.created", payload: { email: "x@y.z" } })).toBe(null)
  })

  it("an UNSUCCESSFUL payment is never a credit", () => {
    expect(extractPaidBooking(paidPayload({ successful: false }))).toBe(null)
  })

  it("zero / negative / non-numeric amounts are refused", () => {
    expect(extractPaidBooking(paidPayload({ amount: 0 }))).toBe(null)
    expect(extractPaidBooking(paidPayload({ amount: -257 }))).toBe(null)
    expect(extractPaidBooking(paidPayload({ amount: "many" }))).toBe(null)
  })

  it("an unsupported currency is refused rather than guessed", () => {
    expect(extractPaidBooking(paidPayload({ currency: "GBP" }))).toBe(null)
  })

  it("a missing charge id is refused — the charge IS the identity", () => {
    expect(extractPaidBooking(paidPayload({ external_id: "" }))).toBe(null)
  })

  it("detection never consults the event type or the meeting name", () => {
    const oddlyNamed = { event: "something.else", payload: { ...paidPayload().payload, name: "Free chat" } }
    expect(extractPaidBooking(oddlyNamed)).toMatchObject({ amount: 257 })
  })

  it("junk inputs never throw", () => {
    expect(extractPaidBooking(null)).toBe(null)
    expect(extractPaidBooking(undefined)).toBe(null)
    expect(extractPaidBooking("string")).toBe(null)
    expect(extractPaidBooking({ payload: "not an object" })).toBe(null)
  })
})

describe("idempotency keys — keyed on the charge", () => {
  it("distinct keys per row kind, stable across re-delivery", () => {
    expect(paidCallIdempotencyKey("ch_abc", "invoice")).toBe("calendly-call:ch_abc:invoice")
    expect(paidCallIdempotencyKey("ch_abc", "credit")).toBe("calendly-call:ch_abc:credit")
    expect(paidCallIdempotencyKey("ch_abc", "invoice")).toBe(paidCallIdempotencyKey("ch_abc", "invoice"))
  })
  it("different charges never collide", () => {
    expect(paidCallIdempotencyKey("ch_a", "credit")).not.toBe(paidCallIdempotencyKey("ch_b", "credit"))
  })
})

describe("description", () => {
  it("dated when known, generic otherwise", () => {
    expect(paidCallDescription("2026-08-05")).toBe("Paid Strategy Call — 2026-08-05")
    expect(paidCallDescription(null)).toBe("Paid Strategy Call")
  })
})
