import { describe, it, expect, vi, beforeEach } from "vitest"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

/**
 * "Invoices to raise" — the money side (dev job ae3c19db). Antonio, 2026-11-11: nothing automatic; the invoice goes to whoever SIGNED the
 * contract (the offer's own "Invoice to"), never to the company the offer was later linked to; one click raises AND sends; a second
 * click can never bill twice.
 */
const tables: Record<string, unknown[] | { error: { message: string } }> = {}
const inserted: Array<{ table: string; row: unknown }> = []
let offerRow: Record<string, unknown> | null = null
let leadRow: Record<string, unknown> | null = null
let leadError: string | null = null
/** The payer columns of the invoice createTDInvoice handed back (null = the check has nothing to compare and lets it through). */
let madePayerRow: Record<string, unknown> | null = null
let claimWins = true
const updates: Array<{ table: string; patch: unknown }> = []
const calls: Array<{ table: string; method: string; args: unknown[] }> = []

vi.mock("@/lib/supabase-admin", () => {
  const make = (table: string) => {
    const c: Record<string, unknown> = {}
    let op = "select"
    const result = () => {
      if (op === "update") return table === "payments" ? { data: claimWins ? [{ id: "pay-2" }] : [], error: null } : { data: [], error: null }
      const t = tables[table]
      if (t && !Array.isArray(t) && "error" in t) return { data: null, error: t.error }
      return { data: (t as unknown[]) ?? [], error: null }
    }
    c.select = () => c
    c.in = (...a: unknown[]) => { calls.push({ table, method: "in", args: a }); return c }
    c.not = () => c
    c.eq = () => c
    c.or = () => c
    c.update = (patch: unknown) => { op = "update"; updates.push({ table, patch }); return c }
    c.maybeSingle = async () => {
      if (table === "offers") return { data: offerRow, error: null }
      if (table === "leads") return leadError ? { data: null, error: { message: leadError } } : { data: leadRow, error: null }
      if (table === "payments") return { data: madePayerRow, error: null }
      return { data: null, error: null }
    }
    c.insert = async (row: unknown) => { inserted.push({ table, row }); return { error: null } }
    c.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result()).then(res, rej)
    return c
  }
  return { supabaseAdmin: { from: (t: string) => make(t) } }
})

const createTDInvoice = vi.fn()
const sendTDInvoice = vi.fn()
vi.mock("@/lib/portal/td-invoice", () => ({ createTDInvoice: (...a: unknown[]) => createTDInvoice(...a) }))
vi.mock("@/lib/invoice-auto-send", () => ({ sendTDInvoice: (...a: unknown[]) => sendTDInvoice(...a) }))

let planStatus: unknown = null
vi.mock("@/lib/offers/payment-plan-state", async (orig) => ({
  ...(await orig<object>()),
  planStatusForOffer: async () => planStatus,
  resolveTrancheCardFeeRate: async () => 0.05,
}))
// the real, pure rule for who is billed — no database
vi.mock("@/lib/offers/bill-to-server", async () => {
  const { resolveInvoiceTarget } = await import("@/lib/offers/bill-to")
  return { invoiceTargetForOffer: async (p: Parameters<typeof resolveInvoiceTarget>[0]) => { const t = resolveInvoiceTarget(p); return { account_id: t.account_id, contact_id: t.contact_id, billing_entity_id: t.billing_entity_id } } }
})

import { validatePaymentPlan } from "@/lib/offers/payment-plan"
import { computePlanStatus } from "@/lib/offers/payment-plan-state"
import { raiseAndSendPlanPart } from "@/lib/plan-invoices/raise"
import { loadInvoicesToRaise, countInvoicesDue } from "@/lib/plan-invoices/load"

