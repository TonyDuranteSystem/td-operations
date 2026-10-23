/**
 * Payments to confirm, Phase 3 (dev job 40a58d9a): the Marketing sale and "An invoice was paid" choices, and the What's New line.
 * Databases are recording fakes; the settle engines are mocked so the test pins WHAT is asked of them.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

// ── a tiny recording fake for the supabase client (used by confirm.ts, invoice-payment.ts, notify.ts) ──
const calls: { table: string; op: string; payload?: unknown }[] = []
const tables: Record<string, unknown[]> = {}
let insertError: { code?: string; message: string } | null = null
let insertErrorTable = "marketing_sales"
const orArgs: string[] = []

function builder(table: string) {
  let op = "select"
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const b: any = {
    select: () => b,
    insert: (p: unknown) => { op = "insert"; calls.push({ table, op, payload: p }); return b },
    update: (p: unknown) => { op = "update"; calls.push({ table, op, payload: p }); return b },
    eq: () => b, ilike: () => b, in: () => b, or: (a: string) => { orArgs.push(a); return b }, not: () => b, order: () => b, limit: () => b,
    maybeSingle: () => Promise.resolve({ data: (tables[table] || [])[0] ?? null, error: null }),
    // an insert(...).select("id").single() answers with the new row's id (or the configured insert error for that table)
    single: () => (op === "insert"
      ? Promise.resolve(insertError && table === insertErrorTable ? { data: null, error: insertError } : { data: { id: "new-" + table }, error: null })
      : Promise.resolve({ data: (tables[table] || [])[0] ?? null, error: null })),
    then: (res: (v: unknown) => unknown) => Promise.resolve({ data: op === "select" ? (tables[table] || []) : null, error: op === "insert" && table === insertErrorTable ? insertError : null }).then(res),
  }
  return b
}
vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: { from: (t: string) => builder(t) } }))

const reconcile = vi.fn()
vi.mock("@/lib/operations/payment", () => ({ reconcilePaymentByInvoiceNumber: (...a: unknown[]) => reconcile(...a) }))
const emitPaid = vi.fn(async () => ({ emitted: true }))
const emitWaiting = vi.fn(async () => ({ emitted: true }))
const retire = vi.fn(async () => ({ retired: 1 }))
vi.mock("@/lib/portal/chat-events", () => ({
  emitPaymentReceivedEvent: (...a: unknown[]) => emitPaid(...(a as [])),
  emitUnlabelledPaymentWaitingEvent: (...a: unknown[]) => emitWaiting(...(a as [])),
  retireUnlabelledPaymentNote: (...a: unknown[]) => retire(...(a as [])),
}))
vi.mock("@/lib/operations/paid-call-credit", () => ({ recordPaidCall: vi.fn() }))
vi.mock("@/lib/incoming-payments/load", async (orig) => ({ ...(await orig<typeof import("@/lib/incoming-payments/load")>()), loadWaitingPaymentBySession: vi.fn() }))

// marketing side: settings, terms, lead moves
const getSetting = vi.fn()
const listTerms = vi.fn()
vi.mock("@/lib/marketing/settings", () => ({ getMarketingSetting: (...a: unknown[]) => getSetting(...a), listCommissionTerms: (...a: unknown[]) => listTerms(...a) }))
const moveLead = vi.fn(async () => undefined)
vi.mock("@/lib/marketing/sales-server", () => ({ moveLeadAfterPaid: (...a: unknown[]) => moveLead(...a) }))
vi.mock("@/lib/marketing/meta-leads/service", () => ({ leadDb: () => ({ from: (t: string) => builder(t) }) }))

import { recordMarketingSaleFromPayment } from "@/lib/incoming-payments/marketing-sale"
import { payInvoiceFromPayment } from "@/lib/incoming-payments/invoice-payment"
import { notifyUnlabelledPayment } from "@/lib/incoming-payments/notify"
import { settlePayment, RESOLUTIONS } from "@/lib/incoming-payments/confirm"
import { searchMarketingLeads, matchesFor, marketingLeadsByName, marketingSuggestionFor } from "@/lib/incoming-payments/load"

const LEAD = "22222222-2222-4222-8222-222222222222"
const INV = "33333333-3333-4333-8333-333333333333"
const PAY = { sessionId: "cs_live_abc12345", paymentIntentId: "pi_1", paymentLinkId: "plink_1", amount: 397, currency: "EUR" as const, email: "monica@example.com", name: "Monica", paidAt: "2026-10-23T11:59:45Z" }
const wrote = (table: string, op: string) => calls.filter(c => c.table === table && c.op === op)

beforeEach(() => {
  calls.length = 0
  orArgs.length = 0
  insertError = null
  insertErrorTable = "marketing_sales"
  for (const k of Object.keys(tables)) delete tables[k]
  reconcile.mockReset(); emitPaid.mockClear(); emitWaiting.mockClear(); retire.mockClear(); moveLead.mockClear(); getSetting.mockReset(); listTerms.mockReset()
  getSetting.mockResolvedValue([{ key: "strategic_call", label: "Strategic call" }, { key: "upsell", label: "Upsell" }])
  listTerms.mockResolvedValue([])
})

describe("the resolution list", () => {
  it("has the five choices (and the database CHECK is widened to the same five by migration 20261023-1500)", () => {
    expect([...RESOLUTIONS]).toEqual(["paid_call", "paid_call_already_deducted", "recorded_elsewhere", "marketing_sale", "invoice_paid"])
  })
})

describe("recordMarketingSaleFromPayment", () => {
  it("writes ONE paid sale from the saved payment, with the split in force on the DAY OF PAYMENT, and moves the lead", async () => {
    tables.marketing_leads = [{ id: LEAD, team_id: "team-1", full_name: "Monica G", email: "monica@example.com" }]
    tables.marketing_sales = [] // no sale yet for this session
    listTerms.mockResolvedValue([
      { id: "t-old", team_id: "team-1", kind: "strategic_call", person_ref: "team", effective_from: "2026-10-01", seller_pct: 80, td_pct: 20, basis: "amount_paid", payee_account_id: null },
      { id: "t-new", team_id: "team-1", kind: "strategic_call", person_ref: "team", effective_from: "2026-10-25", seller_pct: 50, td_pct: 50, basis: "amount_paid", payee_account_id: null },
    ])
    // maybeSingle for the session lookup returns the first marketing_sales row: none; lead lookup returns the lead
    const r = await recordMarketingSaleFromPayment({ payment: PAY, marketingLeadId: LEAD, kind: "strategic_call", actor: "antonio@x" })
    expect(r).toMatchObject({ ok: true, termsSet: true })
    const sale = wrote("marketing_sales", "insert")[0].payload as Record<string, unknown>
    expect(sale).toMatchObject({ team_id: "team-1", lead_id: LEAD, status: "paid", kind: "strategic_call", amount_cents: 39700, currency: "EUR", stripe_session_id: PAY.sessionId, stripe_payment_intent: "pi_1", paid_amount_cents: 39700, created_by: "antonio@x", created_by_user_id: null })
    // the term of 2026-10-01 (in force on the 23rd), NOT the one starting on the 25th
    expect(sale).toMatchObject({ term_id: "t-old", seller_pct: 80, seller_cents: 31760, td_cents: 7940 })
    expect(String(sale.note)).toContain("no marketing label")
    expect(wrote("marketing_lead_events", "insert")[0].payload).toMatchObject({ lead_id: LEAD, kind: "payment_received", actor: "antonio@x" })
    expect(moveLead).toHaveBeenCalledTimes(1)
  })

  it("no term in force on that day = 'terms not set' (Antonio applies terms later), never invented", async () => {
    tables.marketing_leads = [{ id: LEAD, team_id: "team-1", full_name: "Monica G", email: null }]
    const r = await recordMarketingSaleFromPayment({ payment: PAY, marketingLeadId: LEAD, kind: "upsell", actor: "a" })
    expect(r).toMatchObject({ ok: true, termsSet: false })
    expect(wrote("marketing_sales", "insert")[0].payload).toMatchObject({ seller_pct: null, seller_cents: null, td_cents: null })
  })

  it("is idempotent: a session that already has a sale records nothing", async () => {
    tables.marketing_sales = [{ id: "sale-9" }]
    const r = await recordMarketingSaleFromPayment({ payment: PAY, marketingLeadId: LEAD, kind: "strategic_call", actor: "a" })
    expect(r).toMatchObject({ ok: true, alreadyRecorded: true, saleId: "sale-9" })
    expect(wrote("marketing_sales", "insert")).toHaveLength(0)
  })

  it("a unique-index collision (a colleague recorded it a moment ago) is success", async () => {
    tables.marketing_leads = [{ id: LEAD, team_id: "team-1", full_name: "M", email: null }]
    insertError = { code: "23505", message: "duplicate" }
    expect(await recordMarketingSaleFromPayment({ payment: PAY, marketingLeadId: LEAD, kind: "strategic_call", actor: "a" })).toMatchObject({ ok: true, alreadyRecorded: true })
  })

  it("refuses a lead with no team, an unknown kind of sale, or a malformed lead id — before writing anything", async () => {
    tables.marketing_leads = [{ id: LEAD, team_id: null, full_name: "M", email: null }]
    expect(await recordMarketingSaleFromPayment({ payment: PAY, marketingLeadId: LEAD, kind: "strategic_call", actor: "a" })).toMatchObject({ ok: false, status: 400 })
    tables.marketing_leads = [{ id: LEAD, team_id: "team-1", full_name: "M", email: null }]
    expect(await recordMarketingSaleFromPayment({ payment: PAY, marketingLeadId: LEAD, kind: "made_up", actor: "a" })).toMatchObject({ ok: false, status: 400 })
    expect(await recordMarketingSaleFromPayment({ payment: PAY, marketingLeadId: "nope", kind: "strategic_call", actor: "a" })).toMatchObject({ ok: false, status: 400 })
    expect(await recordMarketingSaleFromPayment({ payment: PAY, marketingLeadId: LEAD, kind: "", actor: "a" })).toMatchObject({ ok: false, status: 400 })
    expect(wrote("marketing_sales", "insert")).toHaveLength(0)
  })

  it("a lead that does not exist is a 404", async () => {
    expect(await recordMarketingSaleFromPayment({ payment: PAY, marketingLeadId: LEAD, kind: "strategic_call", actor: "a" })).toMatchObject({ ok: false, status: 404 })
  })
})

describe("payInvoiceFromPayment", () => {
  const openInvoice = (over: Record<string, unknown> = {}) => ({ id: INV, invoice_number: "INV-001", description: "Annual", amount_due: 397, total: 397, amount_currency: "EUR", due_date: "2026-10-30", status: "Overdue", invoice_status: "Overdue", ...over })
  beforeEach(() => {
    tables.contacts = [{ id: "c1" }]
    tables.account_contacts = [{ account_id: "a1" }]
    tables.payments = [openInvoice()]
    reconcile.mockResolvedValue({ reconciled: true, outcome: "paid", payment_id: INV })
  })

  it("settles the picked invoice with the amount actually charged, stamps the Stripe id, and posts the payment note", async () => {
    const r = await payInvoiceFromPayment({ payment: PAY, invoicePaymentId: INV, actor: "a" })
    expect(r).toMatchObject({ ok: true, invoiceNumber: "INV-001", paymentId: INV, partial: false })
    expect(reconcile).toHaveBeenCalledWith("INV-001", { amountPaid: 397, paidDate: "2026-10-23", stripePaymentId: "pi_1" })
    expect(emitPaid).toHaveBeenCalledTimes(1)
  })

  it("a smaller payment is a PART payment (the engine keeps the rest open)", async () => {
    reconcile.mockResolvedValue({ reconciled: true, outcome: "partial", payment_id: INV })
    expect(await payInvoiceFromPayment({ payment: { ...PAY, amount: 100 }, invoicePaymentId: INV, actor: "a" })).toMatchObject({ ok: true, partial: true })
  })

  it("applies NOTHING when the amount is more than the invoice still owes, or the currency differs", async () => {
    expect(await payInvoiceFromPayment({ payment: { ...PAY, amount: 500 }, invoicePaymentId: INV, actor: "a" })).toMatchObject({ ok: false, status: 400 })
    expect(await payInvoiceFromPayment({ payment: { ...PAY, currency: "USD" }, invoicePaymentId: INV, actor: "a" })).toMatchObject({ ok: false, status: 400 })
    expect(reconcile).not.toHaveBeenCalled()
  })

  it("only an invoice on THIS payer's open list can be settled (dead, draft or someone else's are refused)", async () => {
    tables.payments = [openInvoice({ invoice_status: "Credit" })]
    expect(await payInvoiceFromPayment({ payment: PAY, invoicePaymentId: INV, actor: "a" })).toMatchObject({ ok: false, status: 400 })
    tables.payments = [openInvoice({ invoice_status: "Draft" })]
    expect(await payInvoiceFromPayment({ payment: PAY, invoicePaymentId: INV, actor: "a" })).toMatchObject({ ok: false, status: 400 })
    tables.payments = [openInvoice()]
    expect(await payInvoiceFromPayment({ payment: PAY, invoicePaymentId: "44444444-4444-4444-8444-444444444444", actor: "a" })).toMatchObject({ ok: false, status: 400 })
    tables.contacts = [] // the payer matches no contact: nothing to pick from
    expect(await payInvoiceFromPayment({ payment: PAY, invoicePaymentId: INV, actor: "a" })).toMatchObject({ ok: false, status: 400 })
    expect(await payInvoiceFromPayment({ payment: PAY, invoicePaymentId: "nope", actor: "a" })).toMatchObject({ ok: false, status: 400 })
    expect(reconcile).not.toHaveBeenCalled()
  })

  it("an engine that does not settle it is an error and nothing is announced as paid", async () => {
    reconcile.mockResolvedValue({ reconciled: false, outcome: "already_paid" })
    expect(await payInvoiceFromPayment({ payment: PAY, invoicePaymentId: INV, actor: "a" })).toMatchObject({ ok: false, status: 500 })
    expect(emitPaid).not.toHaveBeenCalled()
  })
})

describe("settlePayment — the new choices", () => {
  it("marketing_sale writes the resolution WITHOUT a client lead id and notes the marketing lead + sale; the What's New note is retired", async () => {
    tables.marketing_leads = [{ id: LEAD, team_id: "team-1", full_name: "Monica G", email: null }]
    const r = await settlePayment({ payment: PAY, resolution: "marketing_sale", marketingLeadId: LEAD, saleKind: "strategic_call", actor: "antonio@x" })
    expect(r).toMatchObject({ ok: true, resolution: "marketing_sale", alreadySettled: false })
    const res = wrote("incoming_payment_resolutions", "insert")[0].payload as Record<string, unknown>
    expect(res).toMatchObject({ stripe_session_id: PAY.sessionId, resolution: "marketing_sale", lead_id: null, contact_id: null, resolved_by: "antonio@x" })
    expect(String(res.note)).toContain(LEAD)
    expect(wrote("payments", "insert")).toHaveLength(0) // marketing never writes a client payment row
    expect(wrote("leads", "update")).toHaveLength(0)
    expect(retire).toHaveBeenCalledWith({ sessionId: PAY.sessionId, deletedBy: null })
  })

  it("a marketing failure settles nothing", async () => {
    const r = await settlePayment({ payment: PAY, resolution: "marketing_sale", marketingLeadId: LEAD, saleKind: "strategic_call", actor: "a" })
    expect(r).toMatchObject({ ok: false, status: 404 })
    expect(wrote("incoming_payment_resolutions", "insert")).toHaveLength(0)
    expect(retire).not.toHaveBeenCalled()
  })

  it("invoice_paid records the invoice id on the resolution and reports the invoice number", async () => {
    tables.contacts = [{ id: "c1" }]
    tables.payments = [{ id: INV, invoice_number: "INV-001", description: "x", amount_due: 397, total: 397, amount_currency: "EUR", due_date: null, status: "Pending", invoice_status: "Sent" }]
    reconcile.mockResolvedValue({ reconciled: true, outcome: "paid", payment_id: INV })
    const r = await settlePayment({ payment: PAY, resolution: "invoice_paid", invoicePaymentId: INV, actor: "a" })
    expect(r).toMatchObject({ ok: true, resolution: "invoice_paid", invoiceNumber: "INV-001" })
    expect(wrote("incoming_payment_resolutions", "insert")[0].payload).toMatchObject({ resolution: "invoice_paid", invoice_payment_id: INV })
  })
})

describe("notifyUnlabelledPayment (the What's New line)", () => {
  const session = { id: "cs_live_abc12345", amount_total: 39700, currency: "eur", customer_details: { email: "chris@example.com", name: "Christian" } }
  it("posts on the client when the payer is a known contact (and the company when there is exactly one)", async () => {
    tables.contacts = [{ id: "c1", full_name: "Christian R", account_contacts: [{ account_id: "a1" }] }]
    const r = await notifyUnlabelledPayment(session)
    expect(r.emitted).toBe(true)
    expect(emitWaiting).toHaveBeenCalledWith({ sessionId: "cs_live_abc12345", contactId: "c1", accountId: "a1", payerName: "Christian", amountText: "€397" })
  })
  it("two companies = no company tag (never guessed); an unknown payer posts nothing; it never throws", async () => {
    tables.contacts = [{ id: "c1", full_name: "X", account_contacts: [{ account_id: "a1" }, { account_id: "a2" }] }]
    await notifyUnlabelledPayment(session)
    expect(emitWaiting.mock.calls[0][0]).toMatchObject({ accountId: null })
    emitWaiting.mockClear()
    tables.contacts = []
    expect(await notifyUnlabelledPayment(session)).toMatchObject({ emitted: false })
    expect(emitWaiting).not.toHaveBeenCalled()
    expect(await notifyUnlabelledPayment({ ...session, customer_details: null })).toMatchObject({ emitted: false })
    emitWaiting.mockRejectedValueOnce(new Error("boom"))
    tables.contacts = [{ id: "c1", full_name: "X", account_contacts: [] }]
    await expect(notifyUnlabelledPayment(session)).resolves.toMatchObject({ emitted: false })
  })
})

describe("searchMarketingLeads", () => {
  it("nothing typed can become a filter operator or a wildcard (only letters, digits and a few marks survive)", async () => {
    tables.marketing_leads = []
    await searchMarketingLeads("mo,nica%_(x).or(id.eq.1)\\")
    expect(orArgs).toHaveLength(1)
    expect(orArgs[0]).toBe("full_name.ilike.%monicax.orid.eq.1%,email.ilike.%monicax.orid.eq.1%")
  })
  it("fewer than two usable characters searches nothing", async () => {
    expect(await searchMarketingLeads(" %_ ")).toEqual({ available: true, leads: [] })
    expect(orArgs).toHaveLength(0)
  })
  it("returns each lead with its team's kinds; a lead with no team has none", async () => {
    tables.marketing_leads = [{ id: LEAD, full_name: "Monica G", email: "m@x.com", team_id: "team-1" }, { id: "l2", full_name: "No Team", email: null, team_id: null }]
    const r = await searchMarketingLeads("monica")
    expect(r.available).toBe(true)
    expect(r.leads[0]).toMatchObject({ id: LEAD, teamId: "team-1", kinds: [{ key: "strategic_call", label: "Strategic call" }, { key: "upsell", label: "Upsell" }] })
    expect(r.leads[1]).toMatchObject({ teamId: null, kinds: [] })
  })
})

describe("matchesFor — marketing leads that share the payer's email are offered straight to the Marketing sale picker", () => {
  it("finds the lead by EMAIL even when the card carries another name (Stella on the card, Monica on the lead), with her team's kinds", async () => {
    tables.leads = []
    tables.contacts = []
    tables.marketing_leads = [{ id: LEAD, full_name: "Monica Germani", email: "monicagermani2025@gmail.com", team_id: "team-1" }]
    const m = await matchesFor("monicagermani2025@gmail.com")
    expect(m.marketingLeads).toEqual([
      { id: LEAD, name: "Monica Germani", email: "monicagermani2025@gmail.com", teamId: "team-1", via: "email", kinds: [{ key: "strategic_call", label: "Strategic call" }, { key: "upsell", label: "Upsell" }] },
    ])
  })
  it("a lead with no team comes back with no kinds (the picker says to assign it to a team first)", async () => {
    tables.leads = []
    tables.contacts = []
    tables.marketing_leads = [{ id: "l9", full_name: "No Team", email: "n@x.com", team_id: null }]
    expect((await matchesFor("n@x.com")).marketingLeads).toEqual([{ id: "l9", name: "No Team", email: "n@x.com", teamId: null, via: "email", kinds: [] }])
  })
  it("no email on the payment = no suggestions", async () => {
    expect(await matchesFor(null)).toEqual({ leads: [], contacts: [], marketingLeads: [] })
  })
})

describe("marketing lead suggestions by NAME (suggestions only) and the 'Looks like a marketing sale' preview", () => {
  it("a payer whose card name shares a significant word with a lead is offered as a 'similar name' (Stella Germani M ~ Monica Germani), never as an email match", async () => {
    tables.leads = []
    tables.contacts = []
    tables.marketing_leads = [{ id: LEAD, full_name: "Monica Germani", email: "monicagermani2025@gmail.com", team_id: "team-1" }, { id: "l2", full_name: "Unrelated Person", email: "u@x.com", team_id: "team-1" }]
    const out = await marketingLeadsByName("Stella Germani M", [])
    expect(out.map(c => c.id)).toEqual([LEAD])
    expect(out[0]).toMatchObject({ via: "name", name: "Monica Germani", teamId: "team-1" })
  })
  it("ranks by how many words are shared, caps at 5, and skips leads already listed by email", async () => {
    tables.marketing_leads = [
      { id: "a", full_name: "Rossi Mario", email: null, team_id: "t" },
      { id: "b", full_name: "Mario Rossi Bianchi", email: null, team_id: "t" },
      { id: "c", full_name: "Rossi Anna", email: null, team_id: "t" },
      { id: "d", full_name: "Rossi Luca", email: null, team_id: "t" },
      { id: "e", full_name: "Rossi Paolo", email: null, team_id: "t" },
      { id: "f", full_name: "Rossi Carlo", email: null, team_id: "t" },
    ]
    const out = await marketingLeadsByName("Mario Rossi", ["c"])
    expect(out.length).toBe(5)
    expect(out.map(c => c.id)).not.toContain("c")
    expect(["a", "b"]).toContain(out[0].id) // the two that share both words come first
    expect(["a", "b"]).toContain(out[1].id)
  })
  it("no usable name (empty, or only short/stop words) = no suggestions, and the filter only ever sees [a-z0-9] words", async () => {
    expect(await marketingLeadsByName(null, [])).toEqual([])
    expect(await marketingLeadsByName("A M", [])).toEqual([])
    tables.marketing_leads = []
    await marketingLeadsByName("Rossi,(x).or(id.eq.1)%", [])
    expect(orArgs[0]).toMatch(/^(full_name\.ilike\.%[a-z0-9]+%)(,full_name\.ilike\.%[a-z0-9]+%)*$/)
  })
  it("matchesFor with no email still tries the name", async () => {
    tables.marketing_leads = [{ id: LEAD, full_name: "Monica Germani", email: "m@x.com", team_id: "team-1" }]
    const m = await matchesFor(null, "Stella Germani M")
    expect(m.marketingLeads.map(c => c.via)).toEqual(["name"])
  })
  it("matchesFor lists the email match first, then name matches, each marked", async () => {
    tables.leads = []
    tables.contacts = []
    tables.marketing_leads = [{ id: LEAD, full_name: "Monica Germani", email: "monicagermani2025@gmail.com", team_id: "team-1" }]
    const m = await matchesFor("monicagermani2025@gmail.com", "Stella Germani M")
    // the same lead is listed once, as an email match (the name pass skips what the email pass already found)
    expect(m.marketingLeads.map(c => [c.id, c.via])).toEqual([[LEAD, "email"]])
  })

  const waiting = { sessionId: "cs_live_abc12345", paymentIntentId: "pi_1", paymentLinkId: null, amount: 397, currency: "EUR" as const, email: "m@x.com", name: "Stella Germani M", paidAt: "2026-10-23T11:59:45Z" }
  const emailLead = (over: Record<string, unknown> = {}) => ({ id: LEAD, name: "Monica Germani", email: "m@x.com", teamId: "team-1", via: "email" as const, kinds: [{ key: "strategic_call", label: "Strategic call" }, { key: "upsell", label: "Upsell" }], ...over })
  const term = { id: "t1", team_id: "team-1", kind: "strategic_call", person_ref: "team", effective_from: "2026-10-21", seller_pct: 80, td_pct: 20, basis: "amount_paid", payee_account_id: null }

  it("exactly one email-matched lead on a team = a suggestion with the split in force on the payment day (80/20 of EUR 397 = 317.60 / 79.40)", async () => {
    tables.marketing_teams = [{ name: "Rocco's sales team" }]
    listTerms.mockResolvedValue([term])
    const s = await marketingSuggestionFor(waiting, { leads: [], contacts: [], marketingLeads: [emailLead()] })
    expect(s).toMatchObject({ leadId: LEAD, leadName: "Monica Germani", teamName: "Rocco's sales team", kind: "strategic_call", kindLabel: "Strategic call", currency: "EUR", termSet: true, sellerAmount: 317.6, tdAmount: 79.4 })
  })
  it("a term that starts AFTER the payment is not used (terms not set, amounts null)", async () => {
    tables.marketing_teams = [{ name: "T" }]
    listTerms.mockResolvedValue([{ ...term, effective_from: "2026-10-25" }])
    expect(await marketingSuggestionFor(waiting, { leads: [], contacts: [], marketingLeads: [emailLead()] })).toMatchObject({ termSet: false, sellerAmount: null, tdAmount: null })
  })
  it("no suggestion when two leads share the email, the only match is by name, the lead has no team, or the team has no strategic_call kind", async () => {
    tables.marketing_teams = [{ name: "T" }]
    expect(await marketingSuggestionFor(waiting, { leads: [], contacts: [], marketingLeads: [emailLead(), emailLead({ id: "l2" })] })).toBeNull()
    expect(await marketingSuggestionFor(waiting, { leads: [], contacts: [], marketingLeads: [emailLead({ via: "name" })] })).toBeNull()
    expect(await marketingSuggestionFor(waiting, { leads: [], contacts: [], marketingLeads: [emailLead({ teamId: null, kinds: [] })] })).toBeNull()
    expect(await marketingSuggestionFor(waiting, { leads: [], contacts: [], marketingLeads: [emailLead({ kinds: [{ key: "upsell", label: "Upsell" }] })] })).toBeNull()
  })
})
