/**
 * "Links I made": true status (booked / cancelled), Cancel the call, the hover card on the name, and the booker's questions (dev job a9285887, Antonio 15 Nov 2026).
 * The shapes in here are the REAL ones read from Calendly and from the stored deliveries on 15 Nov 2026 (a booking cancelled by the host; two bookings carrying a link id).
 */
import { describe, it, expect } from "vitest"
import { CalendlyError, getEventType, getScheduledEvent, questionsOf, type CalendlyCtx, type CalendlyHttpRequest } from "@/lib/calendly/api"
import { bookingText, bookingUrisOf, canCancelBooking, decideBooking, loadStoredBookings, lookupEvents, type EventFacts, type StoredBooking } from "@/lib/booking/link-bookings"
import { listLinks } from "@/lib/booking/links"
import { cancelLinkCall, CANCEL_REASON } from "@/lib/booking/cancel-call"
import { leadCard, linkOnlyCard, loadLinkCards } from "@/lib/booking/link-cards"
import { decideLinkPlan, parseQuestionsChoice } from "@/lib/booking/plan"
import { loadCallQuestions } from "@/lib/booking/questions"

const TAG_A = "YajC1ZB9eYDY8WC8tnLnxA"
const TAG_B = "2hhvDHUcAPqPBTXdD8HMqw"
const EV_A = "https://api.calendly.com/scheduled_events/dc95e826-9956-415e-bde1-247bfd074f57"
const EV_B = "https://api.calendly.com/scheduled_events/4d2c762a-1ee6-4ed3-9822-0aca2c7d47b7"
const CANCEL_URL = "https://calendly.com/cancellations/d54ebc28-b546-4fa7-af81-960a75719c43"
const NOW = new Date("2026-11-15T14:00:00Z")

// ── fakes ──────────────────────────────────────────────────────────────────────────────

/** A chainable fake of the few database calls these modules make. `rows` per table; a table can be made to fail. */
function fakeDb(tables: Record<string, unknown[]>, failing: string[] = []) {
  const log: string[] = []
  return {
    log,
    from(table: string) {
      log.push(table)
      const result = failing.includes(table) ? { data: null, error: { message: "boom" } } : { data: tables[table] ?? [], error: null }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a tiny test fake
      const q: any = {
        select: () => q,
        eq: () => q,
        in: () => q,
        order: () => q,
        limit: () => q,
        maybeSingle: async () => (failing.includes(table) ? { data: null, error: { message: "boom" } } : { data: (tables[table] ?? [])[0] ?? null, error: null }),
        then: (resolve: (v: unknown) => unknown) => resolve(result),
      }
      return q
    },
  }
}

type Answer = { status: number; body?: unknown } | Error
/** A fake Calendly client answering from a queue (or by URL) and remembering what was asked. */
function calendly(answer: (req: CalendlyHttpRequest) => Answer): { ctx: CalendlyCtx; calls: CalendlyHttpRequest[] } {
  const calls: CalendlyHttpRequest[] = []
  const ctx: CalendlyCtx = {
    token: "secret-token",
    http: async (req) => {
      calls.push(req)
      const a = answer(req)
      if (a instanceof Error) throw a
      return { status: a.status, json: async () => a.body }
    },
  }
  return { ctx, calls }
}

const eventBody = (uri: string, over: Record<string, unknown> = {}) => ({ resource: { uri, status: "active", start_time: "2026-11-16T14:30:00Z", end_time: "2026-11-16T15:00:00Z", name: "New Meeting", ...over } })
const cancelledByHost = { cancellation: { canceled_by: "Antonio Durante", reason: "", canceler_type: "host", created_at: "2026-11-15T12:56:47Z" } }

const stored = (over: Partial<StoredBooking> = {}): StoredBooking => ({ tag: TAG_A, eventUri: EV_A, startTime: "2026-11-16T14:30:00.000000Z", storedAt: "2026-11-15T12:54:30Z", cancelUrl: CANCEL_URL, ...over })

