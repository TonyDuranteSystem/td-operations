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
      return Promise.resolve({ data, error: null }).then(res)
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
  for (const k of Object.keys(tables)) delete tables[k]
  tables.contacts = [{ id: "c1", account_contacts: [{ account_id: "a1" }] }]
  tables.leads = [{ id: "lead-1" }]
  tables.pending_activations = [{ id: "pa-1", offer_token: "tok", lead_id: "lead-1", portal_invoice_id: null }]
  runActivation.mockClear(); upgradePortalTier.mockClear(); reconcile.mockClear()
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

describe("Stripe webhook — normal client payment is unchanged", () => {
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
