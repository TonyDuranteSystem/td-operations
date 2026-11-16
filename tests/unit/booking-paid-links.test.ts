/**
 * Booking page — PAID links (Stage 3, dev job 74432428). Everything runs against the in-memory database helper and fake Calendly / Stripe clients: no network, no real money.
 * The shapes (a stored Calendly delivery carrying the link's id, a Stripe session with our metadata) are the real ones the code reads.
 */
import { describe, it, expect, vi } from "vitest"
import { miniDb } from "./helpers/mini-db"
import { decideLinkPlan, PAID_LENGTH_TEXT } from "@/lib/booking/plan"
import { describePlan } from "@/lib/booking/preview"
import { isPaidLink, moneyText, parsePayMode, payModeText, payStateOf, payUrl, paymentDraft } from "@/lib/booking/payment"
import { makeLink, judgeLink, LARGE_AMOUNT_TEXT } from "@/lib/booking/make-link"
import { openPayment, findPayLink, identityEmail, identityName, SAYS, type StripeOps } from "@/lib/booking/pay-session"
import { recordBookingLinkPayment, type BookingPaySession } from "@/lib/booking/pay-record"
import { markPaymentSent, stopCharging, stopChargingIfPaidLink } from "@/lib/booking/pay-actions"
import { cardIsDue, decidePaidCard, loadPaidCalls, mergeCards, type PaidLinkRow } from "@/lib/booking/paid-calls"
import { payDtoOf, listLinks } from "@/lib/booking/links"
import { paymentFrom } from "@/lib/booking/route-helpers"
import type { CalendlyCtx, CalendlyHttpRequest } from "@/lib/calendly/api"
import type { LinkBooking } from "@/lib/booking/link-bookings"

const C1 = "c0000000-0000-4000-8000-000000000001"
const L1 = "10000000-0000-4000-8000-000000000001"
const A1 = "a0000000-0000-4000-8000-000000000001"
const LINK = "b0000000-0000-4000-8000-000000000001"
const TAG = "YajC1ZB9eYDY8WC8tnLnxA"
const PAYCODE = "2hhvDHUcAPqPBTXdD8HMqw"
const EV = "https://api.calendly.com/scheduled_events/dc95e826-9956-415e-bde1-247bfd074f57"
const NOW = new Date("2026-11-15T14:00:00.000Z")
const TYPE = "https://api.calendly.com/event_types/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
const SALES_TYPE = "https://api.calendly.com/event_types/bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee"

const META = {
  lead: { existing_person: "lead", new_person: "lead", mark_lead: false, sales_template: true, sort_order: 10 },
  client: { existing_person: "attach", new_person: "lead", mark_lead: false, sales_template: false, sort_order: 20 },
  private: { existing_person: "none", new_person: "none", mark_lead: false, sales_template: false, sort_order: 40 },
}
const kinds = (["lead", "client", "private"] as const).map((s) => ({ id: `k-${s}`, catalog_id: "booking_kinds", slug: s, display_name: s[0].toUpperCase() + s.slice(1), status: "active", metadata: META[s] }))

/** a paid link row as the database holds it */
const paidRow = (over: Partial<Record<string, unknown>> = {}) => ({
  id: LINK,
  public_id: TAG,
  kind_label: "Client",
  rule_snapshot: {},
  contact_id: C1,
  account_id: null,
  lead_id: null,
  person_name: "Maria Rossi",
  person_language: "Italian",
  person_emails: ["maria@example.com"],
  claimed_event_uri: null,
  revoked_at: null,
  status: "open",
  once: true,
  open_count: 0,
  created_at: "2026-11-15T10:00:00.000Z",
  duration_minutes: 30,
  pay_amount_cents: 39700,
  pay_currency: "EUR",
  pay_label: "Strategic call",
  pay_mode: "revenue_only",
  pay_code: PAYCODE,
  stripe_session_id: null,
  session_expires_at: null,
  session_claim_at: null,
  sent_at: null,
  sent_count: 0,
  paid_session_id: null,
  paid_at: null,
  not_charging_at: null,
  ...over,
})

/** the delivery Calendly's webhook stored for a booking made through the link (the real shape: the link id is the tag `utm_term`) */
const delivery = (over: Record<string, unknown> = {}) => ({
  id: "w1",
  source: "calendly",
  event_type: "invitee.created",
  created_at: "2026-11-15T12:00:00.000Z",
  payload: { payload: { event: EV, name: "Maria Rossi", email: "maria@example.com", tracking: { utm_term: TAG }, scheduled_event: { start_time: "2026-11-17T15:00:00Z" } } },
  ...over,
})

/**
 * The stored-booking reader asks PostgREST for JSON paths (`payload->payload->tracking->>utm_term`), which the in-memory helper does not evaluate, so the tests that read
 * stored bookings stand in a tiny fake for that table only.
 */
