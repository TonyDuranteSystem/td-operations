import { describe, it, expect } from "vitest"
import { isUnlabelledPayment, waitingPaymentFromEvent, pickWaiting, INCOMING_PAYMENTS_SINCE } from "@/lib/incoming-payments/classify"

const session = (over: Record<string, unknown> = {}) => ({
  id: "cs_live_abc12345",
  mode: "payment",
  payment_status: "paid",
  payment_intent: "pi_1",
  payment_link: "plink_1",
  amount_total: 39700,
  currency: "eur",
  customer_details: { email: "Chris.Ranieri@icloud.com", name: "Christian Ranieri" },
  metadata: {},
  ...over,
})
const ev = (over: Record<string, unknown> = {}, at = "2026-10-23T13:26:47Z") => ({ created_at: at, payload: session(over) })

describe("isUnlabelledPayment — only a payment with NO label of ours is unlabelled", () => {
  it("empty or missing metadata is unlabelled (Ranieri's real shape)", () => {
    expect(isUnlabelledPayment({ mode: "payment", metadata: {} })).toBe(true)
    expect(isUnlabelledPayment({ mode: "payment", metadata: null })).toBe(true)
    expect(isUnlabelledPayment({ metadata: undefined })).toBe(true)
  })
  it.each(["source", "payment_kind", "offer_token", "invoice_number", "lead_id"])("a %s label makes it ours", key => {
    expect(isUnlabelledPayment({ mode: "payment", metadata: { [key]: "x" } })).toBe(false)
  })
  it("a label that is only spaces or empty does not count", () => {
    expect(isUnlabelledPayment({ mode: "payment", metadata: { source: "  ", offer_token: "", invoice_number: "" } })).toBe(true)
  })
  it("the offer checkout always stamps source, even with an empty offer token", () => {
    expect(isUnlabelledPayment({ mode: "payment", metadata: { source: "td-operations", offer_token: "", invoice_number: "" } })).toBe(false)
  })
  it("a setup-mode session (card on file) is never a waiting payment", () => {
    expect(isUnlabelledPayment({ mode: "setup", metadata: {} })).toBe(false)
  })
})

describe("waitingPaymentFromEvent", () => {
  it("reads whole units, the payer, the Stripe ids", () => {
    const w = waitingPaymentFromEvent(ev())!
    expect(w).toMatchObject({ sessionId: "cs_live_abc12345", paymentIntentId: "pi_1", paymentLinkId: "plink_1", amount: 397, currency: "EUR", email: "Chris.Ranieri@icloud.com", name: "Christian Ranieri" })
  })
  it("returns null for a labelled payment, an unpaid one, zero money, an unknown currency, or no id", () => {
    expect(waitingPaymentFromEvent(ev({ metadata: { source: "td-operations" } }))).toBeNull()
    expect(waitingPaymentFromEvent(ev({ payment_status: "unpaid" }))).toBeNull()
    expect(waitingPaymentFromEvent(ev({ amount_total: 0 }))).toBeNull()
    expect(waitingPaymentFromEvent(ev({ currency: "gbp" }))).toBeNull()
    expect(waitingPaymentFromEvent(ev({ id: "" }))).toBeNull()
    expect(waitingPaymentFromEvent({ created_at: "x", payload: null })).toBeNull()
  })
  it("keeps going without an email or a name", () => {
    const w = waitingPaymentFromEvent(ev({ customer_details: null }))!
    expect(w.email).toBeNull()
    expect(w.name).toBeNull()
  })
})

describe("pickWaiting", () => {
  const none = { sessionIds: new Set<string>(), stripeIds: new Set<string>() }
  it("lists a redelivered event once, newest first", () => {
    const rows = pickWaiting([ev({ id: "cs_a1234567" }, "2026-10-23T10:00:00Z"), ev({ id: "cs_b1234567" }, "2026-10-23T12:00:00Z"), ev({ id: "cs_a1234567" }, "2026-10-23T10:05:00Z")], none)
    expect(rows.map(r => r.sessionId)).toEqual(["cs_b1234567", "cs_a1234567"])
  })
  it("drops a session that staff already settled", () => {
    expect(pickWaiting([ev()], { ...none, sessionIds: new Set(["cs_live_abc12345"]) })).toEqual([])
  })
  it("drops a payment that already has a payments row under its payment-intent id OR its session id", () => {
    expect(pickWaiting([ev()], { ...none, stripeIds: new Set(["pi_1"]) })).toEqual([])
    expect(pickWaiting([ev()], { ...none, stripeIds: new Set(["cs_live_abc12345"]) })).toEqual([])
  })
  it("the cut-off is fixed so older, settled-by-hand payments never reappear", () => {
    expect(INCOMING_PAYMENTS_SINCE).toBe("2026-10-01")
  })
})
