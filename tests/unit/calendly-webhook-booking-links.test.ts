/**
 * The Calendly webhook with BOOKING LINKS, run through the real route against an in-memory database (booking engine, Stage 1a).
 * Every behaviour the plan promises about a made link is pinned here: claim, replay, reschedule (with and without the tag), wrong email, unknown / used / revoked
 * link, reusable link, email-less link, alias email, the four kinds, referral, fallbacks that keep today's behaviour, and the switch.
 * (The sandbox cannot receive real webhooks and has no Calendly token, so this in-memory run is the strongest proof available before production.)
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import type { NextRequest } from "next/server"
import { miniDb, type MiniDb } from "./helpers/mini-db"
import { makeReq } from "./helpers/calendly-replay-harness"
import { buildRuleSnapshot, type KindRule } from "@/lib/booking/kinds"

const h = vi.hoisted(() => ({
  db: null as unknown as { from: (t: string) => unknown },
  paid: [] as unknown[],
  referrals: [] as unknown[],
  notified: [] as unknown[],
  errors: [] as Array<{ message?: string }>,
}))

vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ from: (t: string) => h.db.from(t) }) }))
vi.mock("@/lib/operations/paid-call-credit", () => ({
  recordPaidCall: async (args: unknown) => {
    h.paid.push(args)
    return { invoiceNumber: "INV-1", creditNumber: "CR-1", contactCreated: false, paymentIntentStamped: true }
  },
}))
vi.mock("@/lib/operations/referral", () => ({
  createPendingReferral: async (args: unknown) => {
    h.referrals.push(args)
    return { created: true, id: "ref-1" }
  },
}))
vi.mock("@/lib/operations/referral-notify", () => ({ notifyReferrerLinked: async (a: unknown) => { h.notified.push(a) } }))
vi.mock("@/lib/system-errors", () => ({ reportSystemError: async (a: { message?: string }) => { h.errors.push(a) } }))

import { POST } from "@/app/api/webhooks/calendly/route"

const SECRET = "test-secret"
const ID = "A".repeat(22)
const ID2 = "B".repeat(22)
const KIND_RULES: Record<string, KindRule> = {
  lead: { existing_person: "lead", new_person: "lead", mark_lead: false, sales_template: true },
  client: { existing_person: "attach", new_person: "lead", mark_lead: false, sales_template: false },
  partner: { existing_person: "attach", new_person: "lead", mark_lead: true, sales_template: false },
  private: { existing_person: "none", new_person: "none", mark_lead: false, sales_template: false },
}
const OPTS = {
  unique: {
    booking_links: [["public_id"], ["claimed_invitee_uri"]],
    call_checks: [["kind", "dedupe_key"]],
    contact_calls: [["calendly_event_uri"]],
    lead_calls: [["calendly_event_uri"]],
  },
}

type Row = Record<string, unknown>
const MARIA: Row = { id: "c1", full_name: "Maria Rossi", email: "maria@x.com", email_2: "maria.work@y.com", alt_emails: ["old@z.com"], portal_tier: "active", merged_into: null, created_at: "2026-01-01T00:00:00Z" }
const STUB: Row = { id: "c9", full_name: "Stub Person", email: "stub@x.com", email_2: null, alt_emails: [], portal_tier: "lead", merged_into: null, created_at: "2026-01-02T00:00:00Z" }
const REFERRER: Row = { id: "r1", full_name: "Rita Referrer", email: "rita@x.com", email_2: null, alt_emails: [], portal_tier: "active", merged_into: null, referral_code: "RITA-2026", created_at: "2025-01-01T00:00:00Z" }

function link(kind: keyof typeof KIND_RULES, over: Row = {}): Row {
  return {
    id: "L1", public_id: ID, kind_label: kind[0].toUpperCase() + kind.slice(1), rule_snapshot: buildRuleSnapshot({ slug: kind, label: kind[0].toUpperCase() + kind.slice(1) }, KIND_RULES[kind]),
    status: "open", once: true, revoked_at: null, expires_at: null, claimed_invitee_uri: null, claimed_event_uri: null, claimed_email: null, effects_done_at: null,
    person_emails: ["maria@x.com"], contact_id: null, account_id: null, lead_id: null, person_name: "Maria Rossi", person_language: null,
    referrer_contact_id: null, referrer_code: null, referral_outcome: null, ...over,
  }
}

function booking(o: { email?: string; inv?: string; ev?: string; term?: string | null; old?: string; qa?: Array<{ question: string; answer: string }>; payment?: unknown; campaign?: string } = {}) {
  const inv = o.inv ?? "https://api.calendly.com/scheduled_events/E1/invitees/I1"
  const tracking: Record<string, string> = {}
  if (o.term) tracking.utm_term = o.term
  if (o.campaign) tracking.utm_campaign = o.campaign
  return {
    event: "invitee.created",
    payload: {
      uri: inv,
      event: o.ev ?? inv.split("/invitees/")[0],
      email: o.email ?? "maria@x.com",
      name: "Maria Rossi", first_name: "Maria", last_name: "Rossi", timezone: "America/New_York",
      questions_and_answers: o.qa ?? [],
      tracking,
      scheduled_event: { start_time: "2026-11-20T15:00:00Z", name: "New Meeting" },
      ...(o.old ? { old_invitee: o.old } : {}),
      ...(o.payment ? { payment: o.payment } : {}),
    },
  }
}

let db: MiniDb
function world(seed: Record<string, Row[]> = {}, opts: Parameters<typeof miniDb>[1] = {}, mode: string | null = "live") {
  db = miniDb(
    { ...(mode ? { app_settings: [{ key: "booking", value: { mode } }] } : {}), contacts: [MARIA], ...seed },
    { ...OPTS, ...opts, unique: { ...OPTS.unique, ...(opts.unique ?? {}) } },
  )
  h.db = db
}
async function send(payload: unknown) {
  const res = await POST(makeReq(payload, SECRET) as unknown as NextRequest)
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}
const rows = (t: string) => db.tables[t] ?? []

beforeEach(() => {
  h.paid.length = 0; h.referrals.length = 0; h.notified.length = 0; h.errors.length = 0
  process.env.CALENDLY_WEBHOOK_SECRET = SECRET
  process.env.CALENDLY_INTAKE_MODE = "auto_create"
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("the switch decides everything", () => {
  it("switch absent: a tagged booking is handled exactly as today, no link table is even read", async () => {
    world({ booking_links: [link("client", { contact_id: "c1" })] }, {}, null)
    const r = await send(booking({ term: ID }))
    expect(r.body.action).toBe("created")
    expect(rows("leads")).toHaveLength(1)
    expect(rows("booking_links")[0].status).toBe("open")
    expect(db.log.filter((l) => l.table === "booking_links")).toEqual([])
    expect(rows("contact_calls")).toEqual([])
    expect(rows("call_checks")).toEqual([])
  })
  it("mode page and mode off behave the same: link ignored", async () => {
    for (const mode of ["page", "off"]) {
      world({ booking_links: [link("client", { contact_id: "c1" })] }, {}, mode)
      const r = await send(booking({ term: ID }))
      expect(r.body.action).toBe("created")
      expect(db.log.filter((l) => l.table === "booking_links")).toEqual([])
    }
  })
  it("no signing secret: the link branch never runs (anyone could forge a link id)", async () => {
    world({ booking_links: [link("client", { contact_id: "c1" })] })
    delete process.env.CALENDLY_WEBHOOK_SECRET
    const res = await POST(makeReq(booking({ term: ID })) as unknown as NextRequest)
    expect((await res.json()).action).toBe("created")
    expect(db.log.filter((l) => l.table === "booking_links")).toEqual([])
  })
  it("staging mode ignores links too (the booking only waits for review)", async () => {
    world({ booking_links: [link("client", { contact_id: "c1" })] })
    process.env.CALENDLY_INTAKE_MODE = "staging"
    const r = await send(booking({ term: ID }))
    expect(r.body.action).toBe("staged")
    expect(rows("booking_links")[0].status).toBe("open")
  })
  it("live but a booking with NO tag: the same as today, and nothing is written to the link tables", async () => {
    world({ booking_links: [link("client", { contact_id: "c1" })] })
    const r = await send(booking())
    expect(r.body.action).toBe("created")
    expect(rows("call_checks")).toEqual([])
    expect(rows("booking_links")[0].status).toBe("open")
  })
  it("an ad keyword in utm_term is ignored: no lookup, no card", async () => {
    world({ booking_links: [link("client", { contact_id: "c1" })] })
    const r = await send(booking({ term: "llc formation near me" }))
    expect(r.body.action).toBe("created")
    expect(rows("call_checks")).toEqual([])
    expect(db.log.filter((l) => l.table === "booking_links")).toEqual([])
  })
})

describe("Client kind, person already a contact: the call is saved UNDER THE CONTACT, no lead", () => {
  beforeEach(() => world({ booking_links: [link("client", { contact_id: "c1", account_id: "a1" })] }))

  it("claims the link, logs the call, answers 'attached', creates no lead", async () => {
    const r = await send(booking({ term: ID }))
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ action: "attached", contact_id: "c1" })
    expect(rows("leads")).toEqual([])
    expect(rows("contact_calls")).toHaveLength(1)
    expect(rows("contact_calls")[0]).toMatchObject({ contact_id: "c1", account_id: "a1", booking_link_id: "L1", state: "scheduled", scheduled_date: "2026-11-20", event_type_name: "New Meeting" })
    expect(rows("booking_links")[0]).toMatchObject({ status: "claimed", claimed_invitee_uri: "https://api.calendly.com/scheduled_events/E1/invitees/I1", claimed_email: "maria@x.com" })
    expect(rows("booking_links")[0].effects_done_at).toBeTruthy()
    expect(rows("call_checks")).toEqual([])
  })
  it("the same delivery again (Calendly retry) is a replay: nothing doubles, no stray lead", async () => {
    await send(booking({ term: ID }))
    const again = await send(booking({ term: ID }))
    expect(again.body).toEqual({ action: "replay" })
    expect(rows("leads")).toEqual([])
    expect(rows("contact_calls")).toHaveLength(1)
    expect(rows("call_checks")).toEqual([])
  })
  it("a replay after a CRASH between claim and effects re-runs the effects (the booking is not lost)", async () => {
    // state the database would be in if the function died right after the claim:
    world({ booking_links: [link("client", { contact_id: "c1", status: "claimed", claimed_invitee_uri: "https://api.calendly.com/scheduled_events/E1/invitees/I1", claimed_email: "maria@x.com", effects_done_at: null })] })
    const r = await send(booking({ term: ID }))
    expect(r.body).toMatchObject({ action: "attached" })
    expect(rows("contact_calls")).toHaveLength(1)
    expect(rows("leads")).toEqual([])
    expect(rows("booking_links")[0].effects_done_at).toBeTruthy()
  })
  it("a booking by the person's SECOND address (email_2) or an alternate address is the same person", async () => {
    world({ booking_links: [link("client", { contact_id: "c1", person_emails: ["maria@x.com", "maria.work@y.com", "old@z.com"] })] })
    const r = await send(booking({ term: ID, email: "Maria.Work@y.com" }))
    expect(r.body.action).toBe("attached")
    expect(rows("call_checks")).toEqual([])
  })
  it("the paid-call step still runs FIRST, on the booker's email, even for a call saved under the contact", async () => {
    const r = await send(booking({ term: ID, payment: { amount: 300, currency: "USD", successful: true, external_id: "ch_1", provider: "stripe" } }))
    expect(r.body.action).toBe("attached")
    expect(h.paid).toHaveLength(1)
    expect(h.paid[0]).toMatchObject({ inviteeEmail: "maria@x.com" })
  })
  it("a database failure while saving the call: the booking still becomes a lead as today, and a card says why", async () => {
    world({ booking_links: [link("client", { contact_id: "c1" })] }, { failOps: { "contact_calls:insert": "disk full" } })
    const r = await send(booking({ term: ID }))
    expect(r.body.action).toBe("created")
    expect(rows("leads")).toHaveLength(1)
    expect(rows("call_checks")).toHaveLength(1)
    expect(rows("call_checks")[0]).toMatchObject({ kind: "effect_failed", booking_link_id: "L1" })
    expect(String((rows("call_checks")[0].payload as Row).reason)).toMatch(/disk full/)
  })
})

describe("wrong email, unknown, used and revoked links: today's behaviour + a card, never a lost booking", () => {
  it("a different email = a normal lead, NO claim, a 'mismatch' card, no referral credit", async () => {
    world({ booking_links: [link("client", { contact_id: "c1", referrer_contact_id: "r1", referrer_code: "RITA-2026" })], contacts: [MARIA, REFERRER] })
    const r = await send(booking({ term: ID, email: "stranger@elsewhere.com" }))
    expect(r.body.action).toBe("created")
    expect(rows("leads")).toHaveLength(1)
    expect(rows("leads")[0].source).toBe("Calendly")
    expect(rows("booking_links")[0]).toMatchObject({ status: "open", claimed_invitee_uri: null })
    expect(rows("call_checks")).toHaveLength(1)
    expect(rows("call_checks")[0]).toMatchObject({ kind: "mismatch", booking_link_id: "L1" })
    expect((rows("call_checks")[0].payload as Row).booker_email).toBe("stranger@elsewhere.com")
    expect(h.referrals).toEqual([])
  })
  it("a mismatch card is made once, however many times Calendly re-sends the booking", async () => {
    world({ booking_links: [link("client", { contact_id: "c1" })] })
    await send(booking({ term: ID, email: "stranger@elsewhere.com" }))
    await send(booking({ term: ID, email: "stranger@elsewhere.com" }))
    expect(rows("call_checks")).toHaveLength(1)
  })
  it("an id of our shape that matches no link = today's behaviour + an 'unknown_id' card", async () => {
    world({ booking_links: [] })
    const r = await send(booking({ term: ID }))
    expect(r.body.action).toBe("created")
    expect(rows("call_checks")).toHaveLength(1)
    expect(rows("call_checks")[0]).toMatchObject({ kind: "unknown_id" })
    expect((rows("call_checks")[0].payload as Row).reason).toBe("not_found")
  })
  it("a link already used by another booking = lead as today + 'unknown_id' card (reason used); the link keeps its first claim", async () => {
    world({ booking_links: [link("client", { contact_id: "c1", status: "claimed", claimed_invitee_uri: "https://api.calendly.com/scheduled_events/E0/invitees/I0", claimed_email: "maria@x.com", effects_done_at: "2026-11-13T10:00:00Z" })] })
    const r = await send(booking({ term: ID }))
    expect(r.body.action).toBe("created")
    expect((rows("call_checks")[0].payload as Row).reason).toBe("used")
    expect(rows("booking_links")[0].claimed_invitee_uri).toBe("https://api.calendly.com/scheduled_events/E0/invitees/I0")
  })
  it("a revoked link = lead as today + card (reason revoked)", async () => {
    world({ booking_links: [link("client", { contact_id: "c1", revoked_at: "2026-11-01T00:00:00Z" })] })
    const r = await send(booking({ term: ID }))
    expect(r.body.action).toBe("created")
    expect((rows("call_checks")[0].payload as Row).reason).toBe("revoked")
    expect(rows("contact_calls")).toEqual([])
  })
  it("an expired link = lead as today + card (reason expired)", async () => {
    world({ booking_links: [link("client", { contact_id: "c1", expires_at: "2020-01-01T00:00:00Z" })] })
    const r = await send(booking({ term: ID }))
    expect(r.body.action).toBe("created")
    expect((rows("call_checks")[0].payload as Row).reason).toBe("expired")
  })
  it("a link-lookup database error never loses the booking: it is handled as usual and the error is reported", async () => {
    world({}, { failing: { booking_links: "connection lost" } })
    const r = await send(booking({ term: ID }))
    expect(r.status).toBe(200)
    expect(r.body.action).toBe("created")
    expect(h.errors.some((e) => /lookup failed/.test(String(e.message)))).toBe(true)
  })
  it("a missing booking_links table (code deployed before the migration) changes nothing", async () => {
    world({}, { missing: ["booking_links", "call_checks", "contact_calls"] })
    const r = await send(booking({ term: ID }))
    expect(r.status).toBe(200)
    expect(r.body.action).toBe("created")
  })
  it("a card that cannot be saved is still not silent: a system error AND the stored event is marked for review", async () => {
    world({ booking_links: [link("client", { contact_id: "c1" })] }, { failing: { call_checks: "db down" } })
    const r = await send(booking({ term: ID, email: "stranger@elsewhere.com" }))
    expect(r.body.action).toBe("created")
    expect(h.errors.some((e) => /card could not be saved \(mismatch\)/.test(String(e.message)))).toBe(true)
    expect(rows("webhook_events")[0].review_status).toBe("link_check")
  })
  it("a failure while CLAIMING (database error) falls back to today's behaviour with an 'effect_failed' card", async () => {
    world({ booking_links: [link("client", { contact_id: "c1" })] }, { failOps: { "booking_links:update": "claim failed" } })
    const r = await send(booking({ term: ID }))
    expect(r.body.action).toBe("created")
    expect(rows("call_checks")[0]).toMatchObject({ kind: "effect_failed" })
  })
})

describe("the claim is atomic", () => {
  it("two different bookings on one one-time link: ONE wins, the other becomes a normal lead + a 'used' card", async () => {
    world({ booking_links: [link("client", { contact_id: "c1", person_emails: [] })], contacts: [MARIA, STUB] })
    const first = await send(booking({ term: ID, inv: "https://api.calendly.com/scheduled_events/E1/invitees/I1", email: "maria@x.com" }))
    const second = await send(booking({ term: ID, inv: "https://api.calendly.com/scheduled_events/E2/invitees/I2", email: "stub@x.com" }))
    expect(first.body.action).toBe("attached")
    expect(second.body.action).toBe("created")
    expect(rows("contact_calls")).toHaveLength(1)
    expect(rows("call_checks")).toHaveLength(1)
    expect((rows("call_checks")[0].payload as Row).reason).toBe("used")
  })
})

describe("a link made with no email (the first booker claims it)", () => {
  it("claims for the first booker, remembers their email, and a reschedule must come from the same person", async () => {
    world({ booking_links: [link("client", { contact_id: "c1", person_emails: [] })] })
    const first = await send(booking({ term: ID, email: "maria@x.com" }))
    expect(first.body.action).toBe("attached")
    expect(rows("booking_links")[0].claimed_email).toBe("maria@x.com")
    const stranger = await send(booking({ term: ID, inv: "https://api.calendly.com/scheduled_events/E2/invitees/I2", old: "https://api.calendly.com/scheduled_events/E1/invitees/I1", email: "stranger@y.com" }))
    expect(stranger.body.action).toBe("created")
    expect(rows("call_checks")).toHaveLength(1)
  })
})

describe("reschedule", () => {
  const OLD = "https://api.calendly.com/scheduled_events/E1/invitees/I1"
  const NEW = "https://api.calendly.com/scheduled_events/E2/invitees/I2"
  it("carries the tag: the claim moves to the new booking, the old call is marked moved, no stray lead", async () => {
    world({ booking_links: [link("client", { contact_id: "c1" })] })
    await send(booking({ term: ID, inv: OLD }))
    const r = await send(booking({ term: ID, inv: NEW, old: OLD }))
    expect(r.body.action).toBe("attached")
    expect(rows("leads")).toEqual([])
    expect(rows("booking_links")[0].claimed_invitee_uri).toBe(NEW)
    expect(rows("contact_calls")).toHaveLength(2)
    const states = Object.fromEntries(rows("contact_calls").map((c) => [String(c.calendly_event_uri).split("/").pop(), c.state]))
    expect(states).toEqual({ E1: "moved", E2: "scheduled" })
  })
  it("the tag did NOT arrive: the link is still found through the booking it replaces", async () => {
    world({ booking_links: [link("client", { contact_id: "c1" })] })
    await send(booking({ term: ID, inv: OLD }))
    const r = await send(booking({ term: null, inv: NEW, old: OLD }))
    expect(r.body.action).toBe("attached")
    expect(rows("leads")).toEqual([])
    expect(rows("booking_links")[0].claimed_invitee_uri).toBe(NEW)
  })
  it("a reschedule that names an old booking no link knows is just a normal booking (no card, today's path)", async () => {
    world({ booking_links: [link("client", { contact_id: "c1" })] })
    const r = await send(booking({ term: null, inv: NEW, old: "https://api.calendly.com/scheduled_events/ZZ/invitees/I9" }))
    expect(r.body.action).toBe("created")
    expect(rows("call_checks")).toEqual([])
  })
})

describe("reusable link (the standard 30-minute link)", () => {
  it("never claims: it stays open for the next booker, and each booking is still saved", async () => {
    world({ booking_links: [link("client", { contact_id: "c1", once: false, person_emails: [] })] })
    const a = await send(booking({ term: ID, inv: "https://api.calendly.com/scheduled_events/E1/invitees/I1" }))
    const b = await send(booking({ term: ID, inv: "https://api.calendly.com/scheduled_events/E2/invitees/I2" }))
    expect(a.body.action).toBe("attached")
    expect(b.body.action).toBe("attached")
    expect(rows("booking_links")[0]).toMatchObject({ status: "open", claimed_invitee_uri: null })
    expect(rows("contact_calls")).toHaveLength(2)
  })
})

describe("Lead kind (today's lead path, with the link's extras)", () => {
  it("a new person: the lead is made as today, the link remembers the lead and is marked done", async () => {
    world({ booking_links: [link("lead", { person_emails: ["new@x.com"], person_name: "New Person" })], contacts: [] })
    const r = await send(booking({ term: ID, email: "new@x.com" }))
    expect(r.body.action).toBe("created")
    expect(rows("leads")).toHaveLength(1)
    expect(rows("leads")[0].notes).not.toMatch(/Booking kind/)
    expect(rows("lead_calls")).toHaveLength(1)
    expect(rows("booking_links")[0]).toMatchObject({ status: "claimed", lead_id: rows("leads")[0].id })
    expect(rows("booking_links")[0].effects_done_at).toBeTruthy()
  })
  it("a person who is already a lead: that lead is updated (no second lead)", async () => {
    world({ booking_links: [link("lead", { person_emails: ["new@x.com"] })], contacts: [], leads: [{ id: "lead-old", email: "new@x.com", status: "New", created_at: "2026-10-01T00:00:00Z" }] })
    const r = await send(booking({ term: ID, email: "new@x.com" }))
    expect(r.body.action).toBe("updated")
    expect(rows("leads")).toHaveLength(1)
    expect(rows("booking_links")[0]).toMatchObject({ lead_id: "lead-old" })
  })
  it("a replay after the lead was made does not make a second lead", async () => {
    world({ booking_links: [link("lead", { person_emails: ["new@x.com"] })], contacts: [] })
    await send(booking({ term: ID, email: "new@x.com" }))
    const again = await send(booking({ term: ID, email: "new@x.com" }))
    expect(again.body).toEqual({ action: "replay" })
    expect(rows("leads")).toHaveLength(1)
  })
  it("a replay after a crash BEFORE the lead existed makes it (re-runs the effects)", async () => {
    world({ booking_links: [link("lead", { person_emails: ["new@x.com"], status: "claimed", claimed_invitee_uri: "https://api.calendly.com/scheduled_events/E1/invitees/I1", claimed_email: "new@x.com" })], contacts: [] })
    const r = await send(booking({ term: ID, email: "new@x.com" }))
    expect(r.body.action).toBe("created")
    expect(rows("leads")).toHaveLength(1)
    expect(rows("booking_links")[0].effects_done_at).toBeTruthy()
  })
  it("the lead tail failing (500, as today) leaves the effects NOT done, so Calendly's retry finishes the job", async () => {
    world({ booking_links: [link("lead", { person_emails: ["new@x.com"] })], contacts: [] }, { failOps: { "leads:insert": "insert failed" } })
    const r = await send(booking({ term: ID, email: "new@x.com" }))
    expect(r.status).toBe(500)
    expect(rows("booking_links")[0].effects_done_at).toBeNull()
  })
})

describe("Partner kind, new person: marked in the notes", () => {
  it("'Booking kind: Partner' is the FIRST line of the lead's notes, and only when this booking makes the lead", async () => {
    world({ booking_links: [link("partner", { kind_label: "Partner", person_emails: ["p@x.com"] })], contacts: [] })
    await send(booking({ term: ID, email: "p@x.com" }))
    expect(String(rows("leads")[0].notes).split("\n")[0]).toBe("Booking kind: Partner")
    expect(String(rows("leads")[0].notes)).toMatch(/Booked via Calendly/)
  })
  it("an existing lead's notes are not touched", async () => {
    world({ booking_links: [link("partner", { person_emails: ["p@x.com"] })], contacts: [], leads: [{ id: "lead-old", email: "p@x.com", status: "New", notes: "old notes", created_at: "2026-10-01T00:00:00Z" }] })
    await send(booking({ term: ID, email: "p@x.com" }))
    expect(rows("leads")[0].notes).toBe("old notes")
  })
})

describe("language of a lead made through a link", () => {
  it("the link's person language fills a lead whose booking did not say (dirty value normalised)", async () => {
    world({ booking_links: [link("lead", { person_emails: ["new@x.com"], person_language: "Italiano" })], contacts: [] })
    await send(booking({ term: ID, email: "new@x.com" }))
    expect(rows("leads")[0].language).toBe("Italian")
  })
  it("what the booking itself says always wins", async () => {
    world({ booking_links: [link("lead", { person_emails: ["new@x.com"], person_language: "Italiano" })], contacts: [] })
    await send(booking({ term: ID, email: "new@x.com", qa: [{ question: "Preferred language / Lingua", answer: "English" }] }))
    expect(rows("leads")[0].language).toBe("English")
  })
  it("a language we cannot read is not written", async () => {
    world({ booking_links: [link("lead", { person_emails: ["new@x.com"], person_language: "Klingon" })], contacts: [] })
    await send(booking({ term: ID, email: "new@x.com" }))
    expect(rows("leads")[0].language).toBeUndefined()
  })
})

describe("Private kind: nothing is saved", () => {
  it("the link is claimed and the booking is answered, with no lead and no contact call", async () => {
    world({ booking_links: [link("private", { person_emails: [] })], contacts: [] })
    const r = await send(booking({ term: ID, email: "friend@x.com" }))
    expect(r.body).toEqual({ action: "calendar_only" })
    expect(rows("leads")).toEqual([])
    expect(rows("contact_calls")).toEqual([])
    expect(rows("booking_links")[0]).toMatchObject({ status: "claimed" })
    expect(rows("booking_links")[0].effects_done_at).toBeTruthy()
  })
})

describe("a Client link whose booker turns out to be a stub contact or a stranger", () => {
  it("a new person on a Client link becomes a lead (the kind says 'lead' for new people)", async () => {
    world({ booking_links: [link("client", { person_emails: [] })], contacts: [] })
    const r = await send(booking({ term: ID, email: "newbie@x.com" }))
    expect(r.body.action).toBe("created")
  })
  it("an email-less link: an established client found by email_2 is attached (alias-aware)", async () => {
    world({ booking_links: [link("client", { person_emails: [] })] })
    const r = await send(booking({ term: ID, email: "maria.work@y.com" }))
    expect(r.body.action).toBe("attached")
    expect(rows("contact_calls")[0].contact_id).toBe("c1")
  })
  it("an email-less link: a bare stub contact is NOT a client, the booker becomes a lead as today", async () => {
    world({ booking_links: [link("client", { person_emails: [] })], contacts: [STUB] })
    const r = await send(booking({ term: ID, email: "stub@x.com" }))
    expect(r.body.action).toBe("created")
    expect(rows("contact_calls")).toEqual([])
  })
})

describe("referrer on a made link comes from the ROW only", () => {
  const withRef = (kind: "lead" | "client", extra: Row = {}, seed: Record<string, Row[]> = {}) =>
    world({ booking_links: [link(kind, { person_emails: ["new@x.com"], referrer_contact_id: "r1", referrer_code: "RITA-2026", ...extra })], contacts: [REFERRER], ...seed })
  it("a brand-new person: the referral is attributed to the row's referrer and the outcome is written on the row", async () => {
    withRef("lead")
    const r = await send(booking({ term: ID, email: "new@x.com" }))
    expect(r.body).toMatchObject({ action: "created", referrer_contact_id: "r1" })
    expect(rows("leads")[0]).toMatchObject({ source: "Referral", referrer_name: "Rita Referrer" })
    expect(h.referrals).toHaveLength(1)
    expect(h.referrals[0]).toMatchObject({ referrerContactId: "r1" })
    expect(rows("booking_links")[0].referral_outcome).toBe("attributed")
  })
  it("a referral code in utm_campaign of the SAME booking is ignored when a link is in play", async () => {
    withRef("lead", { referrer_contact_id: null, referrer_code: null }, { contacts: [REFERRER] })
    const r = await send(booking({ term: ID, email: "new@x.com", campaign: "RITA-2026" }))
    expect(r.body).toMatchObject({ action: "created", referrer_contact_id: null })
    expect(h.referrals).toEqual([])
    expect(rows("booking_links")[0].referral_outcome).toBeNull()
  })
  it("a booker who is already a lead: no credit, and the reason is recorded on the row", async () => {
    withRef("lead", {}, { leads: [{ id: "lead-old", email: "new@x.com", status: "New", created_at: "2026-10-01T00:00:00Z" }] })
    const r = await send(booking({ term: ID, email: "new@x.com" }))
    expect(r.body.action).toBe("updated")
    expect(h.referrals).toEqual([])
    expect(rows("booking_links")[0].referral_outcome).toBe("not_new_lead")
  })
  it("a booker who is an established client (found by an alternate address): no credit", async () => {
    withRef("lead", { person_emails: ["old@z.com"] }, { contacts: [REFERRER, MARIA] })
    const r = await send(booking({ term: ID, email: "old@z.com" }))
    expect(h.referrals).toEqual([])
    expect(["created", "updated", "attached"]).toContain(r.body.action)
    expect(rows("booking_links")[0].referral_outcome).toBe("booker_is_client")
  })
  it("with the switch off the old address-based lookup still works exactly as before", async () => {
    world({ contacts: [REFERRER] }, {}, null)
    const r = await send(booking({ email: "new@x.com", campaign: "RITA-2026" }))
    expect(r.body).toMatchObject({ action: "created", referrer_contact_id: "r1" })
    expect(h.referrals).toHaveLength(1)
  })
})

describe("a unique-index clash on the claim is an explicit branch", () => {
  it("the same booking already holding another link: lead as today + 'unknown_id' card (booking_already_linked)", async () => {
    world({ booking_links: [link("client", { contact_id: "c1" }), link("client", { id: "L2", public_id: ID2, status: "claimed", claimed_invitee_uri: "https://api.calendly.com/scheduled_events/E1/invitees/I1", effects_done_at: "2026-11-13T10:00:00Z" })] })
    const r = await send(booking({ term: ID }))
    expect(r.body.action).toBe("created")
    expect((rows("call_checks")[0].payload as Row).reason).toBe("booking_already_linked")
  })
})