const linkRow = (over: Record<string, unknown> = {}) => ({
  id: "b0000000-0000-4000-8000-000000000001", public_id: TAG_A, kind_label: "Private", rule_snapshot: {}, contact_id: null, lead_id: null, person_name: null, person_emails: [],
  duration_minutes: 30, once: true, status: "open", revoked_at: null, expires_at: null, claimed_event_uri: null, claimed_at: null, open_count: 1, last_opened_at: null,
  created_at: "2026-11-15T12:53:58Z", template_slug: "plain", ...over,
})
const deliveryRow = (tag: string, eventUri: string, over: Record<string, unknown> = {}) => ({ storedAt: "2026-11-15T12:54:30Z", tag, eventUri, startTime: "2026-11-16T14:30:00.000000Z", cancelUrl: CANCEL_URL, ...over })

// ── Calendly reads ─────────────────────────────────────────────────────────────────────

describe("Calendly reads: who cancelled, and the questions", () => {
  it("getScheduledEvent reports who cancelled (the real shape of a host cancellation)", async () => {
    const { ctx } = calendly(() => ({ status: 200, body: eventBody(EV_A, { status: "canceled", ...cancelledByHost }) }))
    expect(await getScheduledEvent(ctx, EV_A)).toMatchObject({ status: "canceled", cancelerType: "host", startTime: "2026-11-16T14:30:00Z" })
  })
  it("an active event has no canceler", async () => {
    const { ctx } = calendly(() => ({ status: 200, body: eventBody(EV_A, { cancellation: null }) }))
    expect(await getScheduledEvent(ctx, EV_A)).toMatchObject({ status: "active", cancelerType: null })
  })
  it("questionsOf keeps the enabled ones, in Calendly's order, with the required flag (the real shape of the two call types)", () => {
    expect(
      questionsOf([
        { name: "Language", type: "multi_select", position: 3, enabled: true, required: true },
        { name: "What is the main reason for booking this call?\n\nQual è il motivo…", type: "text", position: 0, enabled: true, required: true },
        { name: "Hidden one", position: 1, enabled: false, required: true },
        { name: "  Please share anything that will help prepare.  ", position: 2, enabled: true, required: false },
        { name: "", position: 4, enabled: true },
        "junk",
      ]),
    ).toEqual([
      { text: "What is the main reason for booking this call?\n\nQual è il motivo…", required: true },
      { text: "Please share anything that will help prepare.", required: false },
      { text: "Language", required: true },
    ])
    expect(questionsOf(undefined)).toEqual([])
    expect(questionsOf({})).toEqual([])
  })
  it("getEventType returns the questions", async () => {
    const { ctx } = calendly(() => ({ status: 200, body: { resource: { uri: "https://api.calendly.com/event_types/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", name: "New Meeting", active: true, duration: 30, custom_questions: [{ name: "Anything to prepare?", position: 0, enabled: true, required: false }] } } }))
    expect((await getEventType(ctx, "https://api.calendly.com/event_types/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")).questions).toEqual([{ text: "Anything to prepare?", required: false }])
  })
})

// ── the booking and its state ──────────────────────────────────────────────────────────

