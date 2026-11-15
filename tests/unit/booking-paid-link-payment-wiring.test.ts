/**
 * Paid booking links (dev job 74432428): the one edit to the EXISTING money path. `recordPaidCallFromSession` (the Stripe payment recorder for paid-call links)
 * hands a payment to the booking-link code only when it carries `booking_link_id`; every other payment is recorded exactly as before.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const LEAD = "10000000-0000-4000-8000-000000000001"
const LINK = "b0000000-0000-4000-8000-000000000001"

const h = vi.hoisted(() => ({ settle: vi.fn(), record: vi.fn(), handled: true }))
vi.mock("@/lib/incoming-payments/confirm", () => ({ settlePayment: h.settle, UUID_RE: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i }))
vi.mock("@/lib/booking/pay-record", () => ({ recordBookingLinkPayment: h.record }))

import { recordPaidCallFromSession } from "@/lib/incoming-payments/link-payment"

const base = { id: "cs_x", payment_intent: "pi_x", amount_total: 39700, currency: "eur", customer_details: { email: "payer@x.example", name: "P" } }

beforeEach(() => {
  h.settle.mockReset().mockResolvedValue({ ok: true })
  h.record.mockReset().mockImplementation(async () => ({ handled: h.handled }))
  h.handled = true
})

describe("a payment WITHOUT the booking tag is recorded exactly as it was before", () => {
  it("goes through the old path (the lead on the link, else the payer's email) and never touches the booking link code", async () => {
    await recordPaidCallFromSession({ ...base, metadata: { payment_kind: "paid_call", crm_lead_ref: LEAD } })
    expect(h.record).not.toHaveBeenCalled()
    expect(h.settle).toHaveBeenCalledTimes(1)
    expect(h.settle.mock.calls[0][0]).toMatchObject({ resolution: "paid_call", leadId: LEAD, payment: { email: "payer@x.example", amount: 397, currency: "EUR", sessionId: "cs_x" } })
  })
  it("a payment with no metadata at all is recorded by the payer's email too", async () => {
    await recordPaidCallFromSession({ ...base, metadata: null })
    expect(h.record).not.toHaveBeenCalled()
    expect(h.settle.mock.calls[0][0]).toMatchObject({ resolution: "paid_call", leadId: null })
  })
})

describe("a payment WITH the booking tag", () => {
  const tagged = { ...base, metadata: { payment_kind: "paid_call", booking_link_id: LINK } }
  it("is recorded by the booking link code and stops there (the old path does not record it a second time)", async () => {
    await recordPaidCallFromSession(tagged)
    expect(h.record).toHaveBeenCalledTimes(1)
    expect(h.settle).not.toHaveBeenCalled()
  })
  it("falls through to the old path when its link no longer exists (the money is still recorded, by the payer's email)", async () => {
    h.handled = false
    await recordPaidCallFromSession(tagged)
    expect(h.record).toHaveBeenCalledTimes(1)
    expect(h.settle).toHaveBeenCalledTimes(1)
  })
  it("a failure in the booking link code reaches the webhook (it throws, so Stripe sends the payment again)", async () => {
    h.record.mockRejectedValueOnce(new Error("boom"))
    await expect(recordPaidCallFromSession(tagged)).rejects.toThrow("boom")
    expect(h.settle).not.toHaveBeenCalled()
  })
})