const PLAN_RAW = (second: Record<string, unknown>) => [
  { seq: 1, amount: 1900, currency: "EUR", trigger: { kind: "signing" } },
  { seq: 2, amount: 1900, currency: "EUR", trigger: second },
]
const EIN = { kind: "step", service_type: "Company Formation", stage: "EIN Received", label: "After the EIN arrives" }
const statusFor = (second: Record<string, unknown>, rows: Array<Record<string, unknown>> = []) =>
  computePlanStatus(validatePaymentPlan(PLAN_RAW(second)).plan!, [
    { id: "p1", invoice_number: "INV-1", invoice_status: "Paid", amount_paid: 1995, amount: 1995, tranche_seq: 1, due_date: null },
    ...rows,
  ] as never)

beforeEach(() => {
  inserted.length = 0
  updates.length = 0
  calls.length = 0
  claimWins = true
  leadError = null
  madePayerRow = null
  for (const k of Object.keys(tables)) delete tables[k]
  createTDInvoice.mockReset()
  sendTDInvoice.mockReset()
  createTDInvoice.mockResolvedValue({ paymentId: "pay-2", invoiceNumber: "INV-2", status: "Draft" })
  sendTDInvoice.mockResolvedValue(undefined)
  offerRow = { token: "tok", client_name: "Gabriel Contra", status: "completed", account_id: null, contact_id: "c-mario", lead_id: "l1", bill_to: { type: "person" }, services: [{ name: "Company Formation" }, { name: "Company Closure" }], invoice_description: null }
  leadRow = { converted_to_contact_id: "c-mario" }
  planStatus = statusFor(EIN)
})