describe("what happened to a link's booking", () => {
  const active: EventFacts = { status: "active", startTime: "2026-11-16T14:30:00Z", cancelerType: null }
  const facts = (f: EventFacts | null, uri = EV_A) => new Map<string, EventFacts | null>([[uri, f]])

  it("no booking at all → null (the row keeps its old words)", () => {
    expect(decideBooking({ uris: [], stored: [], facts: new Map() })).toBeNull()
  })
  it("an active booking is booked, and can be cancelled", () => {
    const b = decideBooking({ uris: [EV_A], stored: [stored()], facts: facts(active) })
    expect(b).toMatchObject({ state: "booked", eventUri: EV_A, startTime: "2026-11-16T14:30:00Z", count: 1 })
    expect(canCancelBooking(b!.state)).toBe(true)
  })
  it("cancelled by the host = by you; by the invitee = by the booker; unsaid = plain cancelled — none can be cancelled again", () => {
    for (const [by, state] of [["host", "cancelled_by_you"], ["invitee", "cancelled_by_booker"], [null, "cancelled"]] as const) {
      const b = decideBooking({ uris: [EV_A], stored: [stored()], facts: facts({ status: "canceled", startTime: null, cancelerType: by }) })
      expect(b?.state).toBe(state)
      expect(canCancelBooking(b!.state)).toBe(false)
      expect(b?.startTime).toBe("2026-11-16T14:30:00.000000Z") // falls back to the stored start
    }
  })
  it("Calendly could not be read → booked but unchecked (never 'still waiting', never hidden, and it can still be cancelled)", () => {
    for (const f of [null, undefined]) {
      const b = decideBooking({ uris: [EV_A], stored: [stored()], facts: f === null ? facts(null) : new Map() })
      expect(b?.state).toBe("booked_unchecked")
      expect(canCancelBooking(b!.state)).toBe(true)
    }
  })
  it("an unknown status word is kept as a booking we could not fully read", () => {
    expect(decideBooking({ uris: [EV_A], stored: [stored()], facts: facts({ status: "weird", startTime: null, cancelerType: null }) })?.state).toBe("booked_unchecked")
  })
  it("a reusable link with several bookings describes the latest and counts them", () => {
    const uris = [EV_A, EV_B]
    const b = decideBooking({ uris, stored: [stored(), stored({ eventUri: EV_B })], facts: facts(active) })
    expect(b).toMatchObject({ eventUri: EV_A, count: 2 })
    expect(bookingText(b!, "Mon, Nov 16, 9:30 AM ET")).toBe("Booked Mon, Nov 16, 9:30 AM ET · 2 bookings in all")
  })
  it("the words", () => {
    const w = "Mon, Nov 16, 9:30 AM ET"
    expect(bookingText({ state: "booked", count: 1 }, w)).toBe(`Booked ${w}`)
    expect(bookingText({ state: "booked_unchecked", count: 1 }, w)).toBe(`Booked ${w} · could not check Calendly`)
    expect(bookingText({ state: "cancelled_by_you", count: 1 }, w)).toBe(`Cancelled by you · was ${w}`)
    expect(bookingText({ state: "cancelled_by_booker", count: 1 }, w)).toBe(`Cancelled by the booker · was ${w}`)
    expect(bookingText({ state: "cancelled", count: 1 }, null)).toBe("Cancelled")
    expect(bookingText({ state: "booked", count: 1 }, null)).toBe("Booked")
  })
  it("bookingUrisOf: newest first, no repeats, and a claimed link's own booking counts even with no stored delivery", () => {
    expect(bookingUrisOf([stored({ eventUri: EV_A }), stored({ eventUri: EV_B }), stored({ eventUri: EV_A })], null)).toEqual([EV_A, EV_B])
    expect(bookingUrisOf([], EV_B)).toEqual([EV_B])
    expect(bookingUrisOf([stored()], EV_A)).toEqual([EV_A])
    expect(bookingUrisOf([], "https://evil.example/x")).toEqual([])
  })
})

describe("reading the stored bookings", () => {
  it("groups the stored deliveries by the link's id, and only asks about ids of our exact shape", async () => {
    const db = fakeDb({ webhook_events: [deliveryRow(TAG_A, EV_A), deliveryRow(TAG_B, EV_B)] })
    const r = await loadStoredBookings(db, [TAG_A, TAG_B, "not-an-id", "'; drop table x; --"])
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.byTag.get(TAG_A)).toEqual([expect.objectContaining({ eventUri: EV_A, startTime: "2026-11-16T14:30:00.000000Z", cancelUrl: CANCEL_URL })])
      expect(r.byTag.get(TAG_B)?.[0].eventUri).toBe(EV_B)
    }
  })
  it("nothing to look up → no database call at all", async () => {
    const db = fakeDb({})
    expect(await loadStoredBookings(db, ["nope"])).toMatchObject({ ok: true })
    expect(db.log).toEqual([])
  })
  it("a row with a bad event address or no tag is skipped; a failed read says so (it is not 'no bookings')", async () => {
    const db = fakeDb({ webhook_events: [deliveryRow(TAG_A, "https://evil.example/scheduled_events/x"), deliveryRow("", EV_A), deliveryRow(TAG_A, EV_A)] })
    const r = await loadStoredBookings(db, [TAG_A])
    expect(r.ok && r.byTag.get(TAG_A)?.length).toBe(1)
    expect(await loadStoredBookings(fakeDb({}, ["webhook_events"]), [TAG_A])).toEqual({ ok: false })
  })
})

