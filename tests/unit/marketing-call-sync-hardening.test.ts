import { describe, it, expect, vi, beforeEach } from "vitest"
import { timePrefsFrom } from "@/lib/marketing/time-prefs"
import { FakeGcal } from "./helpers/fake-gcal"

// The bug hunt of 30 Oct 2026 on the time-zone build: what happens to the seller's calendar when the seller is gone, Google flickers, or the history cannot be written.
const ROC = "rocco@tonydurante.us"
const ROCCO_ID = "22222222-2222-4222-8222-222222222222"
let takers: Array<{ userId: string; label: string; email: string | null }> = []
vi.mock("@/lib/marketing/time-prefs-server", () => ({
  loadPrefsAndTakers: async () => ({
    prefs: timePrefsFrom({ member_call_hours: { [ROCCO_ID]: {} }, member_time_zones: { [ROCCO_ID]: "Atlantic/Canary" }, calendar_write_through_enabled: true } as Parameters<typeof timePrefsFrom>[0]),
    takers, rows: [],
  }),
}))
import { syncAfterAppointment } from "@/lib/marketing/call-sync-server"

function stubDb(lead: Record<string, unknown> | null, history: Array<Record<string, unknown>> = [], insertError: string | null = null) {
  const inserts: Array<Record<string, unknown>> = []
  const chain = (table: string) => {
    const q: Record<string, unknown> = {}
    for (const m of ["select", "eq", "order", "limit"]) q[m] = () => q
    q.maybeSingle = async () => ({ data: table === "marketing_leads" ? lead : null })
    q.then = (res: (v: unknown) => void) => res({ data: table === "marketing_lead_events" ? history : [] })
    q.insert = async (row: Record<string, unknown>) => { inserts.push(row); return insertError && row.kind === "calendar_synced" ? { error: { message: insertError } } : { error: null } }
    return q
  }
  return { db: { from: (t: string) => chain(t) } as never, inserts }
}
const LEAD = { id: "L1", full_name: "Marco Rossi", email: "marco@example.com", claimed_by: null }
const run = (db: never, action: { kind: "set"; at: string } | { kind: "cancel" }, api: FakeGcal) => syncAfterAppointment({ db, teamId: "t", leadId: "L1", actor: "a@x.com", action, api })
const at = "2026-11-03T16:00:00Z"

beforeEach(() => { takers = [{ userId: ROCCO_ID, label: "Rocco", email: ROC }] })

/** book a call and return the history row it wrote, as the next request would read it back */
async function booked(g: FakeGcal) {
  const first = stubDb(LEAD)
  await run(first.db, { kind: "set", at }, g)
  return [{ kind: "calendar_synced", created_at: "2026-11-01T10:00:00Z", data: first.inserts[0].data as Record<string, unknown> }]
}

describe("a cancel no longer needs the seller", () => {
  it("removes the event Marketing wrote even when nobody takes calls any more", async () => {
    const g = new FakeGcal(); const history = await booked(g)
    expect(g.all(ROC)).toHaveLength(1)
    takers = [] // Rocco was taken off "takes calls" after the booking
    const r = await run(stubDb(LEAD, history).db, { kind: "cancel" }, g)
    expect(r).toEqual({ state: "synced" })
    expect(g.all(ROC)).toEqual([])
  })
  it("never removes an event that does not carry this lead's mark", async () => {
    const g = new FakeGcal(); const history = await booked(g)
    g.all(ROC)[0].marketingLeadId = "another-lead"
    takers = []
    expect(await run(stubDb(LEAD, history).db, { kind: "cancel" }, g)).toEqual({ state: "skipped" })
    expect(g.calls("removeEvent")).toEqual([])
  })
  it("when Google cannot be asked, the answer is 'failed' (the call is still on the calendar), not a quiet skip", async () => {
    const g = new FakeGcal(); const history = await booked(g)
    g.fail.add("getEvent")
    const r = await run(stubDb(LEAD, history).db, { kind: "cancel" }, g)
    expect(r.state).toBe("failed"); expect(r.message).toMatch(/still on the seller's calendar/)
    expect(g.all(ROC)).toHaveLength(1)
  })
})

describe("a move never makes a second event next to one it could not see", () => {
  it("if Google cannot be asked about the old event, nothing is written", async () => {
    const g = new FakeGcal(); const history = await booked(g)
    g.fail.add("getEvent")
    const r = await run(stubDb(LEAD, history).db, { kind: "set", at: "2026-11-04T16:00:00Z" }, g)
    expect(r.state).toBe("failed")
    expect(g.calls("createEvent")).toHaveLength(1) // only the first booking's
    expect(g.calls("moveEvent")).toEqual([])
    expect(g.all(ROC)).toHaveLength(1)
  })
  it("a normal move still moves the same event", async () => {
    const g = new FakeGcal(); const history = await booked(g)
    expect(await run(stubDb(LEAD, history).db, { kind: "set", at: "2026-11-04T16:00:00Z" }, g)).toEqual({ state: "synced" })
    expect(g.all(ROC)).toHaveLength(1); expect(g.all(ROC)[0].startMs).toBe(Date.parse("2026-11-04T16:00:00Z"))
  })
})

describe("a booking that cannot reach the seller's calendar says so", () => {
  it("nobody takes calls: a plain failure, not silence", async () => {
    takers = []
    const g = new FakeGcal()
    const r = await run(stubDb(LEAD).db, { kind: "set", at }, g)
    expect(r.state).toBe("failed"); expect(r.message).toMatch(/Nobody is set up to take calls/)
    expect(g.log).toEqual([])
  })
  it("the seller's login is not a company mailbox: a plain failure", async () => {
    takers = [{ userId: ROCCO_ID, label: "Rocco", email: "rocco@gmail.com" }]
    const g = new FakeGcal()
    const r = await run(stubDb(LEAD).db, { kind: "set", at }, g)
    expect(r.state).toBe("failed"); expect(r.message).toMatch(/not a company mailbox/)
    expect(g.log).toEqual([]) // never acts as a personal address
  })
})

describe("the history must be written, or the new event is taken back", () => {
  it("a new event whose id could not be written down is removed again, and the answer is 'failed'", async () => {
    const g = new FakeGcal()
    const { db } = stubDb(LEAD, [], "database down")
    const r = await run(db, { kind: "set", at }, g)
    expect(r.state).toBe("failed"); expect(r.message).toMatch(/could not be recorded/)
    expect(g.all(ROC)).toEqual([]) // no orphan left behind on Rocco's calendar
    expect(g.calls("removeEvent")).toHaveLength(1)
  })
  it("a move of the same event is still a success when the new history row cannot be written (the id did not change)", async () => {
    const g = new FakeGcal(); const history = await booked(g)
    const r = await run(stubDb(LEAD, history, "database down").db, { kind: "set", at: "2026-11-04T16:00:00Z" }, g)
    expect(r).toEqual({ state: "synced" })
    expect(g.all(ROC)).toHaveLength(1)
  })
})

describe("what goes into the seller's calendar", () => {
  it("a lead with no name is 'Lead · Call': an email address is never put in a calendar title", async () => {
    const g = new FakeGcal()
    await run(stubDb({ ...LEAD, full_name: null }).db, { kind: "set", at }, g)
    expect(g.all(ROC)[0].title).toBe("Lead · Call")
  })
})
