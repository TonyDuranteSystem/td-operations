/**
 * Paid booking links (dev job 74432428, 16 Nov 2026): "book and pay" on OUR page. The person picks one of the free times of the plain call type, the call is booked through
 * Calendly's booking service (tagged with the link's id like any booking made on Calendly's own page), the link is marked booked in one statement tied to a short lease, and the page
 * then sends them to the card page. These tests pin: which links may book, what is asked of Calendly, what is refused BEFORE Calendly is asked, the lease, a time that was just
 * taken, a booking the link cannot record (cancelled again), a call type that no longer matches, and the two readers of the free times.
 */
import { describe, it, expect } from "vitest"
import { miniDb, type MiniDb } from "./helpers/mini-db"
import { bookSlot, cleanStart, cleanTimezone, loadSlots, locationFor, SLOT_DAYS, type BookDeps } from "@/lib/booking/book-and-pay"
import { calendlyCtxFromEnv, type CalendlyCtx, type CalendlyHttpRequest } from "@/lib/calendly/api"

const NOW = new Date("2026-11-16T17:00:00.000Z")
const CODE = "2hhvDHUcAPqPBTXdD8HMqw"
const PUBLIC_ID = "YajC1ZB9eYDY8WC8tnLnxA"
const LINK = "b0000000-0000-4000-8000-000000000001"
const TYPE_UUID = "0b859751-f477-47c1-a40a-56d04235d84e"
const EVENT_URI = "https://api.calendly.com/scheduled_events/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const INVITEE_URI = `${EVENT_URI}/invitees/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`
const PICK = "2026-11-17T18:00:00.000Z"

const linkRow = (over: Record<string, unknown> = {}) => ({
  id: LINK, public_id: PUBLIC_ID, contact_id: null, lead_id: null, person_name: "Maria Rossi", person_emails: ["maria@example.com"], claimed_event_uri: null, revoked_at: null, status: "open",
  expires_at: null, duration_minutes: 30, pay_amount_cents: 100, pay_currency: "USD", pay_label: "call", pay_mode: "credit", pay_code: CODE, stripe_session_id: null, session_expires_at: null,
  session_claim_at: null, paid_session_id: null, not_charging_at: null, claimed_invitee_uri: null, claimed_email: null, claimed_at: null, ...over,
})
const templates = { key: "booking_templates", value: { plain: { event_type_uri: `https://api.calendly.com/event_types/${TYPE_UUID}`, scheduling_url: "https://calendly.com/x/new-meeting" } } }

const typeBody = (over: Record<string, unknown> = {}) => ({ resource: { uri: `https://api.calendly.com/event_types/${TYPE_UUID}`, name: "New Meeting", active: true, duration: 30, scheduling_url: "https://calendly.com/x/new-meeting", custom_questions: [], locations: [{ kind: "zoom_conference" }], ...over } })

interface Handler { (req: CalendlyHttpRequest): { status: number; body?: unknown } }
function calendly(over: Partial<Record<"slots" | "type" | "book" | "cancel", Handler>> = {}) {
  const calls: CalendlyHttpRequest[] = []
  const ok: Record<string, Handler> = {
    slots: () => ({ status: 200, body: { collection: [{ status: "available", start_time: "2026-11-17T19:00:00.000000Z" }, { status: "available", start_time: "2026-11-17T18:00:00.000000Z" }, { status: "unavailable", start_time: "2026-11-17T20:00:00.000000Z" }, { status: "available", start_time: "2026-11-17T18:00:00.000000Z" }] } }),
    type: () => ({ status: 200, body: typeBody() }),
    book: () => ({ status: 201, body: { resource: { uri: INVITEE_URI, event: EVENT_URI, cancel_url: "https://calendly.com/cancellations/abc" } } }),
    cancel: () => ({ status: 201, body: {} }),
  }
  const ctx: CalendlyCtx = {
    token: "test-token",
    http: async (req) => {
      calls.push(req)
      const u = new URL(req.url)
      const key = u.pathname === "/event_type_available_times" ? "slots" : u.pathname === "/invitees" ? "book" : u.pathname.endsWith("/cancellation") ? "cancel" : u.pathname.startsWith("/event_types/") ? "type" : "other"
      const r = (over[key as "slots"] ?? ok[key] ?? ((): { status: number; body?: unknown } => ({ status: 404 })))(req)
      return { status: r.status, json: async () => r.body ?? {} }
    },
  }
  return { ctx, calls, posts: () => calls.filter((c) => c.method === "POST" && new URL(c.url).pathname === "/invitees") }
}