describe("raiseAndSendPlanPart — one click raises AND sends, to the person who signed", () => {
  it("bills the PERSON (the offer's 'Invoice to'), with the plan's amount, the lineage and the no-double-bill key — then emails it", async () => {
    const r = await raiseAndSendPlanPart({ token: "tok", seq: 2, actor: "antonio@x" })
    expect(r).toMatchObject({ ok: true, sent: true, invoiceNumber: "INV-2" })
    const call = createTDInvoice.mock.calls[0][0]
    expect(call).toMatchObject({
      contact_id: "c-mario",
      currency: "EUR",
      idempotency_key: "offer-tranche:tok:2",
      tranche_offer_token: "tok",
      tranche_seq: 2,
      payment_category: "setup_tranche",
      card_fee_rate: 0.05,
    })
    expect(call.account_id).toBeUndefined()
    expect(call.line_items).toEqual([{ description: expect.stringContaining("part 2 of 2"), unit_price: 1900, quantity: 1 }])
    expect(sendTDInvoice).toHaveBeenCalledWith("pay-2")
    expect(inserted.find((i) => i.table === "action_log")?.row).toMatchObject({ action_type: "plan_part_raised_from_calendar", contact_id: "c-mario" })
  })

  it("never bills the company the offer was later linked to: with 'Invoice to: person' the company is ignored", async () => {
    offerRow = { ...offerRow!, account_id: "acct-newco" }
    await raiseAndSendPlanPart({ token: "tok", seq: 2, actor: "a" })
    expect(createTDInvoice.mock.calls[0][0].account_id).toBeUndefined()
    expect(createTDInvoice.mock.calls[0][0].contact_id).toBe("c-mario")
  })

  it("a chosen COMPANY payer is billed as the company (the offer's own choice)", async () => {
    const payer = "11111111-1111-4111-8111-111111111111"
    offerRow = { ...offerRow!, bill_to: { type: "company", account_id: payer } }
    await raiseAndSendPlanPart({ token: "tok", seq: 2, actor: "a" })
    expect(createTDInvoice.mock.calls[0][0].account_id).toBe(payer)
  })

  it("a lead's offer learns its person at signing: the converted lead's contact is billed", async () => {
    offerRow = { ...offerRow!, contact_id: null }
    await raiseAndSendPlanPart({ token: "tok", seq: 2, actor: "a" })
    expect(createTDInvoice.mock.calls[0][0].contact_id).toBe("c-mario")
  })

  it("a part that was already raised as a Draft is only SENT (the key hands back the same invoice)", async () => {
    planStatus = statusFor(EIN, [{ id: "p2", invoice_number: "INV-2", invoice_status: "Draft", amount_paid: 0, amount: 1995, tranche_seq: 2, due_date: null }])
    const r = await raiseAndSendPlanPart({ token: "tok", seq: 2, actor: "a" })
    expect(r.ok).toBe(true)
    expect(sendTDInvoice).toHaveBeenCalledTimes(1)
  })

  it("a second click (the key returns an invoice that is already SENT) sends nothing and says so", async () => {
    createTDInvoice.mockResolvedValue({ paymentId: "pay-2", invoiceNumber: "INV-2", status: "Sent" })
    const r = await raiseAndSendPlanPart({ token: "tok", seq: 2, actor: "a" })
    expect(r).toMatchObject({ ok: true, sent: false })
    expect(r.message).toContain("already exists")
    expect(sendTDInvoice).not.toHaveBeenCalled()
  })

  it("refuses a part that already has a sent / paid invoice, changing nothing", async () => {
    planStatus = statusFor(EIN, [{ id: "p2", invoice_number: "INV-2", invoice_status: "Sent", amount_paid: 0, amount: 1995, tranche_seq: 2, due_date: null }])
    const r = await raiseAndSendPlanPart({ token: "tok", seq: 2, actor: "a" })
    expect(r.ok).toBe(false)
    expect(r.message).toContain("already has invoice INV-2")
    expect(createTDInvoice).not.toHaveBeenCalled()
  })

  it("refuses part 1 (billed at signing), an unsigned offer, a missing part and a missing plan", async () => {
    expect((await raiseAndSendPlanPart({ token: "tok", seq: 1, actor: "a" })).message).toContain("Part 1")
    offerRow = { ...offerRow!, status: "draft" }
    expect((await raiseAndSendPlanPart({ token: "tok", seq: 2, actor: "a" })).message).toContain("not signed")
    offerRow = { ...offerRow, status: "completed" }
    expect((await raiseAndSendPlanPart({ token: "tok", seq: 7, actor: "a" })).message).toContain("no part 7")
    planStatus = null
    expect((await raiseAndSendPlanPart({ token: "tok", seq: 2, actor: "a" })).message).toContain("no valid payment plan")
    expect(createTDInvoice).not.toHaveBeenCalled()
  })

  it("an offer with nobody to invoice is refused, not guessed", async () => {
    offerRow = { ...offerRow!, contact_id: null, lead_id: null }
    const r = await raiseAndSendPlanPart({ token: "tok", seq: 2, actor: "a" })
    expect(r.ok).toBe(false)
    expect(createTDInvoice).not.toHaveBeenCalled()
  })

  it("a failure while raising is reported in plain words, never thrown", async () => {
    createTDInvoice.mockRejectedValue(new Error("boom"))
    const r = await raiseAndSendPlanPart({ token: "tok", seq: 2, actor: "a" })
    expect(r).toMatchObject({ ok: false })
    expect(r.message).toContain("boom")
  })

  it("EXACTLY ONE EMAIL: when several clicks get the same Draft back, only the click that wins the claim sends; the others say so and send nothing", async () => {
    claimWins = false
    const r = await raiseAndSendPlanPart({ token: "tok", seq: 2, actor: "a" })
    expect(r).toMatchObject({ ok: true, sent: false, invoiceNumber: "INV-2" })
    expect(r.message).toContain("already being sent")
    expect(sendTDInvoice).not.toHaveBeenCalled()
  })

  it("the click that wins the claim stamps the Draft first, then sends once", async () => {
    await raiseAndSendPlanPart({ token: "tok", seq: 2, actor: "a" })
    expect(updates.filter((u) => u.table === "payments")[0].patch).toMatchObject({ sent_at: expect.any(String) })
    expect(sendTDInvoice).toHaveBeenCalledTimes(1)
  })

  it("a send that fails after the invoice exists says so plainly, gives the claim back and leaves a Draft to re-send", async () => {
    sendTDInvoice.mockRejectedValue(new Error("No contact email found for this account"))
    const r = await raiseAndSendPlanPart({ token: "tok", seq: 2, actor: "a" })
    expect(r.ok).toBe(false)
    expect(r.message).toContain("was created but could not be emailed")
    expect(r.message).toContain("No contact email found")
    expect(r.message).toContain("Send invoice")
    expect(updates.filter((u) => u.table === "payments").map((u) => u.patch)).toContainEqual({ sent_at: null })
  })

  it("a Draft made elsewhere (the company page) for a DIFFERENT payer is refused: not claimed, not emailed", async () => {
    madePayerRow = { account_id: "acct-company", contact_id: null, billing_entity_id: null }
    const r = await raiseAndSendPlanPart({ token: "tok", seq: 2, actor: "a" })
    expect(r.ok).toBe(false)
    expect(r.message).toContain("different payer")
    expect(updates).toHaveLength(0)
    expect(sendTDInvoice).not.toHaveBeenCalled()
  })

  it("a Draft that IS addressed to the offer's payer is sent normally", async () => {
    madePayerRow = { account_id: null, contact_id: "c-mario", billing_entity_id: null }
    const r = await raiseAndSendPlanPart({ token: "tok", seq: 2, actor: "a" })
    expect(r).toMatchObject({ ok: true, sent: true })
  })

  it("an offer whose 'Invoice to' was never set follows where PART 1 went (the person), not the company it was linked to afterwards", async () => {
    offerRow = { ...offerRow!, bill_to: null, account_id: "acct-newco" }
    tables.payments = [{ tranche_seq: 1, invoice_status: "Paid", account_id: null, contact_id: "c-mario", billing_entity_id: null }]
    await raiseAndSendPlanPart({ token: "tok", seq: 2, actor: "a" })
    const call = createTDInvoice.mock.calls[0][0]
    expect(call.account_id).toBeUndefined()
    expect(call.contact_id).toBe("c-mario")
  })

  it("…and when part 1 has no invoice yet, the old rule stands (the offer's own company)", async () => {
    offerRow = { ...offerRow!, bill_to: null, account_id: "acct-newco" }
    tables.payments = []
    await raiseAndSendPlanPart({ token: "tok", seq: 2, actor: "a" })
    expect(createTDInvoice.mock.calls[0][0].account_id).toBe("acct-newco")
  })

  it("nets the PERSON's credit pool, like part 1 at signing", async () => {
    await raiseAndSendPlanPart({ token: "tok", seq: 2, actor: "a" })
    expect(createTDInvoice.mock.calls[0][0].credit_scope).toBe("contact")
  })

  it("a failed lookup of the lead's person stops the click (never an invoice with the wrong or no payer)", async () => {
    offerRow = { ...offerRow!, contact_id: null }
    leadError = "timeout"
    const r = await raiseAndSendPlanPart({ token: "tok", seq: 2, actor: "a" })
    expect(r.ok).toBe(false)
    expect(r.message).toContain("could not be looked up")
    expect(createTDInvoice).not.toHaveBeenCalled()
  })

  it("a date part carries its date as the invoice's due date; a step part has none", async () => {
    planStatus = statusFor({ kind: "date", date: "2026-11-27" })
    await raiseAndSendPlanPart({ token: "tok", seq: 2, actor: "a" })
    expect(createTDInvoice.mock.calls[0][0].due_date).toBe("2026-11-27")
    createTDInvoice.mockClear()
    planStatus = statusFor(EIN)
    await raiseAndSendPlanPart({ token: "tok", seq: 2, actor: "a" })
    expect(createTDInvoice.mock.calls[0][0].due_date).toBeUndefined()
  })
})

