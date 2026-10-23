import { describe, it, expect, vi, beforeEach } from "vitest"

const settle = vi.fn()
vi.mock("@/lib/incoming-payments/confirm", () => ({
  settlePayment: (...a: unknown[]) => settle(...a),
  UUID_RE: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
}))

import { recordPaidCallFromSession } from "@/lib/incoming-payments/link-payment"

const LEAD = "131b5d4a-2800-4bc8-9104-a955fae8e62a"
const session = (over: Record<string, unknown> = {}) => ({
  id: "cs_live_abc12345", payment_intent: "pi_1", amount_total: 39700, currency: "eur",
  customer_details: { email: "chris@example.com", name: "Christian" }, metadata: { payment_kind: "paid_call", crm_lead_ref: LEAD },
  ...over,
}) as Parameters<typeof recordPaidCallFromSession>[0]

beforeEach(() => { settle.mockReset(); settle.mockResolvedValue({ ok: true, resolution: "paid_call", alreadySettled: false }) })

describe("recordPaidCallFromSession", () => {
  it("settles as a plain paid call (credit kept) for the lead named on the link, money from the session", async () => {
    await recordPaidCallFromSession(session(), new Date("2026-10-23T14:00:00Z"))
    expect(settle).toHaveBeenCalledTimes(1)
    const arg = settle.mock.calls[0][0]
    expect(arg).toMatchObject({ resolution: "paid_call", leadId: LEAD })
    expect(arg.payment).toMatchObject({ sessionId: "cs_live_abc12345", amount: 397, currency: "EUR", paymentIntentId: "pi_1", email: "chris@example.com", paidAt: "2026-10-23T14:00:00.000Z" })
  })
  it("falls back to the email we put on the link when Stripe sends none", async () => {
    await recordPaidCallFromSession(session({ customer_details: null, metadata: { payment_kind: "paid_call", client_email: "link@example.com" } }))
    expect(settle.mock.calls[0][0].payment.email).toBe("link@example.com")
    expect(settle.mock.calls[0][0].leadId).toBeNull()
  })
  it("ignores a malformed lead reference instead of passing it on", async () => {
    await recordPaidCallFromSession(session({ metadata: { payment_kind: "paid_call", crm_lead_ref: "not-a-uuid" } }))
    expect(settle.mock.calls[0][0].leadId).toBeNull()
  })
  it("a lead deleted after the link was made: records by the payer's email instead of failing forever", async () => {
    settle.mockResolvedValueOnce({ ok: false, status: 404, error: "Lead not found." })
    await recordPaidCallFromSession(session())
    expect(settle).toHaveBeenCalledTimes(2)
    expect(settle.mock.calls[1][0].leadId).toBeNull()
  })
  it("THROWS when it cannot record, so the webhook answers 500 and Stripe retries", async () => {
    settle.mockResolvedValue({ ok: false, status: 500, error: "contact creation failed" })
    await expect(recordPaidCallFromSession(session())).rejects.toThrow(/contact creation failed/)
  })
  it("throws on an unusable amount or currency instead of recording nonsense", async () => {
    await expect(recordPaidCallFromSession(session({ amount_total: 0 }))).rejects.toThrow()
    await expect(recordPaidCallFromSession(session({ currency: "gbp" }))).rejects.toThrow()
    expect(settle).not.toHaveBeenCalled()
  })
})