function deps(db: MiniDb, c: ReturnType<typeof calendly> | null, reports: string[] = []): BookDeps {
  return { db, calendly: c ? c.ctx : undefined, now: NOW, reportError: async (m) => { reports.push(m) } }
}
const seed = (row: Record<string, unknown> = {}, withTemplates = true) => miniDb({ booking_links: [linkRow(row)], app_settings: withTemplates ? [templates] : [] })
const input = (over: Record<string, unknown> = {}) => ({ start: PICK, name: "Maria Rossi", email: "Maria@Example.com", timezone: "Europe/Rome", ...over })

/** wraps the database so the n-th update of booking_links that carries `field` finds nothing (as the lease filter does while a lease is held, or a conditioned save that lost the race) */
function loseUpdate(db: MiniDb, field: string): MiniDb {
  const real = db.from.bind(db)
  let done = false
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a tiny test fake
  ;(db as any).from = (t: string) => {
    const b = real(t) as Record<string, (...a: unknown[]) => unknown>
    if (t !== "booking_links") return b
    const upd = b.update
    b.update = (p: unknown) => {
      if (!done && typeof p === "object" && p && field in p && (field !== "session_claim_at" || !("status" in p))) {
        done = true
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const stub: any = { eq: () => stub, is: () => stub, or: () => stub, select: async () => ({ data: [], error: null }) }
        return stub
      }
      return upd(p)
    }
    return b
  }
  return db
}

describe("which links can book, and the free times", () => {
  it("returns the free times of the plain call type, earliest first, without repeats or times Calendly does not call available", async () => {
    const c = calendly()
    const r = await loadSlots(deps(seed(), c), CODE)
    expect(r).toEqual({ ok: true, slots: ["2026-11-17T18:00:00.000Z", "2026-11-17T19:00:00.000Z"], minutes: 30 })
    const asked = new URL(c.calls[0].url)
    expect(asked.pathname).toBe("/event_type_available_times")
    expect(asked.searchParams.get("event_type")).toBe(`https://api.calendly.com/event_types/${TYPE_UUID}`)
    expect(new Date(asked.searchParams.get("start_time") as string).getTime()).toBeGreaterThan(NOW.getTime())
    expect(new Date(asked.searchParams.get("end_time") as string).getTime() - NOW.getTime()).toBeLessThanOrEqual(SLOT_DAYS * 86_400_000)
    expect(SLOT_DAYS).toBeLessThanOrEqual(31) // Calendly's own limit for one request
  })
  it("an unknown or malformed code is 'none'; a paid, stopped, revoked, expired or already booked link takes no booking", async () => {
    const c = calendly()
    expect(await loadSlots(deps(seed(), c), "nope")).toMatchObject({ ok: false, reason: "none" })
    expect(await loadSlots(deps(seed({ paid_session_id: "cs_1" }), c), CODE)).toMatchObject({ ok: false, reason: "paid" })
    expect(await loadSlots(deps(seed({ not_charging_at: "2026-11-16T10:00:00Z" }), c), CODE)).toMatchObject({ ok: false, reason: "closed" })
    expect(await loadSlots(deps(seed({ revoked_at: "2026-11-16T10:00:00Z" }), c), CODE)).toMatchObject({ ok: false, reason: "closed" })
    expect(await loadSlots(deps(seed({ expires_at: "2026-11-16T10:00:00Z" }), c), CODE)).toMatchObject({ ok: false, reason: "closed" })
    expect(await loadSlots(deps(seed({ status: "claimed", claimed_event_uri: EVENT_URI }), c), CODE)).toMatchObject({ ok: false, reason: "booked" })
    expect(c.calls).toHaveLength(0) // Calendly is never asked for a link that cannot book
  })
  it("no call type set up, or no Calendly key, is 'setup' (a plain sentence, and the first one is reported)", async () => {
    const reports: string[] = []
    expect(await loadSlots(deps(seed({}, false), calendly(), reports), CODE)).toMatchObject({ ok: false, reason: "setup" })
    expect(reports).toHaveLength(1)
    expect(await loadSlots(deps(seed(), null), CODE)).toMatchObject({ ok: false, reason: "setup" })
  })
  it("Calendly refusing the app is 'setup' (reported); a busy or unreachable Calendly is 'calendly' (not reported); the answer never carries Calendly's own text", async () => {
    const reports: string[] = []
    const r403 = await loadSlots(deps(seed(), calendly({ slots: () => ({ status: 403, body: { message: "secret detail" } }) }), reports), CODE)
    expect(r403).toMatchObject({ ok: false, reason: "setup" })
    expect(JSON.stringify(r403)).not.toContain("secret detail")
    expect(reports).toHaveLength(1)
    for (const status of [429, 500]) expect(await loadSlots(deps(seed(), calendly({ slots: () => ({ status }) })), CODE)).toMatchObject({ ok: false, reason: "calendly" })
  })
})

