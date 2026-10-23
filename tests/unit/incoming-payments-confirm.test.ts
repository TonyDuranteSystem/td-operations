/**
 * Confirming a waiting payment (dev job 40a58d9a). The database is a recording fake; recordPaidCall and the event loader are mocked
 * so the test pins WHAT is asked of them: the money always comes from the saved event, never the request; the lead is never converted.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const calls: { table: string; op: string; payload?: unknown }[] = []
const tables: Record<string, unknown[]> = {}
let insertError: { code?: string; message: string } | null = null

function builder(table: string) {
  let op = "select"
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const b: any = {
    select: () => b,
    insert: (p: unknown) => { op = "insert"; calls.push({ table, op, payload: p }); return b },
    update: (p: unknown) => { op = "update"; calls.push({ table, op, payload: p }); return b },
    eq: () => b,
    maybeSingle: () => Promise.resolve({ data: (tables[table] || [])[0] ?? null, error: null }),
    then: (res: (v: unknown) => unknown) => Promise.resolve({ data: null, error: op === "insert" ? insertError : null }).then(res),
  }
  return b
}
vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: { from: (t: string) => builder(t) } }))

const recordPaidCall = vi.fn()
vi.mock("@/lib/operations/paid-call-credit", () => ({ recordPaidCall: (...a: unknown[]) => recordPaidCall(...a) }))
const loadOne = vi.fn()
vi.mock("@/lib/incoming-payments/load", () => ({ loadWaitingPaymentBySession: (id: string) => loadOne(id) }))

import { confirmIncomingPayment } from "@/lib/incoming-payments/confirm"

const SESSION = "cs_live_abc12345"
const WAITING = { sessionId: SESSION, paymentIntentId: "pi_1", paymentLinkId: "plink_1", amount: 397, currency: "EUR" as const, email: "chris@example.com", name: "Christian Ranieri", paidAt: "2026-10-23T13:26:47Z" }
const wrote = (table: string, op: string) => calls.filter(c => c.table === table && c.op === op)

beforeEach(() => {
  calls.length = 0
  insertError = null
  for (const k of Object.keys(tables)) delete tables[k]
  recordPaidCall.mockReset()
  recordPaidCall.mockResolvedValue({ contactId: "c1", invoiceId: "p1", creditId: "p2", invoiceNumber: "INV-1", creditNumber: "CN-1" })
  loadOne.mockReset()
  loadOne.mockResolvedValue(WAITING)
})

describe("confirmIncomingPayment", () => {
  it("paid_call: records revenue + a live credit from the SAVED event, then settles the session", async () => {
    const r = await confirmIncomingPayment({ sessionId: SESSION, resolution: "paid_call", actor: "antonio@x" })
    expect(r).toMatchObject({ ok: true, resolution: "paid_call", alreadySettled: false, invoiceNumber: "INV-1", creditNumber: "CN-1" })
    const arg = recordPaidCall.mock.calls[0][0]
    expect(arg.payment).toMatchObject({ amount: 397, currency: "EUR", provider: "stripe", paymentIntentId: "pi_1" })
    expect(arg.inviteeEmail).toBe("chris@example.com")
    expect(arg.manual).toMatchObject({ feedId: `stripe-session:${SESSION}`, creditUsedAtCreation: false })
    expect(wrote("incoming_payment_resolutions", "insert")[0].payload).toMatchObject({ stripe_session_id: SESSION, resolution: "paid_call", resolved_by: "antonio@x", invoice_payment_id: "p1", credit_payment_id: "p2" })
  })

  it("paid_call_already_deducted: the credit is born used so it can never be deducted twice", async () => {
    await confirmIncomingPayment({ sessionId: SESSION, resolution: "paid_call_already_deducted", actor: "a" })
    expect(recordPaidCall.mock.calls[0][0].manual.creditUsedAtCreation).toBe(true)
  })

  it("never converts a lead and never tags a client record", async () => {
    tables.leads = [{ id: "11111111-1111-4111-8111-111111111111", email: "lead@example.com", full_name: "Lead", notes: null, is_test: false }]
    await confirmIncomingPayment({ sessionId: SESSION, resolution: "paid_call", leadId: "11111111-1111-4111-8111-111111111111", actor: "a" })
    const leadUpdates = wrote("leads", "update").map(c => Object.keys(c.payload as object))
    expect(leadUpdates).toEqual([["notes"]]) // only the dated note line: no status, no converted_to_*, no existing_client_contact_id
    expect(recordPaidCall.mock.calls[0][0].inviteeEmail).toBe("lead@example.com") // the lead's email wins over the payer's
  })

  it("recorded_elsewhere needs a note, writes nothing to the books, and settles the session", async () => {
    const bad = await confirmIncomingPayment({ sessionId: SESSION, resolution: "recorded_elsewhere", note: " ", actor: "a" })
    expect(bad).toMatchObject({ ok: false, status: 400 })
    const ok = await confirmIncomingPayment({ sessionId: SESSION, resolution: "recorded_elsewhere", note: "Entered by hand on INV-5", actor: "a" })
    expect(ok).toMatchObject({ ok: true, resolution: "recorded_elsewhere" })
    expect(recordPaidCall).not.toHaveBeenCalled()
    expect(wrote("incoming_payment_resolutions", "insert")).toHaveLength(1)
  })

  it("an already settled payment is a calm no-op: nothing recorded twice", async () => {
    tables.incoming_payment_resolutions = [{ resolution: "paid_call" }]
    const r = await confirmIncomingPayment({ sessionId: SESSION, resolution: "paid_call", actor: "a" })
    expect(r).toMatchObject({ ok: true, alreadySettled: true })
    expect(recordPaidCall).not.toHaveBeenCalled()
  })

  it("refuses a payment that is not waiting (labelled, or not in the saved events)", async () => {
    loadOne.mockResolvedValue(null)
    expect(await confirmIncomingPayment({ sessionId: SESSION, resolution: "paid_call", actor: "a" })).toMatchObject({ ok: false, status: 404 })
    expect(recordPaidCall).not.toHaveBeenCalled()
  })

  it("rejects garbage input before touching anything", async () => {
    expect(await confirmIncomingPayment({ sessionId: "nope", resolution: "paid_call", actor: "a" })).toMatchObject({ ok: false, status: 400 })
    expect(await confirmIncomingPayment({ sessionId: SESSION, resolution: "convert_lead", actor: "a" })).toMatchObject({ ok: false, status: 400 })
    expect(await confirmIncomingPayment({ sessionId: SESSION, resolution: "paid_call", leadId: "not-a-uuid", actor: "a" })).toMatchObject({ ok: false, status: 400 })
    expect(recordPaidCall).not.toHaveBeenCalled()
  })

  it("no email anywhere: asks for a lead instead of recording a credit nobody can find", async () => {
    loadOne.mockResolvedValue({ ...WAITING, email: null })
    const r = await confirmIncomingPayment({ sessionId: SESSION, resolution: "paid_call", actor: "a" })
    expect(r).toMatchObject({ ok: false, status: 400 })
    expect(recordPaidCall).not.toHaveBeenCalled()
  })

  it("a recording failure is reported in the server's own words and nothing is settled", async () => {
    recordPaidCall.mockRejectedValue(new Error("contact creation failed"))
    const r = await confirmIncomingPayment({ sessionId: SESSION, resolution: "paid_call", actor: "a" })
    expect(r).toMatchObject({ ok: false, status: 500 })
    expect((r as { error: string }).error).toContain("contact creation failed")
    expect(wrote("incoming_payment_resolutions", "insert")).toHaveLength(0)
  })

  it("a colleague settling the same payment at the same moment (unique violation) is success, not an error", async () => {
    insertError = { code: "23505", message: "duplicate key" }
    expect(await confirmIncomingPayment({ sessionId: SESSION, resolution: "paid_call", actor: "a" })).toMatchObject({ ok: true })
  })
})
