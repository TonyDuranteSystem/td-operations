/**
 * Paid booking links (dev job 74432428) — the fixes that came out of the council review (senior engineer, bug hunter, security, system counselor), each pinned.
 * In-memory database + fakes only: no network, no real money.
 */
import { describe, it, expect, vi, afterEach } from "vitest"
import { miniDb } from "./helpers/mini-db"
import { openPayment, findPayLink, type StripeOps } from "@/lib/booking/pay-session"
import { recordBookingLinkPayment, type BookingPaySession } from "@/lib/booking/pay-record"
import { stopCharging } from "@/lib/booking/pay-actions"
import { cardIsDue, decidePaidCard, loadPaidCalls, type PaidLinkRow } from "@/lib/booking/paid-calls"
import { listLinks, revokeLink } from "@/lib/booking/links"
import { makeLink, PAID_NOT_READY_TEXT } from "@/lib/booking/make-link"
import type { CalendlyCtx } from "@/lib/calendly/api"
import type { LinkBooking } from "@/lib/booking/link-bookings"

const C1 = "c0000000-0000-4000-8000-000000000001"
const C2 = "c0000000-0000-4000-8000-000000000002"
const LINK = "b0000000-0000-4000-8000-000000000001"
const TAG = "YajC1ZB9eYDY8WC8tnLnxA"
const PAYCODE = "2hhvDHUcAPqPBTXdD8HMqw"
const EV = "https://api.calendly.com/scheduled_events/dc95e826-9956-415e-bde1-247bfd074f57"
const NOW = new Date("2026-11-15T14:00:00.000Z")

const paidRow = (over: Partial<Record<string, unknown>> = {}) => ({
  id: LINK, public_id: TAG, kind_label: "Client", rule_snapshot: {}, contact_id: C1, account_id: null, lead_id: null, person_name: "Maria Rossi", person_language: "English",
  person_emails: ["maria@example.com"], claimed_event_uri: null, revoked_at: null, status: "open", once: true, open_count: 0, created_at: "2026-11-15T10:00:00.000Z", duration_minutes: 30,
  pay_amount_cents: 39700, pay_currency: "EUR", pay_label: "Strategic call", pay_mode: "revenue_only", pay_code: PAYCODE, stripe_session_id: null, session_expires_at: null,
  session_claim_at: null, sent_at: null, sent_count: 0, paid_session_id: null, paid_at: null, not_charging_at: null, ...over,
})

function stripe(over: Partial<{ readResult: unknown }> = {}) {
  const created: unknown[] = []
  const expired: string[] = []
  const ops: StripeOps = {
    create: (async (p: unknown) => { created.push(p); return { success: true, sessionId: "cs_live_new1", checkoutUrl: "https://checkout.stripe.com/c/pay/cs_live_new1", expiresAt: new Date("2026-11-16T13:00:00Z") } }) as StripeOps["create"],
    read: (async () => over.readResult ?? { ok: true, status: "expired", paymentStatus: "unpaid", url: null }) as StripeOps["read"],
    expire: (async (id: string) => { expired.push(id); return { ok: true } }) as StripeOps["expire"],
  }
  return { ops, created, expired }
}

/** Wraps a database so that an UPDATE of booking_links carrying `stripe_session_id` (the save after the card page is made) answers what the test says. */
function breakPostMintSave(db: ReturnType<typeof miniDb>, answer: { data: unknown; error: unknown }) {
  const real = db.from.bind(db)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a tiny test fake
  ;(db as any).from = (t: string) => {
    const b = real(t) as Record<string, (...a: unknown[]) => unknown>
    if (t !== "booking_links") return b
    const upd = b.update
    b.update = (p: unknown) => {
      if (typeof p === "object" && p && "stripe_session_id" in (p as object)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const stub: any = { eq: () => stub, is: () => stub, select: async () => answer }
        return stub
      }
      return upd(p)
    }
    return b
  }
  return db
}

afterEach(() => { vi.useRealTimers() })

