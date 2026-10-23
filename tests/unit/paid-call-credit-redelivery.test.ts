/**
 * recordPaidCall run a SECOND time for the same payment (Stripe / Calendly redelivery, or a retry after a half-finished attempt).
 * createTDInvoice's idempotency lookup skips rows whose status is "Credit" (on its dead-invoice list), so once the credit had been
 * activated the second run tried to insert the same idempotency key again and threw a duplicate-key error. An activated credit with
 * the key is now reused: the second run creates nothing and does not reset what was already consumed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

let activatedCredit: { id: string; invoice_number: string } | null = null
const updates: { table: string; payload: unknown }[] = []

function builder(table: string) {
  let isUpdate = false
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const b: any = {
    select: () => b,
    update: (p: unknown) => { isUpdate = true; updates.push({ table, payload: p }); return b },
    eq: () => b, neq: () => b, limit: () => b,
    maybeSingle: () => Promise.resolve({ data: table === "payments" ? activatedCredit : null, error: null }),
    then: (res: (v: unknown) => unknown) => Promise.resolve({ data: table === "account_contacts" ? [] : null, error: null }).then(res),
  }
  void isUpdate
  return b
}
vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: { from: (t: string) => builder(t) } }))

const createTDInvoice = vi.fn()
vi.mock("@/lib/portal/td-invoice", () => ({ createTDInvoice: (...a: unknown[]) => createTDInvoice(...a) }))
vi.mock("@/lib/stripe-sync", () => ({ paymentIntentIdForCharge: vi.fn(async () => null) }))
vi.mock("@/lib/operations/credit-subject", () => ({
  resolveCreditSubject: vi.fn(async () => ({ kind: "resolved", contactId: "c1", email: "a@b.c" })),
  subjectForRecording: () => ({ contactId: "c1", ambiguous: false }),
}))

import { recordPaidCall } from "@/lib/operations/paid-call-credit"

const params = {
  payment: { chargeId: "stripe-session:cs_x", amount: 397, currency: "EUR" as const, provider: "stripe", paymentIntentId: "pi_1" },
  inviteeEmail: "a@b.c",
  manual: { feedId: "stripe-session:cs_x", sourceLabel: "Stripe payment" },
}

beforeEach(() => {
  activatedCredit = null
  updates.length = 0
  createTDInvoice.mockReset()
  createTDInvoice.mockResolvedValue({ paymentId: "p-new", invoiceNumber: "INV-1", expenseId: "", total: 397, status: "Paid" })
})

describe("recordPaidCall — a second run for the same payment", () => {
  it("reuses an ACTIVATED credit instead of creating it again, and never re-activates (so a consumed credit is not reset)", async () => {
    activatedCredit = { id: "cr1", invoice_number: "CN-7" }
    const r = await recordPaidCall(params)
    expect(r.creditId).toBe("cr1")
    expect(r.creditNumber).toBe("CN-7")
    // only the invoice went through createTDInvoice (it finds its own existing row); the credit did not
    expect(createTDInvoice).toHaveBeenCalledTimes(1)
    expect(createTDInvoice.mock.calls[0][0].idempotency_key).toBe("paid-call-manual:stripe-session:cs_x:invoice")
    // no write touches the credit row
    expect(updates.filter(u => JSON.stringify(u.payload).includes("credit_remaining"))).toHaveLength(0)
  })

  it("the first run (no credit yet) still creates it and makes it live", async () => {
    createTDInvoice
      .mockResolvedValueOnce({ paymentId: "p-inv", invoiceNumber: "INV-1", expenseId: "", total: 397, status: "Paid" })
      .mockResolvedValueOnce({ paymentId: "p-cr", invoiceNumber: "CN-1", expenseId: "", total: -397, status: "Draft" })
    const r = await recordPaidCall(params)
    expect(createTDInvoice).toHaveBeenCalledTimes(2)
    expect(createTDInvoice.mock.calls[1][0].idempotency_key).toBe("paid-call-manual:stripe-session:cs_x:credit")
    expect(r.creditId).toBe("p-cr")
    expect(updates.some(u => JSON.stringify(u.payload).includes('"credit_remaining":397'))).toBe(true)
  })
})