describe("booking a time", () => {
  it("books through Calendly with the name, the email, the person's time zone, the place and the link's id as the tag; marks the link booked and lets the lease go", async () => {
    const c = calendly()
    const db = seed()
    const r = await bookSlot(deps(db, c), CODE, input())
    expect(r).toEqual({ ok: true, start: PICK })
    const post = c.posts()[0]
    expect(JSON.parse(post.body as string)).toEqual({
      event_type: `https://api.calendly.com/event_types/${TYPE_UUID}`,
      start_time: PICK,
      invitee: { name: "Maria Rossi", email: "Maria@Example.com", timezone: "Europe/Rome" },
      location: { kind: "zoom_conference" },
      tracking: { utm_term: PUBLIC_ID },
    })
    expect(db.tables.booking_links[0]).toMatchObject({ status: "claimed", claimed_invitee_uri: INVITEE_URI, claimed_event_uri: EVENT_URI, claimed_email: "maria@example.com", session_claim_at: null })
    // the link is one call: a second booking on it is refused and Calendly is not asked again
    expect(await bookSlot(deps(db, c), CODE, input({ start: "2026-11-17T19:00:00.000Z" }))).toMatchObject({ ok: false, reason: "booked" })
    expect(c.posts()).toHaveLength(1)
  })
  it("refuses a pick that is not a time, a past time, a time beyond the offered days, a missing name and a bad email, all BEFORE Calendly is asked", async () => {
    const c = calendly()
    for (const bad of [{ start: "soon" }, { start: "2026-11-16T17:01:00.000Z" }, { start: "2026-12-30T18:00:00.000Z" }, { start: 5 }, { name: "   " }, { name: 7 }, { email: "not-an-email" }, { email: "a b@c.com" }, { email: "x@y" }]) {
      expect(await bookSlot(deps(seed(), c), CODE, input(bad)), JSON.stringify(bad)).toMatchObject({ ok: false, reason: "invalid" })
    }
    expect(c.calls).toHaveLength(0)
  })
  it("a time somebody else just took is 'taken' (Calendly's text is never shown), the lease is let go and the link stays open for another pick", async () => {
    const db = seed()
    const c = calendly({ book: () => ({ status: 400, body: { title: "Invalid Argument", message: "that slot is no longer available" } }) })
    const r = await bookSlot(deps(db, c), CODE, input())
    expect(r).toMatchObject({ ok: false, reason: "taken" })
    expect(JSON.stringify(r)).not.toContain("no longer available")
    expect(db.tables.booking_links[0]).toMatchObject({ status: "open", session_claim_at: null, claimed_event_uri: null })
    expect(await bookSlot(deps(db, calendly()), CODE, input())).toMatchObject({ ok: true })
  })
  it("two taps at the same moment make ONE booking: while the lease is held the second is told to wait and Calendly is not asked", async () => {
    const c = calendly()
    const db = loseUpdate(seed(), "session_claim_at")
    expect(await bookSlot(deps(db, c), CODE, input())).toMatchObject({ ok: false, reason: "busy" })
    expect(c.posts()).toHaveLength(0)
  })
  it("a call Calendly booked but the link could not record (stopped meanwhile) is cancelled again, reported, and the person is told to try again", async () => {
    const reports: string[] = []
    const c = calendly()
    const db = loseUpdate(seed(), "claimed_invitee_uri")
    const r = await bookSlot(deps(db, c, reports), CODE, input())
    expect(r).toMatchObject({ ok: false, reason: "error" })
    expect(c.calls.some((x) => x.method === "POST" && new URL(x.url).pathname === `/scheduled_events/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/cancellation`)).toBe(true)
    expect(reports).toHaveLength(1)
    expect(db.tables.booking_links[0].status).toBe("open")
  })
  it("a call type that is inactive, has another length or a place that needs details is refused before anything is booked (reported)", async () => {
    for (const body of [typeBody({ active: false }), typeBody({ duration: 60 }), typeBody({ locations: [{ kind: "physical" }] }), typeBody({ locations: [{ kind: "custom" }] })]) {
      const reports: string[] = []
      const c = calendly({ type: () => ({ status: 200, body }) })
      expect(await bookSlot(deps(seed(), c, reports), CODE, input())).toMatchObject({ ok: false, reason: "setup" })
      expect(c.posts()).toHaveLength(0)
      expect(reports).toHaveLength(1)
    }
  })
  it("a call type with no place named is booked without one (Calendly decides); locationFor knows the simple kinds", async () => {
    const c = calendly({ type: () => ({ status: 200, body: typeBody({ locations: null }) }) })
    expect(await bookSlot(deps(seed(), c), CODE, input())).toMatchObject({ ok: true })
    expect(JSON.parse(c.posts()[0].body as string).location).toBeUndefined()
    expect(locationFor([])).toEqual({ kind: null })
    expect(locationFor(["google_conference", "zoom_conference"])).toEqual({ kind: "google_conference" })
    expect(locationFor(["physical"])).toBeNull()
  })
  it("a link with no Calendly key, or no call type set up, books nothing", async () => {
    expect(await bookSlot(deps(seed(), null), CODE, input())).toMatchObject({ ok: false, reason: "setup" })
    expect(await bookSlot(deps(seed({}, false), calendly()), CODE, input())).toMatchObject({ ok: false, reason: "setup" })
  })
  it("a database that fails is 'try again', never 'not found'", async () => {
    const db = miniDb({ booking_links: [linkRow()] }, { failing: { booking_links: "boom" } })
    expect(await bookSlot(deps(db, calendly()), CODE, input())).toMatchObject({ ok: false, reason: "error" })
  })
})

