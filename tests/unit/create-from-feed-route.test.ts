/**
 * POST /api/feed/create-from-feed — the money guarantees of "invoice this payment".
 *
 * Remove the refund check and the refunded-charge tests fail (a refunded card payment became a PAID invoice
 * plus a new person before anything asked Stripe); drop the target comparison and the retry-with-someone-else
 * tests fail (money stayed on the first person under a green message); let a bad currency through and the GBP
 * test fails; undo a person who is already in use and the rollback tests fail.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const FEED_ID = "228b5a19-9a35-4221-84bc-1226d4a605c0"
const DERIVED_CONTACT = "derived-contact-for-this-feed"
const CONTACT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const CONTACT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const ACCOUNT_X = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"

let user: { id: string } | null
let feedRow: Record<string, unknown> | null
let existingPayment: Record<string, unknown> | null
let sdDeleteError: { message: string } | null
let refundError: string | undefined
const order: string[] = []
const manualMatch = vi.fn()
const createTDInvoice = vi.fn()
const createBackfilledSD = vi.fn()
const findOrCreatePayerContact = vi.fn()
const removeJustCreatedPayerContact = vi.fn()
const writeFeedStoryToInvoices = vi.fn()
const recordPaidCall = vi.fn()
const stripeRefundGate = vi.fn()
let paidCall: { kind: string; revenueOnly?: boolean; reason?: string }

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({ auth: { getUser: async () => ({ data: { user } }) } }),
}))
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      let deleting = false
      const q: Record<string, unknown> = new Proxy({}, {
        get(_t, prop) {
          const name = String(prop)
          if (name === "then") {
            return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
              if (deleting) order.push(`delete:${table}`)
              return Promise.resolve({ data: null, error: deleting ? sdDeleteError : null }).then(res, rej)
            }
          }
          if (name === "single" || name === "maybeSingle") {
            return () => Promise.resolve({ data: table === "td_bank_feeds" ? feedRow : table === "payments" ? existingPayment : null, error: null })
          }
          return (..._args: unknown[]) => {
            if (name === "delete") deleting = true
            return q
          }
        },
      })
      return q
    },
  },
}))
vi.mock("@/lib/portal/td-invoice", () => ({ createTDInvoice: (...a: unknown[]) => createTDInvoice(...a) }))
vi.mock("@/lib/bank-feed-matcher", () => ({ manualMatch: (...a: unknown[]) => manualMatch(...a) }))
vi.mock("@/lib/operations/paid-call-credit", () => ({ recordPaidCall: (...a: unknown[]) => recordPaidCall(...a) }))
vi.mock("@/lib/calendly/paid-booking", () => ({ parsePaidCallRequest: () => paidCall }))
vi.mock("@/lib/operations/service-delivery", () => ({
  createBackfilledSD: (...a: unknown[]) => createBackfilledSD(...a),
  isValidServiceType: () => true,
}))
vi.mock("@/lib/operations/feed-payer-contact", () => ({
  findOrCreatePayerContact: (...a: unknown[]) => findOrCreatePayerContact(...a),
  removeJustCreatedPayerContact: (...a: unknown[]) => removeJustCreatedPayerContact(...a),
  payerContactIdForFeed: () => DERIVED_CONTACT,
}))
vi.mock("@/lib/operations/feed-story-note", () => ({
  writeFeedStoryToInvoices: (...a: unknown[]) => writeFeedStoryToInvoices(...a),
  describeStoryResult: (r: { written?: string[] }) => (r?.written?.length ? "The investigation was saved on the invoice's note." : null),
}))
vi.mock("@/lib/finance/refund-gate", () => ({ stripeRefundGate: (...a: unknown[]) => stripeRefundGate(...a) }))

import { POST } from "@/app/api/feed/create-from-feed/route"

const req = (body: Record<string, unknown>) => new NextRequest("http://localhost/api/feed/create-from-feed", { method: "POST", body: JSON.stringify(body) })
const newPersonBody = { feed_id: FEED_ID, new_contact: { full_name: "Simone Fattor", email: "" }, service_type: "Apostille" }

beforeEach(() => {
  user = { id: "staff-1" }
  feedRow = {
    id: FEED_ID, source: "stripe", external_id: "ch_123", transaction_date: "2026-05-29", amount: 500, currency: "EUR",
    sender_name: "Simone Fattor", status: "unmatched", matched_payment_id: null, owner_account_number: null,
  }
  existingPayment = null
  sdDeleteError = null
  refundError = undefined
  paidCall = { kind: "none" }
  order.length = 0
  manualMatch.mockReset()
  manualMatch.mockImplementation(async () => { order.push("manualMatch"); return { matched: true } })
  createTDInvoice.mockReset()
  createTDInvoice.mockImplementation(async () => { order.push("createTDInvoice"); return { paymentId: "pay-new", invoiceNumber: "INV-000999" } })
  createBackfilledSD.mockReset()
  createBackfilledSD.mockImplementation(async () => { order.push("createBackfilledSD"); return { id: "sd-new" } })
  findOrCreatePayerContact.mockReset()
  findOrCreatePayerContact.mockImplementation(async () => { order.push("findOrCreatePayerContact"); return { ok: true, contactId: DERIVED_CONTACT, created: true, fullName: "Simone Fattor" } })
  removeJustCreatedPayerContact.mockReset()
  removeJustCreatedPayerContact.mockImplementation(async () => { order.push("removeContact"); return true })
  writeFeedStoryToInvoices.mockReset()
  writeFeedStoryToInvoices.mockResolvedValue({ hadStory: true, written: ["pay-new"], alreadyThere: [], skipped: [], failed: [] })
  recordPaidCall.mockReset()
  stripeRefundGate.mockReset()
  stripeRefundGate.mockImplementation(async () => { order.push("refundGate"); return refundError ? { error: refundError } : {} })
})

const nothingWasCreated = () => {
  expect(findOrCreatePayerContact).not.toHaveBeenCalled()
  expect(createBackfilledSD).not.toHaveBeenCalled()
  expect(createTDInvoice).not.toHaveBeenCalled()
  expect(manualMatch).not.toHaveBeenCalled()
  expect(recordPaidCall).not.toHaveBeenCalled()
}

describe("a refunded or disputed card payment is not invoiced", () => {
  beforeEach(() => { refundError = "This Stripe payment has been refunded or disputed — the money is no longer ours, so it was NOT linked to any invoice." })

  it("for a NEW PERSON: 409, and no person, no service delivery, no invoice is created", async () => {
    const res = await POST(req(newPersonBody))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/refunded or disputed/)
    nothingWasCreated()
  })

  it("for an existing client: 409 and nothing created", async () => {
    const res = await POST(req({ feed_id: FEED_ID, contact_id: CONTACT_A, service_type: "Apostille" }))
    expect(res.status).toBe(409)
    nothingWasCreated()
  })

  it("for a paid strategy call: 409 and no call credit is recorded", async () => {
    paidCall = { kind: "paid_call", revenueOnly: false }
    const res = await POST(req({ feed_id: FEED_ID, contact_id: CONTACT_A, paid_call: true }))
    expect(res.status).toBe(409)
    nothingWasCreated()
  })

  it("asks Stripe about THIS charge", async () => {
    await POST(req(newPersonBody))
    expect(stripeRefundGate).toHaveBeenCalledWith(expect.objectContaining({ source: "stripe", external_id: "ch_123" }))
  })

  it("is asked before the person is created, not after", async () => {
    refundError = undefined
    await POST(req(newPersonBody))
    expect(order.indexOf("refundGate")).toBeGreaterThanOrEqual(0)
    expect(order.indexOf("refundGate")).toBeLessThan(order.indexOf("findOrCreatePayerContact"))
  })

  it("a charge Stripe cannot confirm right now ('try again') also stops, with Stripe's wording", async () => {
    refundError = "Could not verify this payment with Stripe right now — try again in a moment."
    const res = await POST(req(newPersonBody))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/try again/)
    nothingWasCreated()
  })
})

describe("a retry cannot move the money to someone else", () => {
  it("first attempt was for contact A; retrying with contact B is REFUSED — no link, no story, and the message says so", async () => {
    existingPayment = { id: "pay-old", account_id: null, contact_id: CONTACT_A, invoice_number: "INV-000500" }
    const res = await POST(req({ feed_id: FEED_ID, contact_id: CONTACT_B, service_type: "Apostille" }))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/already has an invoice \(INV-000500\) made for someone else/)
    expect(manualMatch).not.toHaveBeenCalled()
    expect(writeFeedStoryToInvoices).not.toHaveBeenCalled()
    expect(createTDInvoice).not.toHaveBeenCalled()
  })

  it("first attempt was for company X; retrying with a contact is REFUSED", async () => {
    existingPayment = { id: "pay-old", account_id: ACCOUNT_X, contact_id: null, invoice_number: "INV-000500" }
    expect((await POST(req({ feed_id: FEED_ID, contact_id: CONTACT_B, service_type: "Apostille" }))).status).toBe(409)
  })

  it("first attempt was for an existing person; retrying as a NEW person is REFUSED", async () => {
    existingPayment = { id: "pay-old", account_id: null, contact_id: CONTACT_A, invoice_number: "INV-000500" }
    const res = await POST(req(newPersonBody))
    expect(res.status).toBe(409)
    expect(findOrCreatePayerContact).not.toHaveBeenCalled()
  })

  it("the SAME contact retrying with an unlinked feed finishes the link and says so", async () => {
    existingPayment = { id: "pay-old", account_id: null, contact_id: CONTACT_A, invoice_number: "INV-000500" }
    writeFeedStoryToInvoices.mockResolvedValue({ hadStory: true, written: ["pay-old"], alreadyThere: [], skipped: [], failed: [] })
    const res = await POST(req({ feed_id: FEED_ID, contact_id: CONTACT_A, service_type: "Apostille" }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(manualMatch).toHaveBeenCalledWith(FEED_ID, "pay-old")
    expect(body).toMatchObject({ payment_id: "pay-old", invoice_number: "INV-000500", idempotent: true })
    expect(body.story).toMatch(/saved on the invoice/)
    // the invoice was made by this flow for this payment, so the story belongs on it
    expect(writeFeedStoryToInvoices).toHaveBeenCalledWith(FEED_ID, ["pay-old"], ["pay-old"])
    expect(createTDInvoice).not.toHaveBeenCalled()
  })

  it("the same NEW PERSON retrying (their record carries the derived id) is accepted, not mistaken for someone else", async () => {
    existingPayment = { id: "pay-old", account_id: null, contact_id: DERIVED_CONTACT, invoice_number: "INV-000500" }
    const res = await POST(req(newPersonBody))
    expect(res.status).toBe(200)
    expect(manualMatch).toHaveBeenCalledWith(FEED_ID, "pay-old")
    expect(findOrCreatePayerContact).not.toHaveBeenCalled()
  })

  it("the same company retrying is accepted", async () => {
    existingPayment = { id: "pay-old", account_id: ACCOUNT_X, contact_id: null, invoice_number: "INV-000500" }
    expect((await POST(req({ feed_id: FEED_ID, account_id: ACCOUNT_X, service_type: "Apostille" }))).status).toBe(200)
  })

  it("a retry whose link fails again says so and writes no story", async () => {
    existingPayment = { id: "pay-old", account_id: null, contact_id: CONTACT_A, invoice_number: "INV-000500" }
    manualMatch.mockResolvedValue({ matched: false, error: "Could not verify this payment with Stripe right now" })
    const body = await (await POST(req({ feed_id: FEED_ID, contact_id: CONTACT_A, service_type: "Apostille" }))).json()
    expect(body.warning).toMatch(/feed link failed: Could not verify/)
    expect(writeFeedStoryToInvoices).not.toHaveBeenCalled()
  })
})

describe("invoicing a person who is not in the CRM", () => {
  it("creates the person, then the service delivery, then the PAID invoice, then links, then writes the story — in that order", async () => {
    const res = await POST(req(newPersonBody))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(order).toEqual(["refundGate", "findOrCreatePayerContact", "createBackfilledSD", "createTDInvoice", "manualMatch"])
    expect(createTDInvoice).toHaveBeenCalledWith(expect.objectContaining({ contact_id: DERIVED_CONTACT, currency: "EUR", mark_as_paid: true, idempotency_key: `feed-flow-create:${FEED_ID}` }))
    expect(createTDInvoice.mock.calls[0][0].line_items[0]).toMatchObject({ unit_price: 500, quantity: 1 })
    expect(body).toMatchObject({ payment_id: "pay-new", invoice_number: "INV-000999", contact_id: DERIVED_CONTACT, attached: false })
    expect(writeFeedStoryToInvoices).toHaveBeenCalledWith(FEED_ID, ["pay-new"], ["pay-new"])
  })

  it("'do not write the story' is respected", async () => {
    const res = await POST(req({ ...newPersonBody, save_story: false }))
    expect(res.status).toBe(200)
    expect(writeFeedStoryToInvoices).not.toHaveBeenCalled()
  })

  it("someone already in the CRM is NOT created again: 409 with who they are, and nothing else is created", async () => {
    findOrCreatePayerContact.mockResolvedValue({ ok: false, kind: "exists", error: "Simone Fattor is already in the CRM. Search for them and pick them instead.", existing: { id: CONTACT_A, name: "Simone Fattor", email: null } })
    const res = await POST(req(newPersonBody))
    const body = await res.json()
    expect(res.status).toBe(409)
    expect(body.existing).toMatchObject({ id: CONTACT_A })
    expect(createBackfilledSD).not.toHaveBeenCalled()
    expect(createTDInvoice).not.toHaveBeenCalled()
  })

  it("another request is already creating this person: 409, nothing created", async () => {
    findOrCreatePayerContact.mockResolvedValue({ ok: false, kind: "in_progress", error: "This person is already being created for this payment." })
    expect((await POST(req(newPersonBody))).status).toBe(409)
    expect(createTDInvoice).not.toHaveBeenCalled()
  })

  it("an invalid name or email: 400", async () => {
    findOrCreatePayerContact.mockResolvedValue({ ok: false, kind: "invalid", error: "Enter the person's name." })
    expect((await POST(req(newPersonBody))).status).toBe(400)
  })

  it("if the invoice cannot be made, the service delivery AND the person this request created are undone", async () => {
    createTDInvoice.mockRejectedValue(new Error("insert failed"))
    const res = await POST(req(newPersonBody))
    expect(res.status).toBe(500)
    expect(order).toEqual(["refundGate", "findOrCreatePayerContact", "createBackfilledSD", "delete:service_deliveries", "removeContact"])
  })

  it("if the service delivery cannot be removed, the person stays — something still points to them", async () => {
    createTDInvoice.mockRejectedValue(new Error("insert failed"))
    sdDeleteError = { message: "fk violation" }
    await POST(req(newPersonBody))
    expect(removeJustCreatedPayerContact).not.toHaveBeenCalled()
  })

  it("a person that already existed (reused leftover, created:false) is never deleted by an undo", async () => {
    findOrCreatePayerContact.mockResolvedValue({ ok: true, contactId: DERIVED_CONTACT, created: false, fullName: "Simone Fattor" })
    createTDInvoice.mockRejectedValue(new Error("insert failed"))
    await POST(req(newPersonBody))
    expect(removeJustCreatedPayerContact).not.toHaveBeenCalled()
  })

  it("the invoice is made but the link to the feed fails: the answer carries the invoice AND a warning, and the person stays", async () => {
    manualMatch.mockResolvedValue({ matched: false, error: "amount differs" })
    const body = await (await POST(req(newPersonBody))).json()
    expect(body).toMatchObject({ payment_id: "pay-new", warning: expect.stringMatching(/feed link failed: amount differs/) })
    expect(removeJustCreatedPayerContact).not.toHaveBeenCalled()
    expect(writeFeedStoryToInvoices).not.toHaveBeenCalled()
  })

  it("a new person cannot be combined with a paid call, an existing service, or another target", async () => {
    expect((await POST(req({ ...newPersonBody, service_delivery_id: "sd-1" }))).status).toBe(400)
    expect((await POST(req({ ...newPersonBody, contact_id: CONTACT_A }))).status).toBe(400)
    paidCall = { kind: "paid_call", revenueOnly: false }
    expect((await POST(req({ ...newPersonBody, paid_call: true }))).status).toBe(400)
    nothingWasCreated()
  })
})

describe("payments that cannot be invoiced from here", () => {
  it.each([
    ["GBP", { currency: "GBP" }],
    ["an unknown currency", { currency: null }],
    ["a payment that is not positive", { amount: -500 }],
    ["a zero payment", { amount: 0 }],
    ["an outgoing payment", { status: "outgoing" }],
    ["private owner money", { status: "owner_ledger" }],
    ["a duplicate", { status: "duplicate" }],
    ["a payment into one of the owner's own accounts", { owner_account_number: "1234" }],
  ])("%s: 400 and nothing created", async (_label, over) => {
    feedRow = { ...feedRow!, ...over }
    const res = await POST(req(newPersonBody))
    expect(res.status).toBe(400)
    nothingWasCreated()
  })

  it("a payment that is already matched: 409", async () => {
    feedRow = { ...feedRow!, status: "matched", matched_payment_id: "pay-x" }
    expect((await POST(req(newPersonBody))).status).toBe(409)
    nothingWasCreated()
  })

  it("not signed in: 401", async () => {
    user = null
    expect((await POST(req(newPersonBody))).status).toBe(401)
  })
})
