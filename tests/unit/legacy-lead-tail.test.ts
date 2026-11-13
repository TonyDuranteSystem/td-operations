/**
 * GOLDEN tests for the Calendly "legacy lead tail" (lib/calendly/legacy-lead-tail.ts): what happens to a booking after the paid-call step.
 * The code was MOVED out of the webhook route unchanged (Booking page, Stage 1a); these tests pin today's exact behaviour with synthetic bookings,
 * next to the private replay of ~100 real stored bookings (calendly-webhook-replay.test.ts) that proved old and new code write the same things.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { miniDb } from "./helpers/mini-db"
import { extractInviteeFields } from "@/lib/calendly/parse-invitee"

const h = vi.hoisted(() => ({ referrals: [] as unknown[], notified: [] as unknown[], referralResult: { created: true, id: "ref-1" } as { created: boolean; id?: string }, referralThrows: false }))
vi.mock("@/lib/operations/referral", () => ({
  createPendingReferral: async (args: unknown) => { h.referrals.push(args); if (h.referralThrows) throw new Error("referral failed"); return h.referralResult },
}))
vi.mock("@/lib/operations/referral-notify", () => ({ notifyReferrerLinked: async (a: unknown) => { h.notified.push(a) } }))

import { runLegacyLeadTail, keepBooking } from "@/lib/calendly/legacy-lead-tail"

const NOW = "2026-11-13T12:00:00.000Z"
const payload = (over: Record<string, unknown> = {}) => ({
  event: "invitee.created",
  payload: {
    uri: "https://api.calendly.com/scheduled_events/E1/invitees/I1", event: "https://api.calendly.com/scheduled_events/E1",
    email: "booker@example.com", name: "Booker Person", first_name: "Booker", last_name: "Person", timezone: "Europe/Rome",
    questions_and_answers: [{ question: "What is your phone number?", answer: "+39 02 1234 5678" }, { question: "Preferred language / Lingua", answer: "Italiano" }, { question: "Reason for the call", answer: "Open a US LLC" }],
    tracking: {}, scheduled_event: { start_time: "2026-06-10T15:00:00Z", name: "Free Call" }, ...over,
  },
})
const input = (db: ReturnType<typeof miniDb>, over: Record<string, unknown> = {}, p = payload()) => {
  const fields = extractInviteeFields(p)!
  return { db: db as never, payload: p as Record<string, unknown>, fields, existingLeads: null, taggedContactId: null, referrerContactId: null, referrerName: null, ...over }
}
const UNIQ = { unique: { lead_calls: [["calendly_event_uri"]] } }

beforeEach(() => {
  h.referrals.length = 0; h.notified.length = 0; h.referralResult = { created: true, id: "ref-1" }; h.referralThrows = false
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(NOW))
  vi.spyOn(console, "warn").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("a new lead (today's exact record)", () => {
  it("writes exactly these columns", async () => {
    const db = miniDb({}, UNIQ)
    const r = await runLegacyLeadTail(input(db))
    expect(r.kind).toBe("created")
    const lead = db.tables.leads[0]
    expect(lead).toMatchObject({
      full_name: "Booker Person", email: "booker@example.com", source: "Calendly", channel: "Calendly", status: "Call Scheduled",
      first_name: "Booker", last_name: "Person", phone: "+39 02 1234 5678", language: "Italian", reason: "Open a US LLC",
    })
    expect(String(lead.notes).split("\n")[0]).toBe("Booked via Calendly: Free Call")
    expect(lead.call_date).toBeTruthy()
    expect(lead.existing_client_contact_id).toBeUndefined()
    expect(lead.referrer_name).toBeUndefined()
    expect(Object.keys(lead).sort()).toEqual(["call_date", "channel", "created_at", "email", "first_name", "full_name", "id", "language", "last_name", "notes", "phone", "reason", "source", "status"])
  })
  it("keeps the booking as its own call on the lead (New York date) — idempotent on the event address", async () => {
    const db = miniDb({}, UNIQ)
    await runLegacyLeadTail(input(db))
    expect(db.tables.lead_calls).toHaveLength(1)
    expect(db.tables.lead_calls[0]).toMatchObject({ lead_id: db.tables.leads[0].id, scheduled_start: "2026-06-10T15:00:00Z", scheduled_date: "2026-06-10", state: "scheduled", source: "calendly", calendly_event_uri: "https://api.calendly.com/scheduled_events/E1" })
    await keepBooking(db as never, db.tables.leads[0].id as string, payload() as Record<string, unknown>)
    expect(db.tables.lead_calls).toHaveLength(1)
  })
  it("a reschedule marks the old call moved", async () => {
    const db = miniDb({}, UNIQ)
    await runLegacyLeadTail(input(db, {}, payload({ event: "https://api.calendly.com/scheduled_events/E0" })))
    await runLegacyLeadTail(input(db, {}, payload({ old_invitee: "https://api.calendly.com/scheduled_events/E0/invitees/I0" })))
    const old = db.tables.lead_calls.find((c) => String(c.calendly_event_uri).endsWith("/E0"))!
    expect(old.state).toBe("moved")
  })
  it("a booking that matched an ESTABLISHED client is tagged (never converted_to_contact_id)", async () => {
    const db = miniDb({}, UNIQ)
    await runLegacyLeadTail(input(db, { taggedContactId: "c-77" }))
    expect(db.tables.leads[0].existing_client_contact_id).toBe("c-77")
    expect(db.tables.leads[0].converted_to_contact_id).toBeUndefined()
  })
  it("a referral code that resolved: source Referral, referrer name on the lead, a pending referral and the notice", async () => {
    const db = miniDb({}, UNIQ)
    const r = await runLegacyLeadTail(input(db, { referrerContactId: "r1", referrerName: "Rita Referrer" }))
    expect(r).toMatchObject({ kind: "created", referrerContactId: "r1" })
    expect(db.tables.leads[0]).toMatchObject({ source: "Referral", referrer_name: "Rita Referrer" })
    expect(h.referrals).toEqual([{ referrerContactId: "r1", referredLeadId: db.tables.leads[0].id, referredName: "Booker Person", referredEmail: "booker@example.com" }])
    expect(h.notified).toEqual([{ referralId: "ref-1", referrerContactId: "r1", referredLeadId: db.tables.leads[0].id }])
  })
  it("a referral that was not created sends no notice; one that throws never blocks the lead", async () => {
    h.referralResult = { created: false }
    const a = await runLegacyLeadTail(input(miniDb({}, UNIQ), { referrerContactId: "r1", referrerName: "R" }))
    expect(a.kind).toBe("created")
    expect(h.notified).toEqual([])
    h.referralThrows = true
    const b = await runLegacyLeadTail(input(miniDb({}, UNIQ), { referrerContactId: "r1", referrerName: "R" }))
    expect(b.kind).toBe("created")
  })
  it("a failed lead insert is reported, and nothing else is written (no call, no referral)", async () => {
    const db = miniDb({}, { ...UNIQ, failOps: { "leads:insert": "insert failed" } })
    const r = await runLegacyLeadTail(input(db, { referrerContactId: "r1", referrerName: "R" }))
    expect(r).toEqual({ kind: "insert_failed", message: "insert failed" })
    expect(db.tables.lead_calls ?? []).toEqual([])
    expect(h.referrals).toEqual([])
  })
  it("a call that cannot be recorded is logged and never loses the lead", async () => {
    const db = miniDb({}, { ...UNIQ, failOps: { "lead_calls:insert": "no room" } })
    expect((await runLegacyLeadTail(input(db))).kind).toBe("created")
    expect(db.tables.leads).toHaveLength(1)
  })
})

describe("an existing lead (today's exact update)", () => {
  const lead = (over: Record<string, unknown> = {}) => ({ id: "L-old", status: "New", existing_client_contact_id: null, ...over })
  const run = (existing: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const db = miniDb({ leads: [{ ...existing }] }, UNIQ)
    return runLegacyLeadTail(input(db, { existingLeads: [lead(existing)], ...extra })).then((r) => ({ r, row: db.tables.leads[0], db }))
  }
  it("an early-stage lead moves to Call Scheduled and gets the call date", async () => {
    const { r, row } = await run({ id: "L-old", status: "New" })
    expect(r).toEqual({ kind: "updated", leadId: "L-old" })
    expect(row).toMatchObject({ status: "Call Scheduled", updated_at: NOW })
    expect(row.call_date).toBeTruthy()
  })
  it("a later-stage lead keeps its status", async () => {
    const { row } = await run({ id: "L-old", status: "Qualified" })
    expect(row.status).toBe("Qualified")
  })
  it("tags an established client only if the lead is not tagged yet", async () => {
    expect((await run({ id: "L-old", status: "New" }, { taggedContactId: "c-77" })).row.existing_client_contact_id).toBe("c-77")
    expect((await run({ id: "L-old", status: "New", existing_client_contact_id: "c-1" }, { taggedContactId: "c-77" })).row.existing_client_contact_id).toBe("c-1")
  })
  it("never changes the phone of a real lead (today's rule: only when the status is empty)", async () => {
    const { row } = await run({ id: "L-old", status: "New", phone: "111" })
    expect(row.phone).toBe("111")
  })
  it("records the call on the existing lead and writes no new lead", async () => {
    const { db } = await run({ id: "L-old", status: "New" })
    expect(db.tables.leads).toHaveLength(1)
    expect(db.tables.lead_calls[0].lead_id).toBe("L-old")
  })
  it("does not make a referral for an existing lead (today's behaviour)", async () => {
    await run({ id: "L-old", status: "New" }, { referrerContactId: "r1", referrerName: "R" })
    expect(h.referrals).toEqual([])
  })
})

describe("the booking-link hooks change nothing unless they are given", () => {
  it("no hooks, empty hooks and null hooks write the same lead", async () => {
    const out: unknown[] = []
    for (const hooks of [undefined, {}, { notesPrefix: null, languageFallback: null }]) {
      const db = miniDb({}, UNIQ)
      await runLegacyLeadTail(input(db, { hooks }))
      const { id: _id, created_at: _c, ...rest } = db.tables.leads[0]
      void _id; void _c
      out.push(rest)
    }
    expect(out[1]).toEqual(out[0])
    expect(out[2]).toEqual(out[0])
  })
  it("notesPrefix becomes the first line of a NEW lead's notes only", async () => {
    const db = miniDb({}, UNIQ)
    await runLegacyLeadTail(input(db, { hooks: { notesPrefix: "Booking kind: Partner" } }))
    expect(String(db.tables.leads[0].notes).split("\n")[0]).toBe("Booking kind: Partner")
    expect(String(db.tables.leads[0].notes)).toMatch(/\nBooked via Calendly/)
    const db2 = miniDb({ leads: [{ id: "L-old", status: "New", notes: "mine" }] }, UNIQ)
    await runLegacyLeadTail(input(db2, { existingLeads: [{ id: "L-old", status: "New" }], hooks: { notesPrefix: "Booking kind: Partner" } }))
    expect(db2.tables.leads[0].notes).toBe("mine")
  })
  it("languageFallback is used only when the booking said nothing", async () => {
    const quiet = payload({ questions_and_answers: [] })
    const a = miniDb({}, UNIQ)
    await runLegacyLeadTail(input(a, { hooks: { languageFallback: "Italian" } }, quiet))
    expect(a.tables.leads[0].language).toBe("Italian")
    const b = miniDb({}, UNIQ)
    await runLegacyLeadTail(input(b, { hooks: { languageFallback: "English" } }))
    expect(b.tables.leads[0].language).toBe("Italian") // the booking's own answer wins
  })
  it("onLeadResolved gets the lead id and whether it was created; a hook that throws changes nothing", async () => {
    const calls: Array<[string, boolean]> = []
    const db = miniDb({}, UNIQ)
    const r = await runLegacyLeadTail(input(db, { hooks: { onLeadResolved: (id: string, created: boolean) => { calls.push([id, created]) } } }))
    expect(calls).toEqual([[db.tables.leads[0].id as string, true]])
    expect(r.kind).toBe("created")
    const db2 = miniDb({ leads: [{ id: "L-old", status: "New" }] }, UNIQ)
    const r2 = await runLegacyLeadTail(input(db2, { existingLeads: [{ id: "L-old", status: "New" }], hooks: { onLeadResolved: () => { throw new Error("hook broke") } } }))
    expect(r2).toEqual({ kind: "updated", leadId: "L-old" })
  })
  it("onReferral reports attributed / already_attributed / failed", async () => {
    const seen: string[] = []
    const hooks = { onReferral: (o: string) => { seen.push(o) } }
    await runLegacyLeadTail(input(miniDb({}, UNIQ), { referrerContactId: "r1", referrerName: "R", hooks }))
    h.referralResult = { created: false }
    await runLegacyLeadTail(input(miniDb({}, UNIQ), { referrerContactId: "r1", referrerName: "R", hooks }))
    h.referralThrows = true
    await runLegacyLeadTail(input(miniDb({}, UNIQ), { referrerContactId: "r1", referrerName: "R", hooks }))
    expect(seen).toEqual(["attributed", "already_attributed", "failed"])
  })
})