describe("loadInvoicesToRaise — what the Calendar shows", () => {
  const planOffer = (token: string, second: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    token, client_name: `Client ${token}`, client_email: null, account_id: null, contact_id: "c-mario", lead_id: null, bill_to: { type: "person" },
    services: [{ name: "Company Formation" }], invoice_description: null, payment_plan: PLAN_RAW(second), ...extra,
  })
  beforeEach(() => {
    for (const k of Object.keys(tables)) delete tables[k]
    tables.payments = [{ id: "p1", invoice_number: "INV-1", invoice_status: "Paid", amount_paid: 1900, amount: 1900, tranche_seq: 1, tranche_offer_token: "tok", due_date: null }]
    tables.service_deliveries = [{ service_type: "Company Formation", stage_order: 8, status: "active", source_offer_token: "tok" }]
    tables.pipeline_stages = [{ service_type: "Company Formation", stage_name: "EIN Received", stage_order: 8 }]
    tables.contacts = [{ id: "c-mario", full_name: "Mario Gabriele Contrabona", email: "mcontrabona@googlemail.com" }]
    tables.accounts = []
    tables.billing_entities = []
    tables.leads = []
  })

  it("the EIN step reached → a DUE row, billed to the person who signed (name + email), even though the offer now has a company", async () => {
    tables.offers = [planOffer("tok", EIN, { account_id: "acct-newco" })]
    const r = await loadInvoicesToRaise("2026-11-20")
    expect(r.dueCount).toBe(1)
    expect(r.rows[0]).toMatchObject({ offerToken: "tok", seq: 2, due: true, amount: 1900, currency: "EUR", payerName: "Mario Gabriele Contrabona", payerEmail: "mcontrabona@googlemail.com", payerHref: "/contacts/c-mario", partText: "Part 2 of 2" })
    expect(r.rows[0].serviceLabel).toBe("Company Formation")
  })

  it("the step NOT reached → coming up, not counted", async () => {
    tables.offers = [planOffer("tok", EIN)]
    tables.service_deliveries = [{ service_type: "Company Formation", stage_order: 2, status: "active", source_offer_token: "tok" }]
    const r = await loadInvoicesToRaise("2026-11-20")
    expect(r.dueCount).toBe(0)
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0].due).toBe(false)
  })

  it("due rows come first; the longest overdue date first; then what is coming up", async () => {
    tables.offers = [
      planOffer("soon", { kind: "date", date: "2026-12-30" }),
      planOffer("late", { kind: "date", date: "2026-11-01" }),
      planOffer("later", { kind: "date", date: "2026-11-15" }),
      planOffer("manual", { kind: "manual", label: "when I say so" }),
    ]
    tables.payments = (["soon", "late", "later", "manual"]).map((t) => ({ id: `p-${t}`, invoice_number: `INV-${t}`, invoice_status: "Paid", amount_paid: 1900, amount: 1900, tranche_seq: 1, tranche_offer_token: t, due_date: null }))
    tables.service_deliveries = []
    const r = await loadInvoicesToRaise("2026-11-20")
    expect(r.rows.map((x) => `${x.offerToken}:${x.due}`)).toEqual(["late:true", "later:true", "manual:false", "soon:false"])
    expect(r.dueCount).toBe(2)
  })

  it("only plan offers that are signed or completed are read (the query asks for those); an offer whose plan is not a list is skipped", async () => {
    tables.offers = [{ ...planOffer("tok", EIN), payment_plan: "nonsense" }]
    expect((await loadInvoicesToRaise("2026-11-20")).rows).toEqual([])
    tables.offers = []
    expect(await loadInvoicesToRaise("2026-11-20")).toEqual({ rows: [], dueCount: 0 })
  })

  it("a stored plan that no longer validates is skipped, never guessed", async () => {
    tables.offers = [planOffer("tok", { kind: "step", service_type: "Company Formation" })]
    expect((await loadInvoicesToRaise("2026-11-20")).rows).toEqual([])
  })

  it("a failed read throws (the Calendar shows 'could not load', never an empty list); the count is then null", async () => {
    tables.offers = [planOffer("tok", EIN)]
    tables.payments = { error: { message: "db down" } }
    await expect(loadInvoicesToRaise("2026-11-20")).rejects.toThrow("db down")
    expect(await countInvoicesDue("2026-11-20")).toBeNull()
  })

  it("the query asks only for signed or completed offers (a draft / sent / expired offer is never read)", async () => {
    tables.offers = [planOffer("tok", EIN)]
    await loadInvoicesToRaise("2026-11-20")
    const q = calls.find((x) => x.table === "offers" && x.method === "in")
    expect(q?.args).toEqual(["status", ["signed", "completed"]])
  })

  it("an offer whose 'Invoice to' was never set names the person part 1 went to, not the company it was linked to", async () => {
    tables.offers = [planOffer("tok", EIN, { bill_to: null, account_id: "acct-newco" })]
    tables.payments = [{ id: "p1", invoice_number: "INV-1", invoice_status: "Paid", amount_paid: 1900, amount: 1900, tranche_seq: 1, tranche_offer_token: "tok", due_date: null, account_id: null, contact_id: "c-mario", billing_entity_id: null }]
    tables.accounts = [{ id: "acct-newco", company_name: "Newco LLC" }]
    const r = await loadInvoicesToRaise("2026-11-20")
    expect(r.rows[0].payerName).toBe("Mario Gabriele Contrabona")
    expect(r.rows[0].payerHref).toBe("/contacts/c-mario")
  })

  it("a Draft addressed to a different payer is flagged on the row (and the text says why)", async () => {
    tables.offers = [planOffer("tok", EIN)]
    tables.payments = [
      { id: "p1", invoice_number: "INV-1", invoice_status: "Paid", amount_paid: 1900, amount: 1900, tranche_seq: 1, tranche_offer_token: "tok", due_date: null, account_id: null, contact_id: "c-mario", billing_entity_id: null },
      { id: "p2", invoice_number: "INV-2", invoice_status: "Draft", amount_paid: 0, amount: 1900, tranche_seq: 2, tranche_offer_token: "tok", due_date: null, account_id: "acct-company", contact_id: null, billing_entity_id: null },
    ]
    const r = await loadInvoicesToRaise("2026-11-20")
    expect(r.rows[0]).toMatchObject({ due: true, payerMismatch: true })
    expect(r.rows[0].text).toContain("different payer")
  })

  it("a Draft addressed to the right payer carries no warning", async () => {
    tables.offers = [planOffer("tok", EIN)]
    tables.payments = [
      { id: "p2", invoice_number: "INV-2", invoice_status: "Draft", amount_paid: 0, amount: 1900, tranche_seq: 2, tranche_offer_token: "tok", due_date: null, account_id: null, contact_id: "c-mario", billing_entity_id: null },
    ]
    const r = await loadInvoicesToRaise("2026-11-20")
    expect(r.rows[0].payerMismatch).toBe(false)
  })

  it("a step part whose service has no active job from this offer is flagged, not left looking like an ordinary wait", async () => {
    tables.offers = [planOffer("tok", EIN)]
    tables.service_deliveries = []
    const r = await loadInvoicesToRaise("2026-11-20")
    expect(r.rows[0]).toMatchObject({ due: false, jobMissing: true })
  })

  it("a failed read of the payer's name throws instead of quietly showing the offer's client name as 'Bill to'", async () => {
    tables.offers = [planOffer("tok", EIN)]
    tables.contacts = { error: { message: "contacts down" } }
    await expect(loadInvoicesToRaise("2026-11-20")).rejects.toThrow("contacts down")
  })

  it("the count equals the number of due rows", async () => {
    tables.offers = [planOffer("tok", EIN)]
    expect(await countInvoicesDue("2026-11-20")).toBe(1)
  })
})

describe("nothing raises by itself any more", () => {
  const root = process.cwd()
  it("the morning job is gone: no route, no schedule, no coverage entry", () => {
    expect(existsSync(join(root, "app/api/cron/plan-part-auto-raise/route.ts"))).toBe(false)
    expect(readFileSync(join(root, "vercel.json"), "utf8")).not.toContain("plan-part-auto-raise")
    expect(readFileSync(join(root, "lib/cron-coverage.ts"), "utf8")).not.toMatch(/"\/api\/cron\/plan-part-auto-raise"\s*:/)
  })
  it("the only thing that raises a later part is the staff-only route, behind a login, naming just the offer and the part", () => {
    const src = readFileSync(join(root, "app/api/crm/admin-actions/raise-plan-part/route.ts"), "utf8")
    expect(src).toContain("isStaffUser(user)")
    expect(src).toContain("seq < 2")
    expect(src).toContain("raiseAndSendPlanPart({ token, seq, actor:")
  })
})
