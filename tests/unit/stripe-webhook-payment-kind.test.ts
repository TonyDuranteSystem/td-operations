/**
 * Regression suite for TD Marketing job J-A: a tagged (non-client) Stripe payment
 * must not touch client records, while an untagged / service_sale payment behaves
 * exactly as before (convert lead, upgrade tier, consume pending activation).
 * Drives the REAL route with a signed fixture and a recording fake database.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import crypto from "node:crypto"

const calls: { table: string; op: string; payload?: unknown }[] = []
const tables: Record<string, unknown[]> = {}
let eventInsertError: { code?: string; message: string } | null = null

function builder(table: string) {
  let op = "select"
  let payload: unknown
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const b: any = {
    select: () => b,
    insert: (p: unknown) => { op = "insert"; payload = p; calls.push({ table, op, payload }); return b },
    update: (p: unknown) => { op = "update"; payload = p; calls.push({ table, op, payload }); return b },
    eq: () => b, ilike: () => b, in: () => b, is: () => b, limit: () => b, order: () => b,
    single: () => Promise.resolve({ data: (tables[table] || [])[0] ?? null, error: null }),
    maybeSingle: () => Promise.resolve({ data: (tables[table] || [])[0] ?? null, error: null }),
    then: (res: (v: unknown) => unknown) => {
      if (op === "select") calls.push({ table, op: "select" })
      const data = op === "select" ? (tables[table] || []) : [{ id: "row-1" }]
      const error = op === "insert" && table === "webhook_events" ? eventInsertError : null
      return Promise.resolve({ data, error }).then(res)
    },
  }
  return b
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: (t: string) => builder(t) }),
}))
const runActivation = vi.fn(async () => ({ ok: true }))
vi.mock("@/lib/operations/activate-service", () => ({ runActivation: (id: string) => runActivation(id) }))
vi.mock("@/lib/catalog/framework", () => ({ resolveExternalValue: vi.fn(async () => undefined) }))
vi.mock("@/lib/operations/credit-reversal", () => ({ handleChargeReversal: vi.fn() }))
vi.mock("@/lib/operations/card-autopay", () => ({ saveAutopayCard: vi.fn() }))
const upgradePortalTier = vi.fn(async () => undefined)
vi.mock("@/lib/portal/auto-create", () => ({
  upgradePortalTier: (...a: unknown[]) => upgradePortalTier(...a),
  tierForContract: () => "onboarding",
}))
vi.mock("@/lib/portal/chat-events", () => ({ emitPaymentReceivedEvent: vi.fn() }))
const reconcile = vi.fn(async () => ({ reconciled: false }))
vi.mock("@/lib/operations/payment", () => ({ reconcilePaymentByInvoiceNumber: (...a: unknown[]) => reconcile(...a) }))
vi.mock("@/lib/finance/card-fee-booking", () => ({ bookCardFee: vi.fn(async () => ({ outcome: "ok" })) }))
vi.mock("@/lib/finance/card-fee-issues", () => ({ raiseCardFeeOverageIssue: vi.fn(), raiseActivationFailedIssue: vi.fn() }))

const notifyParked = vi.fn(async () => ({ emitted: false }))
vi.mock("@/lib/incoming-payments/notify", () => ({ notifyUnlabelledPayment: (...a: unknown[]) => notifyParked(...(a as [])) }))
const recordLink = vi.fn(async () => undefined)
vi.mock("@/lib/incoming-payments/link-payment", () => ({ recordPaidCallFromSession: (...a: unknown[]) => recordLink(...(a as [])) }))

import { POST } from "@/app/api/webhooks/stripe/route"
import { NextRequest } from "next/server"

const SECRET = "whsec_test_secret"

async function send(metadata: Record<string, string>) {
  const event = {
    id: "evt_1",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_1",
        mode: "payment",
        payment_intent: "pi_test_1",
        amount_total: 5000,
        currency: "usd",
        customer_details: { email: "payer@example.com", name: "Payer" },
        metadata,
      },
    },
  }
  const body = JSON.stringify(event)
  const t = Math.floor(Date.now() / 1000)
  const sig = crypto.createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex")
  const req = new NextRequest("http://localhost/api/webhooks/stripe", {
    method: "POST",
    body,
    headers: { "stripe-signature": `t=${t},v1=${sig}` },
  })
  return POST(req)
}

const wrote = (table: string, op: string) => calls.some(c => c.table === table && c.op === op)
const touched = (table: string) => calls.some(c => c.table === table)

beforeEach(() => {
  calls.length = 0
  eventInsertError = null
  for (const k of Object.keys(tables)) delete tables[k]
  tables.contacts = [{ id: "c1", account_contacts: [{ account_id: "a1" }] }]
  tables.leads = [{ id: "lead-1" }]
  tables.pending_activations = [{ id: "pa-1", offer_token: "tok", lead_id: "lead-1", portal_invoice_id: null }]
  runActivation.mockClear(); upgradePortalTier.mockClear(); reconcile.mockClear(); recordLink.mockReset(); recordLink.mockResolvedValue(undefined); notifyParked.mockClear()
  process.env.STRIPE_WEBHOOK_SECRET = SECRET
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost"
  process.env.SUPABASE_SERVICE_ROLE_KEY = "x"
})

describe("Stripe webhook — tagged non-client payment", () => {
  it.each(["marketing_sale", "something_else"])("payment_kind=%s: no client effects at all", async kind => {
    const res = await send({
      payment_kind: kind,
      client_email: "payer@example.com",
      offer_token: "tok",
      invoice_number: "INV-000123",
      lead_id: "lead-1",
    })
    expect(res.status).toBe(200)
    expect(wrote("webhook_events", "insert")).toBe(true) // the record the ledger reads
    expect(touched("leads")).toBe(false)               // no conversion, no email lookup
    expect(touched("contacts")).toBe(false)            // no client lookup by payer email
    expect(touched("pending_activations")).toBe(false) // no activation, no email fallback
    expect(touched("payments")).toBe(false)            // no client payment row
    expect(touched("offers")).toBe(false)
    expect(upgradePortalTier).not.toHaveBeenCalled()
    expect(runActivation).not.toHaveBeenCalled()
    expect(reconcile).not.toHaveBeenCalled()           // no invoice-number reconcile
  })

  it("tag with no other identifiers is still skipped (payer email alone cannot activate anything)", async () => {
    const res = await send({ payment_kind: "marketing_sale" })
    expect(res.status).toBe(200)
    expect(touched("pending_activations")).toBe(false)
    expect(upgradePortalTier).not.toHaveBeenCalled()
    expect(runActivation).not.toHaveBeenCalled()
  })
})

describe("Stripe webhook — a tagged payment whose record cannot be saved", () => {
  it("answers 500 so Stripe retries, and touches nothing else", async () => {
    eventInsertError = { code: "08006", message: "connection lost" }
    const res = await send({ payment_kind: "marketing_sale" })
    expect(res.status).toBe(500)
    expect(touched("leads")).toBe(false)
    expect(touched("payments")).toBe(false)
    expect(runActivation).not.toHaveBeenCalled()
  })
  it("a redelivery (unique violation) is acknowledged, not retried forever, and not double counted", async () => {
    eventInsertError = { code: "23505", message: "duplicate key value violates unique constraint" }
    const res = await send({ payment_kind: "marketing_sale" })
    expect(res.status).toBe(200)
    expect(touched("leads")).toBe(false)
    expect(touched("payments")).toBe(false)
  })
})

describe("Stripe webhook — normal client payment is unchanged", () => {
  it("a normal payment is still processed even if the event record fails (behaviour deliberately unchanged)", async () => {
    eventInsertError = { code: "08006", message: "connection lost" }
    const res = await send({ offer_token: "tok", client_email: "payer@example.com", contract_type: "onboarding" })
    expect(res.status).toBe(200)
    expect(wrote("leads", "update")).toBe(true)
  })

  it("untagged payment still converts the lead, upgrades the tier, consumes the activation", async () => {
    const res = await send({ offer_token: "tok", client_email: "payer@example.com", contract_type: "onboarding" })
    expect(res.status).toBe(200)
    expect(wrote("leads", "update")).toBe(true)
    expect(upgradePortalTier).toHaveBeenCalledTimes(1)
    expect(wrote("pending_activations", "update")).toBe(true)
    expect(runActivation).toHaveBeenCalledWith("pa-1")
  })

  it("explicit service_sale behaves like an untagged payment", async () => {
    const res = await send({ payment_kind: "service_sale", offer_token: "tok", client_email: "payer@example.com" })
    expect(res.status).toBe(200)
    expect(wrote("leads", "update")).toBe(true)
    expect(upgradePortalTier).toHaveBeenCalledTimes(1)
    expect(runActivation).toHaveBeenCalledWith("pa-1")
  })

  it("untagged payment carrying an invoice number still reconciles to it", async () => {
    tables.pending_activations = []
    await send({ invoice_number: "INV-000123", client_email: "payer@example.com" })
    expect(reconcile).toHaveBeenCalledTimes(1)
  })
})

describe("Stripe webhook — a payment with NO label at all waits for confirmation (dev job 40a58d9a, Ranieri)", () => {
  it("changes nothing: no lead conversion, no client lookup, no activation, no payment row, no tier", async () => {
    const res = await send({})
    expect(res.status).toBe(200)
    expect(wrote("webhook_events", "insert")).toBe(true) // the record the Calendar's waiting list is read from
    expect(touched("leads")).toBe(false)
    expect(touched("contacts")).toBe(false)
    expect(touched("pending_activations")).toBe(false)
    expect(touched("payments")).toBe(false)
    expect(upgradePortalTier).not.toHaveBeenCalled()
    expect(runActivation).not.toHaveBeenCalled()
    expect(reconcile).not.toHaveBeenCalled()
    expect(notifyParked).toHaveBeenCalledTimes(1) // a known client also gets a line in What's New (best effort)
  })

  it("a labelled payment never posts the 'Payment to confirm' note", async () => {
    await send({ offer_token: "tok", client_email: "payer@example.com", contract_type: "onboarding" })
    expect(notifyParked).not.toHaveBeenCalled()
  })

  it("the payer's email alone cannot convert a lead or consume an activation", async () => {
    const res = await send({ client_email: "payer@example.com" })
    // client_email is not one of our labels (the offer checkout always adds source/offer_token/lead_id with it)
    expect(res.status).toBe(200)
    expect(touched("leads")).toBe(false)
    expect(touched("pending_activations")).toBe(false)
  })

  it("answers 500 when the event cannot be saved, so Stripe sends it again and it can never silently vanish", async () => {
    eventInsertError = { code: "08006", message: "connection lost" }
    const res = await send({})
    expect(res.status).toBe(500)
    expect(touched("leads")).toBe(false)
  })

  it("a redelivery (unique violation) is acknowledged", async () => {
    eventInsertError = { code: "23505", message: "duplicate key" }
    const res = await send({})
    expect(res.status).toBe(200)
    expect(touched("leads")).toBe(false)
  })

  it("our own offer checkout label (source) keeps the normal client flow", async () => {
    const res = await send({ source: "td-operations", offer_token: "", lead_id: "lead-1", client_email: "payer@example.com", contract_type: "onboarding" })
    expect(res.status).toBe(200)
    expect(wrote("leads", "update")).toBe(true)
  })
})

describe("Stripe webhook — a paid call paid through a CRM-made link (payment_kind=paid_call, Phase 2)", () => {
  it("records the paid call itself and still changes no client record", async () => {
    const res = await send({ payment_kind: "paid_call", crm_lead_ref: "lead-1", client_email: "payer@example.com" })
    expect(res.status).toBe(200)
    expect(recordLink).toHaveBeenCalledTimes(1)
    expect(touched("leads")).toBe(false)               // the webhook itself never converts or edits the lead
    expect(touched("pending_activations")).toBe(false)
    expect(touched("payments")).toBe(false)            // the invoice/credit are written by the shared recorder, not here
    expect(upgradePortalTier).not.toHaveBeenCalled()
    expect(runActivation).not.toHaveBeenCalled()
  })

  it("a failed recording answers 500 so Stripe sends the event again (the payment cannot live only in the event log)", async () => {
    recordLink.mockRejectedValue(new Error("contact creation failed"))
    const res = await send({ payment_kind: "paid_call" })
    expect(res.status).toBe(500)
  })

  it("on a redelivery the recording runs again BEFORE the 'already saved' acknowledgement (it is idempotent), so a failed first attempt is healed", async () => {
    eventInsertError = { code: "23505", message: "duplicate key" }
    const res = await send({ payment_kind: "paid_call" })
    expect(res.status).toBe(200)
    expect(recordLink).toHaveBeenCalledTimes(1)
  })

  it("other tagged kinds (marketing, unknown) never reach the paid-call recorder", async () => {
    await send({ payment_kind: "something_else" })
    expect(recordLink).not.toHaveBeenCalled()
  })

  it("the 'other' link carries no label: it waits like any unlabelled payment and records nothing", async () => {
    const res = await send({ crm_lead_ref: "lead-1", client_email: "payer@example.com" })
    expect(res.status).toBe(200)
    expect(recordLink).not.toHaveBeenCalled()
    expect(touched("leads")).toBe(false)
    expect(touched("payments")).toBe(false)
  })
})
