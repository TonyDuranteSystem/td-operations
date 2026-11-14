import { describe, it, expect, vi } from "vitest"
import { miniDb } from "./helpers/mini-db"
import { recordContactBooking, listContactCalls, listContactCallsInWindow, bookedCallsToShow, contactCallChip, type ContactCallRow } from "@/lib/leads/contact-calls"

const OPTS = { unique: { contact_calls: [["calendly_event_uri"]] } }
const booking = (over: Record<string, unknown> = {}) => ({
  contactId: "C1", accountId: "A1", linkId: "L1", bookedAt: "2026-11-13T12:00:00.000Z", scheduledStart: "2026-11-20T15:00:00.000Z",
  eventUri: "https://api.calendly.com/scheduled_events/E1", eventTypeName: "New Meeting", ...over,
})

describe("recordContactBooking", () => {
  it("saves one row under the contact, with the New York date", async () => {
    const db = miniDb({}, OPTS)
    const r = await recordContactBooking(db, booking())
    expect(r).toMatchObject({ ok: true, created: true })
    expect(db.tables.contact_calls[0]).toMatchObject({ contact_id: "C1", account_id: "A1", booking_link_id: "L1", scheduled_date: "2026-11-20", state: "scheduled", source: "calendly", event_type_name: "New Meeting" })
  })
  it("the New York date, not the UTC date", async () => {
    const db = miniDb({}, OPTS)
    await recordContactBooking(db, booking({ scheduledStart: "2026-11-21T02:30:00.000Z" }))
    expect(db.tables.contact_calls[0].scheduled_date).toBe("2026-11-20")
  })
  it("idempotent on the event address: a redelivery changes nothing", async () => {
    const db = miniDb({}, OPTS)
    const a = await recordContactBooking(db, booking())
    const b = await recordContactBooking(db, booking())
    expect(b).toMatchObject({ ok: true, created: false, callId: a.callId })
    expect(db.tables.contact_calls).toHaveLength(1)
  })
  it("a reschedule marks the OLD call moved and points it to the new one", async () => {
    const db = miniDb({}, OPTS)
    const old = await recordContactBooking(db, booking({ eventUri: "https://api.calendly.com/scheduled_events/OLD" }))
    const fresh = await recordContactBooking(db, booking({ oldInvitee: "https://api.calendly.com/scheduled_events/OLD/invitees/I0" }))
    const oldRow = db.tables.contact_calls.find((r) => r.id === old.callId)!
    expect(oldRow).toMatchObject({ state: "moved", moved_to: fresh.callId })
    expect(db.tables.contact_calls.find((r) => r.id === fresh.callId)!.state).toBe("scheduled")
  })
  it("a redelivery of a reschedule still finishes the 'mark old moved' step", async () => {
    const db = miniDb({}, OPTS)
    await recordContactBooking(db, booking({ eventUri: "https://api.calendly.com/scheduled_events/OLD" }))
    const fresh = await recordContactBooking(db, booking({ oldInvitee: "https://api.calendly.com/scheduled_events/OLD/invitees/I0" }))
    db.tables.contact_calls.find((r) => r.calendly_event_uri?.toString().endsWith("OLD"))!.state = "scheduled" // pretend the first run died before this step
    await recordContactBooking(db, booking({ oldInvitee: "https://api.calendly.com/scheduled_events/OLD/invitees/I0" }))
    expect(db.tables.contact_calls.find((r) => r.calendly_event_uri?.toString().endsWith("OLD"))).toMatchObject({ state: "moved", moved_to: fresh.callId })
    expect(db.tables.contact_calls).toHaveLength(2)
  })
  it("never throws: a missing table or a failing insert is ok:false with a reason", async () => {
    expect(await recordContactBooking(miniDb({}, { missing: ["contact_calls"] }), booking())).toMatchObject({ ok: false, error: expect.stringMatching(/does not exist/) })
    expect(await recordContactBooking(miniDb({}, { failOps: { "contact_calls:insert": "disk full" } }), booking())).toMatchObject({ ok: false, error: "disk full" })
    expect(await recordContactBooking({ from: () => { throw new Error("boom") } }, booking())).toMatchObject({ ok: false, error: "boom" })
  })
  it("a booking with no event address is still saved (nothing to dedupe on)", async () => {
    const db = miniDb({}, OPTS)
    expect((await recordContactBooking(db, booking({ eventUri: null }))).ok).toBe(true)
  })
})

