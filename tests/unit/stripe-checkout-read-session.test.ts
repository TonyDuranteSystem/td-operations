/**
 * Paid booking links (dev job 74432428): reading a Checkout Session we made earlier. A session Stripe says does not exist counts as expired (a new one can be made);
 * any other failure is NOT "expired" (the caller must make nothing).
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => ({ retrieve: vi.fn(), expire: vi.fn() }))
vi.mock("stripe", () => ({ default: () => ({ checkout: { sessions: { retrieve: h.retrieve, expire: h.expire } } }) }))

import { readCheckoutSession, expireCheckoutSession } from "@/lib/stripe-checkout"

beforeEach(() => {
  process.env.STRIPE_SECRET_KEY = "sk_test_unit"
  h.retrieve.mockReset()
  h.expire.mockReset()
})

describe("readCheckoutSession", () => {
  it("returns the status and the address of an open session", async () => {
    h.retrieve.mockResolvedValue({ status: "open", payment_status: "unpaid", url: "https://checkout.stripe.com/c/pay/cs_1" })
    expect(await readCheckoutSession("cs_1")).toEqual({ ok: true, status: "open", paymentStatus: "unpaid", url: "https://checkout.stripe.com/c/pay/cs_1" })
  })
  it("a session Stripe says does not exist counts as expired", async () => {
    h.retrieve.mockRejectedValue(Object.assign(new Error("No such checkout.session"), { code: "resource_missing" }))
    expect(await readCheckoutSession("cs_gone")).toEqual({ ok: true, status: "expired", paymentStatus: null, url: null })
  })
  it("any other failure (a network error, a busy Stripe) is a failure, never 'expired'", async () => {
    h.retrieve.mockRejectedValue(new Error("connection reset"))
    expect(await readCheckoutSession("cs_1")).toEqual({ ok: false, error: "connection reset" })
  })
  it("with no Stripe key it says so", async () => {
    delete process.env.STRIPE_SECRET_KEY
    expect(await readCheckoutSession("cs_1")).toMatchObject({ ok: false })
  })
})

describe("expireCheckoutSession", () => {
  it("closes a session; a failure is reported, never thrown", async () => {
    h.expire.mockResolvedValue({})
    expect(await expireCheckoutSession("cs_1")).toEqual({ ok: true })
    h.expire.mockRejectedValue(new Error("already complete"))
    expect(await expireCheckoutSession("cs_1")).toEqual({ ok: false, error: "already complete" })
  })
})