describe("the card page: no second live page, ever", () => {
  it("Stripe says a page is open but gives no address: nothing new is made (a second page could be paid as well)", async () => {
    const s = stripe({ readResult: { ok: true, status: "open", paymentStatus: "unpaid", url: null } })
    const db = miniDb({ booking_links: [paidRow({ stripe_session_id: "cs_live_old" })], contacts: [{ id: C1, email: "maria@example.com" }] })
    expect(await openPayment({ db, now: NOW, stripe: s.ops }, PAYCODE)).toMatchObject({ ok: false, reason: "stripe" })
    expect(s.created).toHaveLength(0)
  })
  it("if the new card page cannot be saved on the link, it is CLOSED at once and the person is told to try again (no unknown payable page is left behind)", async () => {
    const s = stripe()
    const db = breakPostMintSave(miniDb({ booking_links: [paidRow()], contacts: [{ id: C1, email: "maria@example.com" }] }), { data: null, error: { message: "db blip" } })
    expect(await openPayment({ db, now: NOW, stripe: s.ops }, PAYCODE)).toMatchObject({ ok: false, reason: "error" })
    expect(s.created).toHaveLength(1)
    expect(s.expired).toEqual(["cs_live_new1"])
  })
  it("if 'Not charging' (or a newer click) got there first, the save finds nothing to update and the new card page is closed", async () => {
    const s = stripe()
    const db = breakPostMintSave(miniDb({ booking_links: [paidRow()], contacts: [{ id: C1, email: "maria@example.com" }] }), { data: [], error: null })
    expect(await openPayment({ db, now: NOW, stripe: s.ops }, PAYCODE)).toMatchObject({ ok: false, reason: "error" })
    expect(s.expired).toEqual(["cs_live_new1"])
  })
  it("the save is tied to OUR lease: a normal save still works and clears the lease", async () => {
    const s = stripe()
    const db = miniDb({ booking_links: [paidRow()], contacts: [{ id: C1, email: "maria@example.com" }] })
    expect(await openPayment({ db, now: NOW, stripe: s.ops }, PAYCODE)).toEqual({ ok: true, url: "https://checkout.stripe.com/c/pay/cs_live_new1" })
    expect(db.tables.booking_links[0]).toMatchObject({ stripe_session_id: "cs_live_new1", session_claim_at: null })
    expect(s.expired).toEqual([])
  })
})