describe("asking Calendly about the bookings", () => {
  it("reads each booking once and keeps what Calendly said; one that fails is null (never throws)", async () => {
    const { ctx, calls } = calendly((req) => (req.url.includes("dc95e826") ? { status: 200, body: eventBody(EV_A, { status: "canceled", ...cancelledByHost }) } : { status: 403 }))
    const m = await lookupEvents(ctx, [EV_A, EV_B, EV_A])
    expect(m.get(EV_A)).toEqual({ status: "canceled", startTime: "2026-11-16T14:30:00Z", cancelerType: "host" })
    expect(m.get(EV_B)).toBeNull()
    expect(calls.length).toBe(2)
  })
  it("no key = every booking unchecked", async () => {
    const m = await lookupEvents({ http: async () => { throw new Error("must not be called") }, token: null }, [EV_A])
    expect(m.get(EV_A)).toBeNull()
  })
  it("asks about at most 25 bookings", async () => {
    const uris = Array.from({ length: 40 }, (_, i) => `https://api.calendly.com/scheduled_events/00000000-0000-4000-8000-${String(i).padStart(12, "0")}`)
    const { ctx, calls } = calendly((req) => ({ status: 200, body: eventBody(req.url) }))
    const m = await lookupEvents(ctx, uris)
    expect(calls.length).toBe(25)
    expect(m.size).toBe(25)
  })
})

describe("Links I made: the list tells the truth about the bookings", () => {
  // the two real rows of 15 Nov: both made, both booked, both cancelled, both still 'open' in our table (the switch is on "page")
  const rows = [linkRow({ id: "b0000000-0000-4000-8000-000000000001", public_id: TAG_A }), linkRow({ id: "b0000000-0000-4000-8000-000000000002", public_id: TAG_B, kind_label: "Lead", person_name: "Uxio Lead Test", person_emails: ["x@example.com"] })]
  const deliveries = [deliveryRow(TAG_A, EV_A), deliveryRow(TAG_B, EV_B)]

  it("both real bookings were cancelled by the host: both rows say so instead of 'Waiting'", async () => {
    const { ctx } = calendly((req) => ({ status: 200, body: eventBody(req.url.replace("https://api.calendly.com", "https://api.calendly.com"), { status: "canceled", ...cancelledByHost }) }))
    const r = await listLinks(fakeDb({ booking_links: rows, webhook_events: deliveries }), NOW, 100, undefined, ctx)
    expect(r.ok).toBe(true)
    if (r.ok) {
      for (const l of r.links) {
        expect(l.what).toMatch(/^Cancelled by you · was /)
        expect(l.what).not.toMatch(/Waiting/)
        expect(l.booking).toMatchObject({ state: "cancelled_by_you", canCancel: false })
      }
      expect(r.links[0].asks).toBe("short")
    }
  })
  it("a live booking shows Booked with the date and offers Cancel the call", async () => {
    const { ctx } = calendly((req) => ({ status: 200, body: eventBody(req.url) }))
    const r = await listLinks(fakeDb({ booking_links: [rows[0]], webhook_events: [deliveries[0]] }), NOW, 100, undefined, ctx)
    if (!r.ok) throw new Error("list failed")
    expect(r.links[0].what).toBe("Booked Mon, Nov 16, 9:30 AM ET")
    expect(r.links[0].booking).toMatchObject({ state: "booked", canCancel: true, count: 1 })
  })
  it("without a Calendly client the booking is still shown (unchecked), never 'Waiting'", async () => {
    const r = await listLinks(fakeDb({ booking_links: [rows[0]], webhook_events: [deliveries[0]] }), NOW)
    if (!r.ok) throw new Error("list failed")
    expect(r.links[0].what).toBe("Booked Mon, Nov 16, 9:30 AM ET · could not check Calendly")
  })
  it("a link nobody booked with keeps its old words", async () => {
    const r = await listLinks(fakeDb({ booking_links: [rows[0]], webhook_events: [] }), NOW)
    if (!r.ok) throw new Error("list failed")
    expect(r.links[0].what).toBe("Waiting, not booked yet · opened 1 time")
    expect(r.links[0].booking).toBeNull()
  })
  it("a failed read of the stored bookings never hides a link", async () => {
    const r = await listLinks(fakeDb({ booking_links: rows }, ["webhook_events"]), NOW)
    expect(r.ok && r.links.length).toBe(2)
  })
  it("never puts the booker's cancel address in the list", async () => {
    const r = await listLinks(fakeDb({ booking_links: [rows[0]], webhook_events: [deliveries[0]] }), NOW)
    expect(JSON.stringify(r)).not.toContain("cancellations")
  })
})