function withDeliveries(db: ReturnType<typeof miniDb>, rows: unknown[]) {
  const real = db.from.bind(db)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a tiny test fake
  ;(db as any).from = (table: string) => {
    if (table !== "webhook_events") return real(table)
    const flat = rows.map((r) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = (r as any).payload.payload
      return { storedAt: (r as { created_at: string }).created_at, tag: p.tracking?.utm_term, eventUri: p.event, startTime: p.scheduled_event?.start_time, cancelUrl: p.cancel_url ?? null, bookerName: p.name, bookerFirst: p.first_name ?? null, bookerLast: p.last_name ?? null, bookerEmail: p.email, bookerPhone: p.text_reminder_number ?? null, bookerAnswers: p.questions_and_answers ?? null }
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q: any = { select: () => q, eq: () => q, in: () => q, order: () => q, limit: () => q, then: (res: (v: unknown) => unknown) => res({ data: flat, error: null }) }
    return q
  }
  return db
}

function calendly(answer: (req: CalendlyHttpRequest) => { status: number; body?: unknown }) {
  const calls: CalendlyHttpRequest[] = []
  const ctx: CalendlyCtx = {
    token: "t",
    http: async (req) => {
      calls.push(req)
      const a = answer(req)
      return { status: a.status, json: async () => a.body }
    },
  }
  return { ctx, calls }
}
const eventBody = (over: Record<string, unknown> = {}) => ({ resource: { uri: EV, status: "active", start_time: "2026-11-17T15:00:00Z", name: "New Meeting", ...over } })
const cancelledBody = eventBody({ status: "canceled", cancellation: { canceler_type: "host" } })

function fakeStripe(over: Partial<{ readResult: unknown; createResult: unknown }> = {}) {
  const created: unknown[] = []
  const expired: string[] = []
  const ops: StripeOps = {
    create: (async (p: unknown) => {
      created.push(p)
      return over.createResult ?? { success: true, sessionId: "cs_live_new1", checkoutUrl: "https://checkout.stripe.com/c/pay/cs_live_new1", expiresAt: new Date("2026-11-16T13:00:00Z") }
    }) as StripeOps["create"],
    read: (async () => over.readResult ?? { ok: true, status: "expired", paymentStatus: "unpaid", url: null }) as StripeOps["read"],
    expire: (async (id: string) => {
      expired.push(id)
      return { ok: true }
    }) as StripeOps["expire"],
  }
  return { ops, created, expired }
}

// ── the small pure pieces ───────────────────────────────────────────────────────────────

describe("payment words and states", () => {
  it("the payment address is our own page and the money is written plainly", () => {
    expect(payUrl(PAYCODE, "https://app.example.com/")).toBe(`https://app.example.com/pay/b/${PAYCODE}`)
    expect(moneyText(39700, "EUR")).toBe("€397.00")
    expect(moneyText(150050, "USD")).toBe("$1,500.50")
  })
  it("a link is paid-for only with a price, USD or EUR, and a pay code", () => {
    expect(isPaidLink({ pay_amount_cents: 100, pay_currency: "USD", pay_code: PAYCODE })).toBe(true)
    for (const bad of [{ pay_amount_cents: null, pay_currency: "USD", pay_code: PAYCODE }, { pay_amount_cents: 100, pay_currency: "GBP", pay_code: PAYCODE }, { pay_amount_cents: 100, pay_currency: "USD", pay_code: null }, { pay_amount_cents: 0, pay_currency: "USD", pay_code: PAYCODE }]) expect(isPaidLink(bad)).toBe(false)
  })
  it("paid wins over 'not charging'; anything else open is unpaid", () => {
    expect(payStateOf({ paid_session_id: "cs_1", not_charging_at: "2026-11-15" })).toBe("paid")
    expect(payStateOf({ paid_session_id: null, not_charging_at: "2026-11-15" })).toBe("not_charging")
    expect(payStateOf({})).toBe("unpaid")
  })
  it("anything that is not exactly 'credit' is revenue only (never promises a credit nobody decided on)", () => {
    expect(parsePayMode("credit")).toBe("credit")
    for (const v of ["revenue_only", "", null, undefined, "CREDIT", 7]) expect(parsePayMode(v)).toBe("revenue_only")
    expect(payModeText("credit")).toMatch(/credit of the same amount/)
    expect(payModeText("revenue_only")).toMatch(/already used up/)
  })
  it("the message Antonio sees first is written in the person's language, with the amount and the address", () => {
    const en = paymentDraft({ language: "English", name: "Maria Rossi", amountText: "€397.00", url: "https://x/pay/b/1", when: "Tue, Nov 17, 10:00 AM ET" })
    expect(en.subject).toBe("Payment for our call with Tony Durante")
    expect(en.body).toContain("Hello Maria,")
    expect(en.body).toContain("€397.00")
    expect(en.body).toContain("https://x/pay/b/1")
    expect(en.body).toContain("Tue, Nov 17, 10:00 AM ET")
    const it = paymentDraft({ language: "Italian", name: null, amountText: "$100.00", url: "https://x/pay/b/1", when: null })
    expect(it.subject).toBe("Pagamento della nostra chiamata con Tony Durante")
    expect(it.body.startsWith("Ciao,")).toBe(true)
    expect(paymentDraft({ language: null, name: null, amountText: "$1.00", url: "u", when: null }).subject).toBe(en.subject)
  })
})

describe("the price in the request body", () => {
  it("left out, null or false is a free link; an object is passed on; anything else is refused", () => {
    for (const free of [undefined, null, false]) expect(paymentFrom(free)).toEqual({ ok: true, value: null })
    expect(paymentFrom({ amount: "397", currency: "USD", label: "x", confirmed: true })).toEqual({ ok: true, value: { amount: "397", currency: "USD", label: "x", confirmed: true } })
    expect(paymentFrom({ amount: 5 })).toMatchObject({ ok: true, value: { amount: 5, confirmed: false } })
    for (const bad of ["397", 397, true, ["x"]]) expect(paymentFrom(bad)).toEqual({ ok: false })
  })
})

describe("the plan for a paid link", () => {
  const client = { slug: "client", label: "Client", metadata: META.client }
  it("a paid link is one-time, plain questions, and says how it will be recorded", () => {
    const r = decideLinkPlan({ person: { state: "contact", established: true }, kind: client, minutes: 30, payment: { amount: "397", currency: "eur" } })
    expect(r).toMatchObject({ ok: true, needsConfirm: false, plan: { once: true, template: "plain", payment: { amountCents: 39700, currency: "EUR", payMode: "revenue_only" } } })
    expect(decideLinkPlan({ person: { state: "new" }, kind: { slug: "lead", label: "Lead", metadata: META.lead }, minutes: 30, payment: { amount: "100", currency: "USD" } })).toMatchObject({ plan: { payment: { payMode: "credit" }, template: "plain" } })
    expect(decideLinkPlan({ person: { state: "contact", established: false }, kind: client, minutes: 30, payment: { amount: "100", currency: "USD" } })).toMatchObject({ plan: { payment: { payMode: "credit" } } })
    expect(decideLinkPlan({ person: { state: "contact" }, kind: client, minutes: 30, payment: { amount: "100", currency: "USD" } })).toMatchObject({ plan: { payment: { payMode: "revenue_only" } } })
  })
  it("refuses a made-up amount, a third currency, a too-small amount and a kind that saves nothing", () => {
    const base = { person: { state: "contact" as const, established: true }, kind: client, minutes: 30 }
    for (const amount of ["", "abc", "0", "-5", "1e3", "0.10", "50001"]) expect(decideLinkPlan({ ...base, payment: { amount, currency: "USD" } }), amount).toMatchObject({ ok: false })
    expect(decideLinkPlan({ ...base, payment: { amount: "100", currency: "GBP" } })).toMatchObject({ ok: false })
    expect(decideLinkPlan({ person: { state: "contact", established: true }, kind: { slug: "private", label: "Private", metadata: META.private }, minutes: 30, payment: { amount: "100", currency: "USD" } })).toMatchObject({ ok: false })
  })
  it("a large amount needs the tick", () => {
    const base = { person: { state: "contact" as const, established: true }, kind: client, minutes: 30 }
    expect(decideLinkPlan({ ...base, payment: { amount: "2000", currency: "USD" } })).toMatchObject({ ok: true, needsConfirm: false })
    expect(decideLinkPlan({ ...base, payment: { amount: "2000.01", currency: "USD" } })).toMatchObject({ ok: true, needsConfirm: true })
    expect(decideLinkPlan({ ...base, payment: { amount: "3970", currency: "USD", confirmed: true } })).toMatchObject({ ok: true, needsConfirm: false })
  })
  it("the preview tells the money, how it is recorded and that the link is one-time", () => {
    const r = decideLinkPlan({ person: { state: "contact", established: true }, kind: client, minutes: 30, payment: { amount: "397", currency: "EUR" } })
    if (!("plan" in r)) throw new Error("plan expected")
    const lines = describePlan({ plan: r.plan, personState: "contact", personName: "Maria Rossi", hasEmails: true })
    expect(lines.find((l) => l.label === "Payment")?.text).toMatch(/€397\.00/)
    expect(lines.find((l) => l.label === "Money")?.text).toMatch(/revenue only/i)
    expect(lines.find((l) => l.label === "Length")?.text).toMatch(/30 minutes and can be booked only once/)
    // 16 Nov 2026: the person books AND pays on our own page, the call is booked as soon as the time is picked
    expect(lines.find((l) => l.label === "Payment")?.text).toMatch(/book and pay by card, all on our own page/)
  })
})

// ── making a paid link ───────────────────────────────────────────────────────────────

const makerSeed = () => ({
  catalog_entries: kinds,
  contacts: [{ id: C1, full_name: "Maria Rossi", email: "maria@example.com", email_2: null, alt_emails: [], language: "Italian", portal_tier: "active", merged_into: null, created_at: "2026-01-01" }],
  account_contacts: [{ contact_id: C1, account_id: A1, is_primary: true, ended_at: null }],
  accounts: [{ id: A1, company_name: "Rossi LLC" }],
  service_deliveries: [],
  leads: [{ id: L1, full_name: "Daniel Green", email: "daniel@example.com", language: "English", converted_to_contact_id: null, created_at: "2026-11-10" }],
  app_settings: [{ key: "booking_templates", value: { plain: { event_type_uri: TYPE, scheduling_url: "https://calendly.com/x/new-meeting" }, sales: { event_type_uri: SALES_TYPE, scheduling_url: "https://calendly.com/x/free" } } }],
  booking_links: [],
})
const shareOk = { status: 201, body: { resource: { scheduling_links: [{ booking_url: "https://calendly.com/d/abc-123/new-meeting" }] } } }

describe("making a paid link", () => {
  it("stores the price, how it is recorded and a pay code, and makes NO Calendly link (the person books on our own page)", async () => {
    const db = miniDb(makerSeed())
    const { ctx, calls } = calendly(() => shareOk)
    const r = await makeLink({ db, calendly: ctx, createdBy: "antonio@x" }, { person: { type: "contact", id: C1 }, kindSlug: "client", minutes: 30, payment: { amount: "397", currency: "EUR", label: " Strategic   call " } })
    expect(r).toMatchObject({ ok: true })
    expect(calls).toHaveLength(0) // 16 Nov 2026: no share link; /r/b/<id> sends the person to /pay/b/<code>
    const row = db.tables.booking_links[0]
    expect(row).toMatchObject({ pay_amount_cents: 39700, pay_currency: "EUR", pay_label: "Strategic call", pay_mode: "revenue_only", once: true, template_slug: "plain", share_url: null })
    expect(typeof row.pay_code).toBe("string")
    expect(row.pay_code).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(row.pay_code).not.toBe(row.public_id)
  })
  it("a person who is only a lead is recorded in credit mode", async () => {
    const db = miniDb(makerSeed())
    const { ctx } = calendly(() => shareOk)
    await makeLink({ db, calendly: ctx, createdBy: "a" }, { person: { type: "lead", id: L1 }, kindSlug: "lead", minutes: 30, payment: { amount: "100", currency: "USD" } })
    expect(db.tables.booking_links[0]).toMatchObject({ pay_mode: "credit", pay_amount_cents: 10000, pay_currency: "USD", pay_label: null })
  })
  it("a FREE link is made exactly as before: no payment columns written, and 30 minutes needs no Calendly call", async () => {
    const db = miniDb(makerSeed())
    const { ctx, calls } = calendly(() => shareOk)
    const r = await makeLink({ db, calendly: ctx, createdBy: "a" }, { person: { type: "contact", id: C1 }, kindSlug: "client", minutes: 30 })
    expect(r).toMatchObject({ ok: true })
    expect(calls).toHaveLength(0)
    expect(Object.keys(db.tables.booking_links[0]).filter((k) => k.startsWith("pay_"))).toEqual([])
  })
  it("a large amount is refused until the tick is given, and nothing is written or asked of Calendly", async () => {
    const db = miniDb(makerSeed())
    const { ctx, calls } = calendly(() => shareOk)
    const r = await makeLink({ db, calendly: ctx, createdBy: "a" }, { person: { type: "contact", id: C1 }, kindSlug: "client", minutes: 30, payment: { amount: "3970", currency: "USD" } })
    expect(r).toEqual({ ok: false, errors: [LARGE_AMOUNT_TEXT], needsConfirm: true })
    expect(db.tables.booking_links).toHaveLength(0)
    expect(calls).toHaveLength(0)
    const ok = await makeLink({ db, calendly: ctx, createdBy: "a" }, { person: { type: "contact", id: C1 }, kindSlug: "client", minutes: 30, payment: { amount: "3970", currency: "USD", confirmed: true } })
    expect(ok).toMatchObject({ ok: true })
  })
  it("a paid link asks Calendly for nothing when it is made, so a Calendly that is down or refuses the app does not stop it", async () => {
    const db = miniDb(makerSeed())
    const { ctx, calls } = calendly(() => ({ status: 403 }))
    const r = await makeLink({ db, calendly: ctx, createdBy: "a" }, { person: { type: "contact", id: C1 }, kindSlug: "client", minutes: 30, payment: { amount: "100", currency: "USD" } })
    expect(r).toMatchObject({ ok: true })
    expect(calls).toHaveLength(0)
    expect(db.tables.booking_links).toHaveLength(1)
  })
  it("a paid call longer or shorter than 30 minutes is refused in plain words, and nothing is written", async () => {
    const db = miniDb(makerSeed())
    const { ctx, calls } = calendly(() => shareOk)
    const r = await makeLink({ db, calendly: ctx, createdBy: "a" }, { person: { type: "contact", id: C1 }, kindSlug: "client", minutes: 60, payment: { amount: "100", currency: "USD" } })
    expect(r).toEqual({ ok: false, errors: [PAID_LENGTH_TEXT] })
    expect(db.tables.booking_links).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })
  it("the preview and the made link judge the same (judgeLink reports the tick)", async () => {
    const j = await judgeLink(miniDb(makerSeed()), { person: { type: "contact", id: C1 }, kindSlug: "client", minutes: 30, payment: { amount: "5000", currency: "USD" } })
    expect(j).toMatchObject({ ok: true, judged: { needsConfirm: true } })
  })
})

// ── the payment page ─────────────────────────────────────────────────────────────────

describe("the payment page: finding the link", () => {
  it("only a code of our exact shape is looked up; a free link is not a paid link", async () => {
    const db = miniDb({ booking_links: [paidRow(), paidRow({ id: "x", pay_code: null, pay_amount_cents: null, public_id: "A".repeat(22) })] })
    expect((await findPayLink(db, PAYCODE)).state).toBe("found")
    for (const bad of ["short", "x".repeat(23), "../etc/passwd", null, 5]) expect((await findPayLink(db, bad)).state).toBe("none")
    expect(db.log).toHaveLength(1) // only the one well-formed code reached the database
  })
  it("a database that fails is not 'link not found'; a database without the columns yet has no paid links", async () => {
    expect((await findPayLink(miniDb({ booking_links: [] }, { failing: { booking_links: "boom" } }), PAYCODE)).state).toBe("error")
    expect((await findPayLink(miniDb({}, { missing: ["booking_links"] }), PAYCODE)).state).toBe("none")
  })
})

describe("the payment page: opening the card page", () => {
  const open = (db: ReturnType<typeof miniDb>, stripe = fakeStripe(), calendlyCtx?: CalendlyCtx) => openPayment({ db, now: NOW, stripe: stripe.ops, calendly: calendlyCtx }, PAYCODE)

  it("makes a card page with the labels the payment recorder reads, the person's own email pre-filled, and remembers it", async () => {
    const db = miniDb({ booking_links: [paidRow()], contacts: [{ id: C1, email: "Maria@Example.com" }] })
    const s = fakeStripe()
    const r = await open(db, s)
    expect(r).toEqual({ ok: true, url: "https://checkout.stripe.com/c/pay/cs_live_new1" })
    expect(s.created).toEqual([{ amountCents: 39700, currency: "EUR", productName: "Strategic call", clientEmail: "maria@example.com", metadata: { payment_kind: "paid_call", booking_link_id: LINK, pay_mode: "revenue_only", client_email: "maria@example.com", client_name: "Maria Rossi" } }])
    expect(db.tables.booking_links[0]).toMatchObject({ stripe_session_id: "cs_live_new1", session_claim_at: null })
    expect(db.tables.booking_links[0].session_expires_at).toBe("2026-11-16T13:00:00.000Z")
  })
  it("a link made for a lead also carries the lead (so the lead's own note line is written)", async () => {
    const db = miniDb({ booking_links: [paidRow({ contact_id: null, lead_id: L1, pay_mode: "credit" })], leads: [{ id: L1, email: "daniel@example.com" }] })
    const s = fakeStripe()
    await open(db, s)
    expect(s.created[0]).toMatchObject({ clientEmail: "daniel@example.com", metadata: { crm_lead_ref: L1, pay_mode: "credit" } })
  })
  it("reuses a card page that is still open (a second click never makes a second one)", async () => {
    const db = miniDb({ booking_links: [paidRow({ stripe_session_id: "cs_live_old" })], contacts: [{ id: C1, email: "maria@example.com" }] })
    const s = fakeStripe({ readResult: { ok: true, status: "open", paymentStatus: "unpaid", url: "https://checkout.stripe.com/c/pay/cs_live_old" } })
    expect(await open(db, s)).toEqual({ ok: true, url: "https://checkout.stripe.com/c/pay/cs_live_old" })
    expect(s.created).toHaveLength(0)
  })
  it("an expired card page is replaced by a new one", async () => {
    const db = miniDb({ booking_links: [paidRow({ stripe_session_id: "cs_live_old" })], contacts: [{ id: C1, email: "maria@example.com" }] })
    const s = fakeStripe({ readResult: { ok: true, status: "expired", paymentStatus: "unpaid", url: null } })
    expect(await open(db, s)).toMatchObject({ ok: true })
    expect(s.created).toHaveLength(1)
    expect(db.tables.booking_links[0].stripe_session_id).toBe("cs_live_new1")
  })
  it("if Stripe cannot be asked about the earlier card page, NOTHING new is made (a parallel page could be paid twice)", async () => {
    const db = miniDb({ booking_links: [paidRow({ stripe_session_id: "cs_live_old" })] })
    const s = fakeStripe({ readResult: { ok: false, error: "network" } })
    expect(await open(db, s)).toMatchObject({ ok: false, reason: "stripe" })
    expect(s.created).toHaveLength(0)
  })
  it("a card page that was already paid is never replaced", async () => {
    const db = miniDb({ booking_links: [paidRow({ stripe_session_id: "cs_live_old" })] })
    const s = fakeStripe({ readResult: { ok: true, status: "complete", paymentStatus: "paid", url: null } })
    expect(await open(db, s)).toMatchObject({ ok: false, reason: "paid" })
    expect(s.created).toHaveLength(0)
  })
  it("a paid link, a link marked 'Not charging', a stopped link and an unknown code never make a card page", async () => {
    for (const [over, reason] of [[{ paid_session_id: "cs_1" }, "paid"], [{ not_charging_at: "2026-11-15T10:00:00Z" }, "stopped"], [{ revoked_at: "2026-11-15T10:00:00Z" }, "stopped"]] as const) {
      const s = fakeStripe()
      expect(await open(miniDb({ booking_links: [paidRow(over)] }), s)).toMatchObject({ ok: false, reason })
      expect(s.created).toHaveLength(0)
    }
    expect(await openPayment({ db: miniDb({ booking_links: [] }), now: NOW, stripe: fakeStripe().ops }, "nope")).toMatchObject({ ok: false, reason: "none" })
  })
  it("a call Calendly says was cancelled takes no payment; a Calendly that cannot be asked never blocks one", async () => {
    const seedDb = () => withDeliveries(miniDb({ booking_links: [paidRow()], contacts: [{ id: C1, email: "maria@example.com" }] }), [delivery()])
    const cancelled = calendly(() => ({ status: 200, body: cancelledBody }))
    const s1 = fakeStripe()
    expect(await open(seedDb(), s1, cancelled.ctx)).toMatchObject({ ok: false, reason: "cancelled" })
    expect(s1.created).toHaveLength(0)
    const down = calendly(() => ({ status: 500 }))
    expect(await open(seedDb(), fakeStripe(), down.ctx)).toMatchObject({ ok: true })
    const live = calendly(() => ({ status: 200, body: eventBody() }))
    expect(await open(seedDb(), fakeStripe(), live.ctx)).toMatchObject({ ok: true })
  })
  it("a click while another click is making the card page is told to wait, and makes nothing", async () => {
    const s = fakeStripe()
    // the in-memory database does not interpret the lease filter, so the update that takes the lease is made to find nothing, as it does while a lease is held
    const row = paidRow()
    const db = miniDb({ booking_links: [row] })
    const real = db.from.bind(db)
    let first = true
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a tiny test fake
    ;(db as any).from = (t: string) => {
      const b = real(t) as Record<string, (...a: unknown[]) => unknown>
      if (t !== "booking_links") return b
      const upd = b.update
      b.update = (p: unknown) => {
        const chain = upd(p) as Record<string, (...a: unknown[]) => unknown>
        if (first && typeof p === "object" && p && "session_claim_at" in p) {
          first = false
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const stub: any = { eq: () => stub, is: () => stub, or: () => stub, select: async () => ({ data: [], error: null }) }
          return stub
        }
        return chain
      }
      return b
    }
    expect(await open(db, s)).toMatchObject({ ok: false, reason: "busy" })
    expect(s.created).toHaveLength(0)
  })
  it("if Stripe will not make the page, the lease is let go and the person is told to try again", async () => {
    const db = miniDb({ booking_links: [paidRow()], contacts: [{ id: C1, email: "maria@example.com" }] })
    const s = fakeStripe({ createResult: { success: false, error: "stripe down" } })
    expect(await open(db, s)).toMatchObject({ ok: false, reason: "stripe", message: SAYS.stripe })
    expect(db.tables.booking_links[0].session_claim_at).toBeNull()
  })
})

describe("who the payment is recorded on", () => {
  it("a contact's own email, else a lead's, else (a link for someone new) the BOOKER's email from the stored booking, else the email the link was made with, else nobody", async () => {
    const row = (over: Record<string, unknown>) => ({ ...paidRow(over) }) as never
    expect(await identityEmail(miniDb({ contacts: [{ id: C1, email: "Maria@Example.com" }] }), row({}))).toBe("maria@example.com")
    expect(await identityEmail(miniDb({ leads: [{ id: L1, email: "Daniel@Example.com" }] }), row({ contact_id: null, lead_id: L1 }))).toBe("daniel@example.com")
    expect(await identityEmail(miniDb({}), row({ contact_id: null, person_emails: ["First@Example.com"] }))).toBe("first@example.com")
    expect(await identityEmail(withDeliveries(miniDb({}), [delivery()]), row({ contact_id: null, person_emails: [] }))).toBe("maria@example.com")
    expect(await identityEmail(withDeliveries(miniDb({}), []), row({ contact_id: null, person_emails: [] }))).toBeNull()
  })
  it("a typo in the email Antonio typed for someone new never wins over the address the booker really used", async () => {
    const row = ({ ...paidRow({ contact_id: null, person_emails: ["mario@gmial.com"] }) }) as never
    expect(await identityEmail(withDeliveries(miniDb({}), [delivery({ payload: { payload: { event: EV, name: "Mario", email: "mario@gmail.com", tracking: { utm_term: TAG }, scheduled_event: { start_time: "2026-11-17T15:00:00Z" } } } })]), row)).toBe("mario@gmail.com")
    expect(await identityEmail(miniDb({}), row)).toBe("mario@gmial.com") // nobody has booked yet: the typed one
  })
  it("the name a new contact would get: the link's own name, else the booker's — never the name on the card", async () => {
    const row = (over: Record<string, unknown>) => ({ ...paidRow(over) }) as never
    expect(await identityName(miniDb({}), row({ person_name: "  Maria Rossi " }))).toBe("Maria Rossi")
    expect(await identityName(withDeliveries(miniDb({}), [delivery()]), row({ person_name: null }))).toBe("Maria Rossi")
    expect(await identityName(withDeliveries(miniDb({}), []), row({ person_name: null }))).toBeNull()
  })
  it("someone new (no name, no email on the link) gets the BOOKER's name and email on the card page", async () => {
    const db = withDeliveries(miniDb({ booking_links: [paidRow({ contact_id: null, person_name: null, person_emails: [] })] }), [delivery()])
    const s = fakeStripe()
    await openPayment({ db, now: NOW, stripe: s.ops }, PAYCODE)
    expect(s.created[0]).toMatchObject({ clientEmail: "maria@example.com", metadata: { client_email: "maria@example.com", client_name: "Maria Rossi" } })
  })
})

// ── recording the payment ─────────────────────────────────────────────────────────────

const session = (over: Partial<BookingPaySession> = {}): BookingPaySession => ({
  id: "cs_live_a",
  payment_intent: "pi_1",
  amount_total: 39700,
  currency: "eur",
  customer_details: { email: "payer@card.example", name: "Someone Else" },
  metadata: { payment_kind: "paid_call", booking_link_id: LINK, pay_mode: "revenue_only", client_email: "maria@example.com" },
  ...over,
})

function recordHarness(rows: Record<string, unknown>[] = [paidRow()], settleOk = true) {
  const db = miniDb({ booking_links: rows, contacts: [{ id: C1, email: "maria@example.com" }] })
  const settle = vi.fn(async () => (settleOk ? { ok: true } : { ok: false, status: 500, error: "boom" }))
  const errors: string[] = []
  return { db, settle, errors, deps: { db, now: NOW, settle: settle as never, reportError: async (m: string) => { errors.push(m) } } }
}

describe("recording a paid link's payment", () => {
  it("revenue-only mode: recorded on the link's person with the credit born used, and the link is marked paid", async () => {
    const h = recordHarness()
    expect(await recordBookingLinkPayment(session(), h.deps)).toEqual({ handled: true })
    expect(h.settle).toHaveBeenCalledTimes(1)
    const call = (h.settle.mock.calls as unknown as Array<[{ payment: { email: string; amount: number; currency: string; sessionId: string }; resolution: string; leadId: string | null }]>)[0][0]
    expect(call).toMatchObject({ resolution: "paid_call_already_deducted", leadId: null, payment: { email: "maria@example.com", amount: 397, currency: "EUR", sessionId: "cs_live_a" } })
    expect(h.db.tables.booking_links[0]).toMatchObject({ paid_session_id: "cs_live_a" })
    expect(h.db.tables.booking_links[0].paid_at).toBe(NOW.toISOString())
  })
  it("credit mode records the normal paid call + credit", async () => {
    const h = recordHarness([paidRow({ pay_mode: "credit", contact_id: null, lead_id: L1 })])
    await recordBookingLinkPayment(session(), h.deps)
    expect((h.settle.mock.calls as unknown as Array<[{ resolution: string; leadId: string | null }]>)[0][0]).toMatchObject({ resolution: "paid_call", leadId: L1 })
  })
  it("never the payer's own name or card email when the link knows its person", async () => {
    const h = recordHarness()
    await recordBookingLinkPayment(session({ customer_details: { email: "stranger@card.example", name: "Stranger" } }), h.deps)
    expect((h.settle.mock.calls as unknown as Array<[{ payment: { email: string } }]>)[0][0].payment.email).toBe("maria@example.com")
  })
  it("someone new with no known email is recorded on whoever paid (as every payment link already does)", async () => {
    const h = recordHarness([paidRow({ contact_id: null, person_emails: [] })])
    await recordBookingLinkPayment(session({ metadata: { payment_kind: "paid_call", booking_link_id: LINK } }), h.deps)
    expect((h.settle.mock.calls as unknown as Array<[{ payment: { email: string } }]>)[0][0].payment.email).toBe("payer@card.example")
  })
  it("a NEW contact is named after the person the link was made for, never the name on the card", async () => {
    const h = recordHarness([paidRow({ contact_id: null, person_emails: [] })])
    await recordBookingLinkPayment(session({ metadata: { payment_kind: "paid_call", booking_link_id: LINK, client_email: "new@example.com", client_name: "Real Booker" } }), h.deps)
    expect((h.settle.mock.calls as unknown as Array<[{ payment: { name: string; email: string } }]>)[0][0].payment).toMatchObject({ name: "Real Booker", email: "new@example.com" })
    const h2 = recordHarness([paidRow({ contact_id: null, person_emails: [] })])
    await recordBookingLinkPayment(session({ metadata: { payment_kind: "paid_call", booking_link_id: LINK } }), h2.deps)
    expect((h2.settle.mock.calls as unknown as Array<[{ payment: { name: string } }]>)[0][0].payment.name).toBe("Someone Else") // an older card page with no name: the payer's, as every payment link already does
  })
  it("a second payment on an already-paid link (a different Stripe session) is revenue only, reported loudly, and never replaces the first", async () => {
    const h = recordHarness([paidRow({ pay_mode: "credit", paid_session_id: "cs_live_first" })])
    await recordBookingLinkPayment(session({ id: "cs_live_second" }), h.deps)
    expect((h.settle.mock.calls as unknown as Array<[{ resolution: string }]>)[0][0].resolution).toBe("paid_call_already_deducted")
    expect(h.errors.join(" ")).toMatch(/second payment/i)
    expect(h.db.tables.booking_links[0].paid_session_id).toBe("cs_live_first")
  })
  it("a redelivery of the SAME session settles again (idempotent) and does not report a second payment", async () => {
    const h = recordHarness([paidRow({ pay_mode: "credit", paid_session_id: "cs_live_a" })])
    await recordBookingLinkPayment(session(), h.deps)
    expect((h.settle.mock.calls as unknown as Array<[{ resolution: string }]>)[0][0].resolution).toBe("paid_call")
    expect(h.errors).toEqual([])
  })
  it("an amount that differs from the link's price is recorded as paid and reported", async () => {
    const h = recordHarness()
    await recordBookingLinkPayment(session({ amount_total: 30000 }), h.deps)
    expect((h.settle.mock.calls as unknown as Array<[{ payment: { amount: number } }]>)[0][0].payment.amount).toBe(300)
    expect(h.errors.join(" ")).toMatch(/differs from the link's price/)
  })
  it("a link that no longer exists is reported and handed back to the old email path", async () => {
    const h = recordHarness([])
    expect(await recordBookingLinkPayment(session(), h.deps)).toEqual({ handled: false })
    expect(h.settle).not.toHaveBeenCalled()
    expect(h.errors.join(" ")).toMatch(/no longer exists/)
  })
  it("no booking_link_id (or a made-up one) is not handled here at all", async () => {
    const h = recordHarness()
    for (const metadata of [{ payment_kind: "paid_call" }, { payment_kind: "paid_call", booking_link_id: "not-a-uuid" }, null]) expect(await recordBookingLinkPayment(session({ metadata }), h.deps)).toEqual({ handled: false })
    expect(h.settle).not.toHaveBeenCalled()
  })
  it("if the money cannot be recorded it THROWS (so Stripe sends it again) and the link is NOT marked paid", async () => {
    const h = recordHarness([paidRow()], false)
    await expect(recordBookingLinkPayment(session(), h.deps)).rejects.toThrow(/boom/)
    expect(h.db.tables.booking_links[0].paid_session_id).toBeNull()
  })
  it("a database that fails reading the link THROWS rather than being read as 'no such link'", async () => {
    const db = miniDb({}, { failing: { booking_links: "db down" } })
    await expect(recordBookingLinkPayment(session(), { db, now: NOW, settle: vi.fn() as never, reportError: async () => undefined })).rejects.toThrow(/db down/)
  })
  it("an unusable amount or currency throws", async () => {
    const h = recordHarness()
    await expect(recordBookingLinkPayment(session({ amount_total: 0 }), h.deps)).rejects.toThrow(/unusable/)
    await expect(recordBookingLinkPayment(session({ currency: "gbp" }), h.deps)).rejects.toThrow(/unusable/)
  })
})

// ── the card buttons ──────────────────────────────────────────────────────────────────

describe("'I sent it'", () => {
  it("remembers it and counts it; pressing twice counts twice; a paid or stopped link refuses; a free link has nothing to send", async () => {
    const db = miniDb({ booking_links: [paidRow()] })
    expect(await markPaymentSent(db, LINK, NOW)).toMatchObject({ ok: true })
    expect(db.tables.booking_links[0]).toMatchObject({ sent_count: 1, sent_at: NOW.toISOString() })
    await markPaymentSent(db, LINK, NOW)
    expect(db.tables.booking_links[0].sent_count).toBe(2)
    expect(await markPaymentSent(miniDb({ booking_links: [paidRow({ paid_session_id: "cs_1" })] }), LINK, NOW)).toMatchObject({ ok: false, status: 409 })
    expect(await markPaymentSent(miniDb({ booking_links: [paidRow({ not_charging_at: "2026-11-15" })] }), LINK, NOW)).toMatchObject({ ok: false, status: 409 })
    expect(await markPaymentSent(miniDb({ booking_links: [paidRow({ pay_amount_cents: null })] }), LINK, NOW)).toMatchObject({ ok: false, status: 409 })
    expect(await markPaymentSent(miniDb({ booking_links: [] }), LINK, NOW)).toMatchObject({ ok: false, status: 404 })
    expect(await markPaymentSent(db, "nope", NOW)).toMatchObject({ ok: false, status: 404 })
  })
})

describe("'Not charging'", () => {
  it("closes the card, closes the Stripe card page too, and says so", async () => {
    const db = miniDb({ booking_links: [paidRow({ stripe_session_id: "cs_live_old" })] })
    const expire = vi.fn(async () => ({ ok: true }))
    const r = await stopCharging(db, LINK, NOW, { expire })
    expect(r).toMatchObject({ ok: true })
    expect(expire).toHaveBeenCalledWith("cs_live_old")
    expect(db.tables.booking_links[0].not_charging_at).toBe(NOW.toISOString())
  })
  it("if Stripe will not close the card page, it still stops (the payment page refuses from now on) and tells him", async () => {
    const db = miniDb({ booking_links: [paidRow({ stripe_session_id: "cs_live_old" })] })
    const r = await stopCharging(db, LINK, NOW, { expire: async () => ({ ok: false, error: "x" }) })
    expect(r).toMatchObject({ ok: true })
    expect("message" in r && r.message).toMatch(/could not be closed in Stripe/)
    expect(db.tables.booking_links[0].not_charging_at).toBe(NOW.toISOString())
  })
  it("a call that was already paid can never be marked 'not charging'; twice is fine", async () => {
    const paid = miniDb({ booking_links: [paidRow({ paid_session_id: "cs_1" })] })
    expect(await stopCharging(paid, LINK, NOW)).toMatchObject({ ok: false, status: 409 })
    expect(paid.tables.booking_links[0].not_charging_at).toBeNull()
    const db = miniDb({ booking_links: [paidRow()] })
    await stopCharging(db, LINK, NOW, { expire: async () => ({ ok: true }) })
    expect(await stopCharging(db, LINK, NOW, { expire: async () => ({ ok: true }) })).toMatchObject({ ok: true })
  })
  it("cancelling a paid call stops charging for it; cancelling a free call changes nothing", async () => {
    const paid = miniDb({ booking_links: [paidRow()] })
    await stopChargingIfPaidLink(paid, LINK, NOW, { expire: async () => ({ ok: true }) })
    expect(paid.tables.booking_links[0].not_charging_at).toBe(NOW.toISOString())
    const free = miniDb({ booking_links: [paidRow({ pay_amount_cents: null, pay_currency: null, pay_code: null })] })
    await stopChargingIfPaidLink(free, LINK, NOW)
    expect(free.tables.booking_links[0].not_charging_at).toBeNull()
    await expect(stopChargingIfPaidLink(miniDb({}, { failing: { booking_links: "boom" } }), LINK, NOW)).resolves.toBeUndefined()
  })
})

// ── the unpaid-call cards ─────────────────────────────────────────────────────────────

const booking = (over: Partial<LinkBooking> = {}): LinkBooking => ({ state: "booked", eventUri: EV, startTime: "2026-11-17T15:00:00Z", count: 1, ...over })
const stored = [{ tag: TAG, eventUri: EV, startTime: "2026-11-17T15:00:00Z", storedAt: "2026-11-15T12:00:00Z", cancelUrl: null, booker: { name: "Maria Rossi", email: "maria@example.com", phone: null, answers: [] } }]
const prow = (over: Partial<PaidLinkRow> = {}) => paidRow(over) as unknown as PaidLinkRow

describe("when an unpaid call needs a look", () => {
  it("never sent: right away. Sent: only from the day before the call", () => {
    expect(cardIsDue(null, "2026-11-17T15:00:00Z", NOW)).toBe(true)
    expect(cardIsDue("2026-11-15T13:00:00Z", "2026-11-17T15:00:00Z", NOW)).toBe(false)
    expect(cardIsDue("2026-11-15T13:00:00Z", "2026-11-17T15:00:00Z", new Date("2026-11-16T15:00:00Z"))).toBe(true)
    expect(cardIsDue("2026-11-15T13:00:00Z", "2026-11-17T15:00:00Z", new Date("2026-11-16T14:59:00Z"))).toBe(false)
    expect(cardIsDue("2026-11-15T13:00:00Z", null, NOW)).toBe(false)
  })
  it("a booked, unpaid call is a card with the amount, the way it will be recorded and a message in the person's language", () => {
    const c = decidePaidCard({ row: prow(), booking: booking(), stored, copyOnly: false, now: NOW, baseUrl: "https://app.example.com" })
    expect(c).toMatchObject({ kind: "unpaid_call", question: "Maria Rossi booked a paid call. Not paid yet.", answers: [], callAt: "2026-11-17T15:00:00Z" })
    expect(c?.why).toContain("€397.00")
    expect(c?.why).toMatch(/revenue only/i)
    expect(c?.paid).toMatchObject({ linkId: LINK, amountText: "€397.00", payUrl: `https://app.example.com/pay/b/${PAYCODE}`, email: "maria@example.com", copyOnly: false, sentAt: null })
    expect(c?.paid?.draft.subject).toBe("Pagamento della nostra chiamata con Tony Durante")
    expect(c?.paid?.draft.body).toContain(`https://app.example.com/pay/b/${PAYCODE}`)
  })
  it("no card: nobody booked, the call was cancelled, it was paid, or he said not charging", () => {
    expect(decidePaidCard({ row: prow(), booking: null, stored: [], copyOnly: false, now: NOW })).toBeNull()
    for (const state of ["cancelled_by_you", "cancelled_by_booker", "cancelled"] as const) expect(decidePaidCard({ row: prow(), booking: booking({ state }), stored, copyOnly: false, now: NOW })).toBeNull()
    expect(decidePaidCard({ row: prow({ paid_session_id: "cs_1" }), booking: booking(), stored, copyOnly: false, now: NOW })).toBeNull()
    expect(decidePaidCard({ row: prow({ not_charging_at: "2026-11-15" }), booking: booking(), stored, copyOnly: false, now: NOW })).toBeNull()
    expect(decidePaidCard({ row: prow({ pay_amount_cents: null }), booking: booking(), stored, copyOnly: false, now: NOW })).toBeNull()
  })
  it("a call Calendly could not be asked about still shows, with a plain warning; a portal client is told to copy by hand", () => {
    const c = decidePaidCard({ row: prow(), booking: booking({ state: "booked_unchecked" }), stored, copyOnly: true, now: NOW })
    expect(c?.note).toMatch(/could not be checked/)
    expect(c?.note).toMatch(/portal client/)
    expect(c?.paid?.copyOnly).toBe(true)
  })
  it("a link sent earlier comes back near the call and says so", () => {
    const c = decidePaidCard({ row: prow({ sent_at: "2026-11-15T13:00:00Z", sent_count: 2 }), booking: booking(), stored, copyOnly: false, now: new Date("2026-11-16T16:00:00Z") })
    expect(c?.note).toMatch(/marked the payment link as sent/)
    expect(c?.note).toMatch(/2 times/)
  })
})

describe("reading the unpaid calls", () => {
  it("only paid, unpaid, not-stopped links; booked ones become cards (Calendly checked); a cancelled call drops its card", async () => {
    const mk = () => withDeliveries(miniDb({ booking_links: [paidRow(), paidRow({ id: "f", public_id: "F".repeat(22), pay_amount_cents: null, pay_code: null }), paidRow({ id: "p", public_id: "P".repeat(22), pay_code: "Q".repeat(22), paid_session_id: "cs_1" })], contacts: [{ id: C1, portal_tier: "active" }] }), [delivery()])
    const live = calendly(() => ({ status: 200, body: eventBody() }))
    const r = await loadPaidCalls(mk(), NOW, live.ctx, "https://app.example.com")
    expect(r).toMatchObject({ ok: true })
    expect("cards" in r && r.cards).toHaveLength(1)
    expect("cards" in r && r.cards[0].paid).toMatchObject({ linkId: LINK, copyOnly: true }) // an active portal client: copy only
    const gone = calendly(() => ({ status: 200, body: cancelledBody }))
    expect(await loadPaidCalls(mk(), NOW, gone.ctx)).toEqual({ ok: true, cards: [] })
  })
  it("a contact whose portal level cannot be read is treated as a portal client (nothing is offered to be emailed)", async () => {
    const db = withDeliveries(miniDb({ booking_links: [paidRow()] }, { failing: { contacts: "boom" } }), [delivery()])
    const r = await loadPaidCalls(db, NOW, calendly(() => ({ status: 200, body: eventBody() })).ctx)
    expect("cards" in r && r.cards[0]?.paid?.copyOnly).toBe(true)
  })
  it("a failed read is a failure, never an empty list; a database without the payment columns or table has no paid links", async () => {
    expect(await loadPaidCalls(miniDb({}, { failing: { booking_links: "boom" } }), NOW)).toEqual({ ok: false, error: "The unpaid calls could not be read." })
    expect(await loadPaidCalls(miniDb({}, { missing: ["booking_links"] }), NOW)).toEqual({ ok: true, cards: [] })
    expect(await loadPaidCalls(miniDb({ booking_links: [] }), NOW)).toEqual({ ok: true, cards: [] })
  })
  it("with no Calendly key the call is still a card (it could not be checked)", async () => {
    const r = await loadPaidCalls(withDeliveries(miniDb({ booking_links: [paidRow()], contacts: [{ id: C1, portal_tier: null }] }), [delivery()]), NOW)
    expect("cards" in r && r.cards).toHaveLength(1)
    expect("cards" in r && r.cards[0].note).toMatch(/could not be checked/)
    expect("cards" in r && r.cards[0].paid?.copyOnly).toBe(false)
  })
  it("the page's list puts the unpaid calls first and is a failure if EITHER read failed", () => {
    const check = { ok: true as const, cards: [{ id: "c1", kind: "mismatch" as const, question: "q", why: "w", note: null, answers: [], madeAt: "x", callAt: null }], count: 1 }
    const paid = decidePaidCard({ row: prow(), booking: booking(), stored, copyOnly: false, now: NOW })!
    const merged = mergeCards(check, { ok: true, cards: [paid] })
    expect(merged).toMatchObject({ ok: true, count: 2 })
    expect("cards" in merged && merged.cards.map((c) => c.kind)).toEqual(["unpaid_call", "mismatch"])
    expect(mergeCards(check, { ok: false, error: "no" })).toEqual({ ok: false, error: "no" })
    expect(mergeCards({ ok: false, error: "bad" }, { ok: true, cards: [] })).toEqual({ ok: false, error: "bad" })
  })
})

describe("the price on a row of 'Links I made'", () => {
  it("says paid / not paid / not charging, and gives Make again the same price", () => {
    expect(payDtoOf({ pay_amount_cents: 39700, pay_currency: "EUR", pay_code: PAYCODE, pay_label: "Strategic call", paid_session_id: null, not_charging_at: null, sent_at: null }, "https://app.example.com")).toEqual({
      state: "unpaid", amountText: "€397.00", text: "€397.00 · not paid yet", payUrl: `https://app.example.com/pay/b/${PAYCODE}`, amount: "397.00", currency: "EUR", label: "Strategic call",
    })
    expect(payDtoOf({ pay_amount_cents: 39700, pay_currency: "EUR", pay_code: PAYCODE, pay_label: null, paid_session_id: null, not_charging_at: null, sent_at: "2026-11-15" })?.text).toBe("€397.00 · not paid yet · link sent")
    expect(payDtoOf({ pay_amount_cents: 39700, pay_currency: "EUR", pay_code: PAYCODE, pay_label: null, paid_session_id: "cs_1", not_charging_at: null, sent_at: null })?.text).toBe("€397.00 · paid")
    expect(payDtoOf({ pay_amount_cents: 39700, pay_currency: "EUR", pay_code: PAYCODE, pay_label: null, paid_session_id: null, not_charging_at: "2026-11-15", sent_at: null })?.text).toBe("€397.00 · not charging")
    expect(payDtoOf({ pay_amount_cents: null, pay_currency: null, pay_code: null, pay_label: null, paid_session_id: null, not_charging_at: null, sent_at: null })).toBeNull()
  })
  it("the list carries the price of a paid link and nothing on a free one", async () => {
    const db = withDeliveries(miniDb({ booking_links: [paidRow(), paidRow({ id: "f", public_id: "F".repeat(22), pay_amount_cents: null, pay_currency: null, pay_code: null, created_at: "2026-11-15T09:00:00.000Z" })], contacts: [], leads: [], account_contacts: [], accounts: [] }), [])
    const r = await listLinks(db, NOW, 100, "https://app.example.com")
    expect("links" in r).toBe(true)
    const links = "links" in r ? r.links : []
    expect(links).toHaveLength(2)
    expect(links.find((l) => l.id === LINK)?.pay).toMatchObject({ state: "unpaid", amountText: "€397.00" })
    expect(links.find((l) => l.id === "f")?.pay).toBeNull()
  })
})