describe("deploy order: the code can be live before the migration", () => {
  const withoutColumns = (db: ReturnType<typeof miniDb>) => {
    const real = db.from.bind(db)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a tiny test fake
    ;(db as any).from = (t: string) => {
      if (t !== "booking_links") return real(t)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const q: any = {}
      const fail = { data: null, error: { code: "42703", message: 'column "pay_code" does not exist' } }
      for (const m of ["select", "eq", "is", "not", "in", "order", "limit", "or", "update"]) q[m] = (...a: unknown[]) => {
        if (m === "select" && typeof a[0] === "string" && !/pay_|sent_|paid_|not_charging|stripe_session|session_/.test(a[0] as string)) return real(t).select(...a)
        return q
      }
      q.maybeSingle = async () => fail
      q.then = (res: (v: unknown) => unknown) => res(fail)
      return q
    }
    return db
  }
  it("the payment page treats a database without the columns as 'no such link'", async () => {
    expect((await findPayLink(withoutColumns(miniDb({ booking_links: [paidRow()] })), PAYCODE)).state).toBe("none")
  })
  it("the unpaid-call cards read as 'none' (not an error) on a database without the columns", async () => {
    expect(await loadPaidCalls(withoutColumns(miniDb({ booking_links: [paidRow()] })), NOW)).toEqual({ ok: true, cards: [] })
  })
  it("Links I made falls back to the old columns, so the page keeps working (every link reads as free)", async () => {
    // a database without the columns holds rows without them
    const oldRow = Object.fromEntries(Object.entries(paidRow()).filter(([k]) => !/^(pay_|sent_|paid_|not_charging|stripe_session|session_)/.test(k)))
    const r = await listLinks(withoutColumns(miniDb({ booking_links: [oldRow], contacts: [], leads: [], account_contacts: [], accounts: [] })), NOW)
    expect("links" in r && r.links).toHaveLength(1)
    expect("links" in r && r.links[0].pay).toBeNull()
  })
  it("making a PAID link on such a database is refused BEFORE Calendly is asked for a link (no orphan one-time link)", async () => {
    const real = miniDb({
      catalog_entries: [{ id: "k1", catalog_id: "booking_kinds", slug: "client", display_name: "Client", status: "active", metadata: { existing_person: "attach", new_person: "lead", mark_lead: false, sales_template: false, sort_order: 20 } }],
      contacts: [{ id: C1, full_name: "Maria Rossi", email: "maria@example.com", email_2: null, alt_emails: [], language: "English", portal_tier: "active", merged_into: null, created_at: "2026-01-01" }],
      account_contacts: [], accounts: [], service_deliveries: [], leads: [],
      app_settings: [{ key: "booking_templates", value: { plain: { event_type_uri: "https://api.calendly.com/event_types/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", scheduling_url: "https://calendly.com/x/new-meeting" }, sales: { event_type_uri: "https://api.calendly.com/event_types/bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee", scheduling_url: "https://calendly.com/x/free" } } }],
      booking_links: [],
    })
    const asked: string[] = []
    const ctx: CalendlyCtx = { token: "t", http: async (req) => { asked.push(req.url); return { status: 201, json: async () => ({}) } } }
    const probeFails = real.from.bind(real)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a tiny test fake
    ;(real as any).from = (t: string) => {
      const b = probeFails(t) as Record<string, (...a: unknown[]) => unknown>
      if (t !== "booking_links") return b
      const sel = b.select
      b.select = (...a: unknown[]) => {
        if (a[0] === "pay_code") {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const q: any = { limit: () => q, then: (res: (v: unknown) => unknown) => res({ data: null, error: { code: "42703", message: "no such column" } }) }
          return q
        }
        return sel(...a)
      }
      return b
    }
    const r = await makeLink({ db: real, calendly: ctx, createdBy: "a" }, { person: { type: "contact", id: C1 }, kindSlug: "client", minutes: 30, payment: { amount: "100", currency: "USD" } })
    expect(r).toEqual({ ok: false, errors: [PAID_NOT_READY_TEXT] })
    expect(asked).toEqual([])
  })
})

describe("money that arrives in an unexpected state is recorded AND reported", () => {
  const session = (over: Partial<BookingPaySession> = {}): BookingPaySession => ({
    id: "cs_live_a", payment_intent: "pi_1", amount_total: 39700, currency: "eur", customer_details: { email: "payer@card.example", name: "Someone Else" },
    metadata: { payment_kind: "paid_call", booking_link_id: LINK, client_email: "maria@example.com", client_name: "Maria Rossi" }, ...over,
  })
  const harness = (rows: Record<string, unknown>[], settleResult: Record<string, unknown> = { ok: true, contactId: C1 }, opts: { failMark?: boolean } = {}) => {
    const db = miniDb({ booking_links: rows, contacts: [{ id: C1, email: "maria@example.com" }] }, opts.failMark ? { failOps: { "booking_links:update": "boom" } } : {})
    const errors: string[] = []
    const settle = vi.fn(async () => settleResult)
    return { db, settle, errors, deps: { db, now: NOW, settle: settle as never, reportError: async (m: string) => { errors.push(m) } } }
  }
  it("a payment for a link marked 'Not charging' or stopped is recorded as paid and reported (refund it if it should not have been taken)", async () => {
    for (const over of [{ not_charging_at: "2026-11-15T10:00:00Z" }, { revoked_at: "2026-11-15T10:00:00Z" }]) {
      const h = harness([paidRow(over)])
      await recordBookingLinkPayment(session(), h.deps)
      expect(h.settle).toHaveBeenCalledTimes(1)
      expect(h.errors.join(" ")).toMatch(/Not charging|stopped/)
      expect(h.errors.join(" ")).toMatch(/refund/i)
    }
    const quiet = harness([paidRow()])
    await recordBookingLinkPayment(session(), quiet.deps)
    expect(quiet.errors).toEqual([])
  })
  it("a payment recorded on a DIFFERENT contact than the link's (a shared email) is reported with both ids; the same contact is not", async () => {
    const wrong = harness([paidRow()], { ok: true, contactId: C2 })
    await recordBookingLinkPayment(session(), wrong.deps)
    expect(wrong.errors.join(" ")).toMatch(/DIFFERENT contact/)
    expect(wrong.errors.join(" ")).toContain(C1)
    expect(wrong.errors.join(" ")).toContain(C2)
    const right = harness([paidRow()], { ok: true, contactId: C1 })
    await recordBookingLinkPayment(session(), right.deps)
    expect(right.errors).toEqual([])
    const noContact = harness([paidRow({ contact_id: null, lead_id: "10000000-0000-4000-8000-000000000001" })], { ok: true, contactId: C2 })
    await recordBookingLinkPayment(session(), noContact.deps)
    expect(noContact.errors).toEqual([]) // a link made for a lead has no contact to compare with
  })
  it("settle works but the link cannot be marked paid: it THROWS (Stripe sends it again), and the redelivery then completes without recording twice", async () => {
    const h = harness([paidRow()], { ok: true, contactId: C1 }, { failMark: true })
    await expect(recordBookingLinkPayment(session(), h.deps)).rejects.toThrow(/could not be marked paid/)
    expect(h.db.tables.booking_links[0].paid_session_id).toBeNull()
    // Stripe's redelivery: the marking works this time; the recorder (idempotent on the session) is asked again
    const again = harness([paidRow()])
    expect(await recordBookingLinkPayment(session(), again.deps)).toEqual({ handled: true })
    expect(again.db.tables.booking_links[0].paid_session_id).toBe("cs_live_a")
  })
})