// ── Cancel the call ────────────────────────────────────────────────────────────────────

describe("Cancel the call", () => {
  const ID = "b0000000-0000-4000-8000-000000000001"
  const db = (over: { link?: Record<string, unknown> | null; deliveries?: unknown[] } = {}) =>
    fakeDb({ booking_links: over.link === null ? [] : [{ public_id: TAG_A, claimed_event_uri: null, ...over.link }], webhook_events: over.deliveries ?? [deliveryRow(TAG_A, EV_A)] })

  it("cancels the booking made through the link, with fixed text as the reason", async () => {
    const { ctx, calls } = calendly(() => ({ status: 201, body: {} }))
    expect(await cancelLinkCall({ db: db(), calendly: ctx }, ID)).toEqual({ ok: true, message: "The call is cancelled. Calendly is telling the booker." })
    expect(calls.length).toBe(1)
    expect(calls[0].method).toBe("POST")
    expect(calls[0].url).toBe(`${EV_A}/cancellation`)
    expect(JSON.parse(calls[0].body as string)).toEqual({ reason: CANCEL_REASON })
  })
  it("already cancelled counts as success (a double click, or cancelled in Calendly a moment ago)", async () => {
    const { ctx } = calendly((req) => (req.method === "POST" ? { status: 400 } : { status: 200, body: eventBody(EV_A, { status: "canceled", ...cancelledByHost }) }))
    expect(await cancelLinkCall({ db: db(), calendly: ctx }, ID)).toEqual({ ok: true, message: "That call was already cancelled." })
  })
  it("a link nobody booked with has nothing to cancel, and Calendly is never called", async () => {
    const { ctx, calls } = calendly(() => ({ status: 201, body: {} }))
    expect(await cancelLinkCall({ db: db({ deliveries: [] }), calendly: ctx }, ID)).toMatchObject({ ok: false, status: 409 })
    expect(calls.length).toBe(0)
  })
  it("a claimed link's own booking can be cancelled even with no stored delivery", async () => {
    const { ctx, calls } = calendly(() => ({ status: 201, body: {} }))
    expect(await cancelLinkCall({ db: db({ link: { claimed_event_uri: EV_B }, deliveries: [] }), calendly: ctx }, ID)).toMatchObject({ ok: true })
    expect(calls[0].url).toBe(`${EV_B}/cancellation`)
  })
  it("when Calendly will not let the app cancel, NOTHING is cancelled and the booker's own cancel page is offered", async () => {
    for (const status of [401, 403]) {
      const { ctx } = calendly(() => ({ status }))
      const r = await cancelLinkCall({ db: db(), calendly: ctx }, ID)
      expect(r).toMatchObject({ ok: false, status: 502, cancelUrl: CANCEL_URL })
      expect(r.ok === false && r.error).toBe("Calendly did not allow the app to cancel this call. Nothing was cancelled.")
    }
  })
  it("no key on this server: refused in plain words, with the same fallback", async () => {
    const r = await cancelLinkCall({ db: db(), calendly: { http: async () => { throw new Error("no") }, token: null } }, ID)
    expect(r).toMatchObject({ ok: false, cancelUrl: CANCEL_URL })
    expect(r.ok === false && r.error).toMatch(/not connected/)
  })
  it("a busy or unreachable Calendly does not offer the hand-cancel page (just try again)", async () => {
    for (const a of [{ status: 429 }, { status: 503 }, new Error("down")] as const) {
      const { ctx } = calendly(() => a)
      const r = await cancelLinkCall({ db: db(), calendly: ctx }, ID)
      expect(r.ok).toBe(false)
      expect(r.ok === false && r.cancelUrl).toBeUndefined()
    }
  })
  it("the hand-cancel page is only ever a calendly.com address", async () => {
    const { ctx } = calendly(() => ({ status: 403 }))
    const r = await cancelLinkCall({ db: db({ deliveries: [deliveryRow(TAG_A, EV_A, { cancelUrl: "https://evil.example/cancel" })] }), calendly: ctx }, ID)
    expect(r.ok === false && r.cancelUrl).toBeUndefined()
  })
  it("bad id → 404, unknown link → 404, a failed read → 500 (never 'cancelled')", async () => {
    const { ctx, calls } = calendly(() => ({ status: 201, body: {} }))
    expect(await cancelLinkCall({ db: db(), calendly: ctx }, "not-an-id")).toMatchObject({ ok: false, status: 404 })
    expect(await cancelLinkCall({ db: db({ link: null }), calendly: ctx }, ID)).toMatchObject({ ok: false, status: 404 })
    expect(await cancelLinkCall({ db: fakeDb({}, ["booking_links"]), calendly: ctx }, ID)).toMatchObject({ ok: false, status: 500 })
    expect(await cancelLinkCall({ db: fakeDb({ booking_links: [{ public_id: TAG_A, claimed_event_uri: null }] }, ["webhook_events"]), calendly: ctx }, ID)).toMatchObject({ ok: false, status: 500 })
    expect(calls.length).toBe(0)
  })
  it("CalendlyError is what the refusals are made of (a plain Error still gets plain words)", async () => {
    expect(new CalendlyError("forbidden", 403, "x").kind).toBe("forbidden")
  })
})