describe("the small cleaners", () => {
  it("cleanStart keeps only a real time inside the offered window, as UTC", () => {
    expect(cleanStart("2026-11-17T18:00:00.000000Z", NOW)).toBe("2026-11-17T18:00:00.000Z")
    expect(cleanStart("2026-11-17T13:00:00-05:00", NOW)).toBe("2026-11-17T18:00:00.000Z")
    for (const bad of [null, 5, "", "tomorrow", "2026-11-16T17:00:30.000Z", "2027-01-01T00:00:00.000Z", "x".repeat(60)]) expect(cleanStart(bad, NOW), String(bad)).toBeNull()
  })
  it("cleanTimezone keeps a real zone and falls back to New York for anything else", () => {
    expect(cleanTimezone("Europe/Rome")).toBe("Europe/Rome")
    expect(cleanTimezone("America/Argentina/Buenos_Aires")).toBe("America/Argentina/Buenos_Aires")
    for (const bad of [null, 5, "", "Not/AZone", "'; drop table", "x".repeat(80)]) expect(cleanTimezone(bad), String(bad)).toBe("America/New_York")
  })
  it("calendlyCtxFromEnv without a key leaves the app unable to book (setup, not a crash)", async () => {
    const none = calendlyCtxFromEnv({})
    expect(none.token).toBeNull()
    expect(await loadSlots({ db: seed(), calendly: none, now: NOW, reportError: async () => undefined }, CODE)).toMatchObject({ ok: false, reason: "setup" })
  })
})