describe("readers are tolerant", () => {
  it("listContactCalls: newest first, empty on a missing table or error (and quiet about a missing table)", async () => {
    const rows = [
      { id: "1", contact_id: "C1", scheduled_start: "2026-11-01T10:00:00Z" },
      { id: "2", contact_id: "C1", scheduled_start: "2026-11-05T10:00:00Z" },
      { id: "3", contact_id: "C2", scheduled_start: "2026-11-09T10:00:00Z" },
    ]
    const out = await listContactCalls(miniDb({ contact_calls: rows }), "C1")
    expect(out.map((r) => r.id)).toEqual(["2", "1"])
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(await listContactCalls(miniDb({}, { missing: ["contact_calls"] }), "C1")).toEqual([])
    expect(err).not.toHaveBeenCalled()
    expect(await listContactCalls(miniDb({}, { failing: { contact_calls: "db down" } }), "C1")).toEqual([])
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })
  it("listContactCallsInWindow: only scheduled calls inside the window, with the contact's name; any error = none", async () => {
    const db = miniDb({
      contact_calls: [
        { contact_id: "C1", state: "scheduled", scheduled_start: "2026-11-20T15:00:00Z" },
        { contact_id: "C1", state: "moved", scheduled_start: "2026-11-20T15:00:00Z" },
        { contact_id: "C2", state: "scheduled", scheduled_start: "2026-12-30T15:00:00Z" },
      ],
      contacts: [{ id: "C1", full_name: "Maria Rossi" }],
    })
    expect(await listContactCallsInWindow(db, "2026-11-19T00:00:00Z", "2026-11-21T00:00:00Z")).toEqual([{ start: "2026-11-20T15:00:00Z", who: "Maria Rossi" }])
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(await listContactCallsInWindow(miniDb({}, { missing: ["contact_calls"] }), "a", "b")).toEqual([])
    expect(await listContactCallsInWindow(miniDb({}, { failing: { contact_calls: "x" } }), "a", "b")).toEqual([])
    expect(await listContactCallsInWindow({ from: () => { throw new Error("boom") } }, "a", "b")).toEqual([])
    err.mockRestore()
  })
})

describe("what the contact page shows", () => {
  const row = (over: Partial<ContactCallRow> = {}): ContactCallRow => ({ id: "r", contact_id: "C1", account_id: null, booking_link_id: null, booked_at: null, scheduled_start: "2026-11-20T15:00:00Z", scheduled_date: "2026-11-20", calendly_event_uri: null, event_type_name: null, state: "scheduled", moved_to: null, ...over })
  it("a booked call is hidden once a call summary exists for the same New York day", () => {
    expect(bookedCallsToShow([row()], ["2026-11-20T18:00:00Z"])).toEqual([])
    expect(bookedCallsToShow([row()], ["2026-11-19T18:00:00Z"])).toHaveLength(1)
    expect(bookedCallsToShow([row({ scheduled_date: null })], ["2026-11-20T18:00:00Z"])).toHaveLength(1)
    expect(bookedCallsToShow([row()], [])).toHaveLength(1)
  })
  it("chips: a past call still 'scheduled' is 'Not confirmed', never 'Scheduled'", () => {
    expect(contactCallChip(row(), "2026-11-13")).toBe("Scheduled")
    expect(contactCallChip(row(), "2026-11-20")).toBe("Scheduled")
    expect(contactCallChip(row(), "2026-11-21")).toBe("Not confirmed")
    expect(contactCallChip(row({ state: "moved" }), "2026-11-21")).toBe("Moved")
    expect(contactCallChip(row({ state: "cancelled" }), "2026-11-13")).toBe("Cancelled")
  })
})