// ── the card on the name ───────────────────────────────────────────────────────────────

describe("the hover card on the name", () => {
  const C1 = "c0000000-0000-4000-8000-000000000001"
  const L1 = "d0000000-0000-4000-8000-000000000001"
  it("a contact gets the SAME card as the Contacts list: email, phone, language, stage, companies — and nothing sensitive is even read", async () => {
    const db = fakeDb({
      contacts: [{ id: C1, full_name: "Maria Rossi", email: "maria@example.com", phone: "+39 333 1", language: "Italian", portal_tier: "active" }],
      leads: [],
      account_contacts: [{ contact_id: C1, account: { company_name: "Rossi LLC", status: "Active" } }],
    })
    const cards = await loadLinkCards(db, [{ id: "r1", contact_id: C1, lead_id: null, person_name: "Maria Rossi", person_emails: ["maria@example.com"] }])
    expect(cards.get("r1")).toEqual({
      title: "Maria Rossi",
      subtitle: "Portal stage: active",
      lines: [{ label: "Email", value: "maria@example.com" }, { label: "Phone", value: "+39 333 1" }, { label: "Language", value: "Italian" }],
      items: { heading: "Company", entries: ["Rossi LLC · Active"] },
    })
    expect(JSON.stringify(cards.get("r1"))).not.toMatch(/itin|passport|ein|birth/i)
  })
  it("a lead gets a small card from the lead's own record", async () => {
    const db = fakeDb({ contacts: [], leads: [{ id: L1, full_name: "Gino Bianchi", email: "g@example.com", phone: null, language: "Italian", status: "Call Done" }], account_contacts: [] })
    const cards = await loadLinkCards(db, [{ id: "r2", contact_id: null, lead_id: L1, person_name: "Gino", person_emails: [] }])
    expect(cards.get("r2")).toEqual({ title: "Gino Bianchi", subtitle: "Lead · Call Done", lines: [{ label: "Email", value: "g@example.com" }, { label: "Language", value: "Italian" }] })
  })
  it("someone new with a name or email gets what the link knows; with neither there is no card", async () => {
    expect(linkOnlyCard({ person_name: "Anna", person_emails: ["a@example.com"] })).toEqual({ title: "Anna", subtitle: "Not in the system yet", lines: [{ label: "Email", value: "a@example.com" }] })
    expect(linkOnlyCard({ person_name: null, person_emails: ["a@example.com"] })?.title).toBe("a@example.com")
    expect(linkOnlyCard({ person_name: "  ", person_emails: [] })).toBeNull()
    expect(linkOnlyCard({ person_name: null, person_emails: null })).toBeNull()
  })
  it("a failed read falls back to what the link knows; it never throws and never loses a row", async () => {
    const cards = await loadLinkCards(fakeDb({}, ["contacts", "leads", "account_contacts"]), [{ id: "r3", contact_id: C1, lead_id: null, person_name: "Maria Rossi", person_emails: [] }])
    expect(cards.get("r3")).toMatchObject({ title: "Maria Rossi", subtitle: "Not in the system yet" })
    const boom = { from: () => { throw new Error("db down") } }
    expect((await loadLinkCards(boom, [{ id: "r4", contact_id: null, lead_id: null, person_name: "Z", person_emails: [] }])).get("r4")).toMatchObject({ title: "Z" })
  })
  it("a lead card with no status or contact details is still a card", () => {
    expect(leadCard({ id: "x", full_name: null, email: null, phone: null, language: null, status: null })).toEqual({ title: "Lead", subtitle: "Lead", lines: [] })
  })
})