describe("the cards", () => {
  const booking = (over: Partial<LinkBooking> = {}): LinkBooking => ({ state: "booked", eventUri: EV, startTime: "2026-11-17T15:00:00Z", count: 1, ...over })
  const row = (over: Partial<PaidLinkRow> = {}) => paidRow(over) as unknown as PaidLinkRow
  it("a link sent when the call time is unknown comes back a day later (an unpaid call never vanishes for good)", () => {
    expect(cardIsDue("2026-11-15T13:00:00Z", null, new Date("2026-11-15T14:00:00Z"))).toBe(false)
    expect(cardIsDue("2026-11-15T13:00:00Z", null, new Date("2026-11-16T13:00:00Z"))).toBe(true)
  })
  it("a call that is already past says so instead of 'the call is close'", () => {
    const c = decidePaidCard({ row: row({ sent_at: "2026-11-10T13:00:00Z", sent_count: 1 }), booking: booking({ startTime: "2026-11-12T15:00:00Z" }), stored: [], copyOnly: false, now: NOW })
    expect(c?.note).toMatch(/the call has passed/)
    expect(c?.note).not.toMatch(/close/)
  })
})

describe("stopping a paid link also stops charging", () => {
  it("'Stop link' on a paid link marks it not charging (a card page the person already opened is closed too)", async () => {
    const db = miniDb({ booking_links: [paidRow()] })
    expect(await revokeLink(db, LINK, NOW)).toMatchObject({ ok: true })
    expect(db.tables.booking_links[0]).toMatchObject({ revoked_at: NOW.toISOString(), not_charging_at: NOW.toISOString() })
  })
  it("'Stop link' on a FREE link changes nothing else", async () => {
    const db = miniDb({ booking_links: [paidRow({ pay_amount_cents: null, pay_currency: null, pay_code: null })] })
    expect(await revokeLink(db, LINK, NOW)).toMatchObject({ ok: true })
    expect(db.tables.booking_links[0].not_charging_at).toBeNull()
  })
  it("a hung Stripe call never hangs 'Not charging': after 8 seconds it still answers, saying the card page could not be closed", async () => {
    vi.useFakeTimers()
    const db = miniDb({ booking_links: [paidRow({ stripe_session_id: "cs_live_old" })] })
    const p = stopCharging(db, LINK, NOW, { expire: () => new Promise(() => undefined) })
    await vi.advanceTimersByTimeAsync(8_001)
    const r = await p
    expect(r).toMatchObject({ ok: true })
    expect("message" in r && r.message).toMatch(/could not be closed in Stripe/)
    expect(db.tables.booking_links[0].not_charging_at).toBe(NOW.toISOString())
  })
})