// ── the questions ──────────────────────────────────────────────────────────────────────

describe("what the booker is asked", () => {
  const rule = { existing_person: "attach", new_person: "lead", mark_lead: true, sales_template: true }
  const input = (over: Record<string, unknown> = {}) => ({ person: { state: "new" as const }, kind: { slug: "lead", label: "Lead", metadata: rule }, minutes: 30, ...over })

  it("parseQuestionsChoice: only 'full' and 'short' change anything", () => {
    expect(parseQuestionsChoice("full")).toBe("full")
    expect(parseQuestionsChoice("short")).toBe("short")
    for (const v of ["auto", "", "FULL", null, undefined, 1, {}, "sales"]) expect(parseQuestionsChoice(v)).toBe("auto")
  })
  it("auto is exactly the old rule: the full questions only for a NEW person on a Lead-style kind", () => {
    const a = decideLinkPlan(input())
    expect(a.ok && a.plan.template).toBe("sales")
    const c = decideLinkPlan(input({ person: { state: "contact", established: true } }))
    expect(c.ok && c.plan.template).toBe("plain")
  })
  it("the person can choose the full questions or just the short note, whoever books; the rule's own answer is kept beside it", () => {
    const full = decideLinkPlan(input({ person: { state: "contact", established: true }, questions: "full" }))
    expect(full.ok && [full.plan.template, full.plan.autoTemplate]).toEqual(["sales", "plain"])
    const short = decideLinkPlan(input({ questions: "short" }))
    expect(short.ok && [short.plan.template, short.plan.autoTemplate]).toEqual(["plain", "sales"])
    const auto = decideLinkPlan(input({ questions: "auto" }))
    expect(auto.ok && [auto.plan.template, auto.plan.autoTemplate]).toEqual(["sales", "sales"])
  })
  it("loadCallQuestions reads both call types from Calendly, and says so when one cannot be read", async () => {
    const SALES = "https://api.calendly.com/event_types/f51d102e-850b-405b-8db5-c3f3ee189131"
    const PLAIN = "https://api.calendly.com/event_types/0b859751-f477-47c1-a40a-56d04235d84e"
    const db = fakeDb({ app_settings: [{ value: { plain: { event_type_uri: PLAIN, scheduling_url: "https://calendly.com/x/new-meeting" }, sales: { event_type_uri: SALES, scheduling_url: "https://calendly.com/x/free-meet-greet-call" } } }] })
    const { ctx } = calendly((req) =>
      req.url.includes("0b859751")
        ? { status: 200, body: { resource: { uri: PLAIN, name: "New Meeting", active: true, custom_questions: [{ name: "Please share anything that will help prepare for our meeting.", position: 0, enabled: true, required: false }] } } }
        : { status: 500 },
    )
    const q = await loadCallQuestions(db, ctx)
    expect(q.plain).toEqual({ ok: true, callName: "New Meeting", questions: [{ text: "Please share anything that will help prepare for our meeting.", required: false }] })
    expect(q.sales).toEqual({ ok: false, error: "The questions could not be read from Calendly just now." })
  })
  it("a call type that is not set up says so", async () => {
    const q = await loadCallQuestions(fakeDb({ app_settings: [] }), calendly(() => ({ status: 200, body: {} })).ctx)
    expect(q.plain).toEqual({ ok: false, error: "This call type is not set up yet." })
    expect(q.sales.ok).toBe(false)
  })
})
