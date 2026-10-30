import { describe, it, expect, vi, beforeEach } from "vitest"
import { timePrefsFrom } from "@/lib/marketing/time-prefs"
import { FakeGcal } from "./helpers/fake-gcal"

const ROC = "rocco@tonydurante.us"
const ROCCO_ID = "22222222-2222-4222-8222-222222222222"
let prefsOn = true
vi.mock("@/lib/marketing/time-prefs-server", () => ({
  loadPrefsAndTakers: async () => ({
    prefs: timePrefsFrom({ member_call_hours: { [ROCCO_ID]: { slot: 45 } }, member_time_zones: { [ROCCO_ID]: "Atlantic/Canary" }, calendar_write_through_enabled: prefsOn } as Parameters<typeof timePrefsFrom>[0]),
    takers: [{ userId: ROCCO_ID, label: "Rocco", email: ROC }], rows: [],
  }),
}))
import { syncAfterAppointment } from "@/lib/marketing/call-sync-server"

/** A tiny stand-in for the database: one lead, and the history rows written. */
function stubDb(lead: Record<string, unknown> | null, history: Array<Record<string, unknown>> = []) {
  const inserts: Array<Record<string, unknown>> = []
  const chain = (table: string) => {
    const q: Record<string, unknown> = {}
    for (const m of ["select", "eq", "order", "limit"]) q[m] = () => q
    q.maybeSingle = async () => ({ data: table === "marketing_leads" ? lead : null })
    q.then = (res: (v: unknown) => void) => res({ data: table === "marketing_lead_events" ? history : [] })
    q.insert = async (row: Record<string, unknown>) => { inserts.push(row); return { error: null } }
    return q
  }
  return { db: { from: (t: string) => chain(t) } as never, inserts }
}

beforeEach(() => { prefsOn = true })

describe("after a call is booked: write it into the seller's calendar (switch on)", () => {
  it("does nothing while the switch is off", async () => {
    prefsOn = false
    const g = new FakeGcal(); const { db, inserts } = stubDb({ id: "L1", full_name: "Marco Rossi", claimed_by: null })
    expect(await syncAfterAppointment({ db, teamId: "t", leadId: "L1", actor: "setter@x.com", action: { kind: "set", at: "2026-11-03T16:00:00Z" }, api: g })).toEqual({ state: "skipped" })
    expect(g.log).toEqual([]); expect(inserts).toEqual([])
  })
  it("writes the event with the seller's call length and remembers its id in the lead's history", async () => {
    const g = new FakeGcal(); const { db, inserts } = stubDb({ id: "L1", full_name: "Marco Rossi", claimed_by: null })
    expect(await syncAfterAppointment({ db, teamId: "t", leadId: "L1", actor: "setter@x.com", action: { kind: "set", at: "2026-11-03T16:00:00Z" }, api: g })).toEqual({ state: "synced" })
    const ev = g.all(ROC)[0]
    expect(ev).toMatchObject({ title: "Marco · Call", marketingLeadId: "L1", startMs: Date.parse("2026-11-03T16:00:00Z"), endMs: Date.parse("2026-11-03T16:45:00Z") })
    expect(inserts).toMatchObject([{ lead_id: "L1", kind: "calendar_synced", actor: "setter@x.com", data: { event_id: ev.id, act_as: ROC, calendar_id: "primary", removed: false } }])
  })
  it("a cancel removes the event it wrote and says so in the history", async () => {
    const g = new FakeGcal(); const first = stubDb({ id: "L1", full_name: "Marco Rossi", claimed_by: null })
    await syncAfterAppointment({ db: first.db, teamId: "t", leadId: "L1", actor: "a@x.com", action: { kind: "set", at: "2026-11-03T16:00:00Z" }, api: g })
    const wrote = first.inserts[0]
    const second = stubDb({ id: "L1", full_name: "Marco Rossi", claimed_by: null }, [{ kind: "calendar_synced", created_at: "2026-11-01T10:00:00Z", data: wrote.data as Record<string, unknown> }])
    expect(await syncAfterAppointment({ db: second.db, teamId: "t", leadId: "L1", actor: "a@x.com", action: { kind: "cancel" }, api: g })).toEqual({ state: "synced" })
    expect(g.all(ROC)).toEqual([])
    expect(second.inserts[0]).toMatchObject({ kind: "calendar_synced", data: { event_id: null, removed: true } })
  })
  it("when Google refuses, the answer is 'failed' with the reason, and it is written in the history", async () => {
    const g = new FakeGcal(); g.fail.add("createEvent"); const { db, inserts } = stubDb({ id: "L1", full_name: "Marco Rossi", claimed_by: null })
    const r = await syncAfterAppointment({ db, teamId: "t", leadId: "L1", actor: "a@x.com", action: { kind: "set", at: "2026-11-03T16:00:00Z" }, api: g })
    expect(r.state).toBe("failed"); expect(r.message).toMatch(/fake createEvent failed/)
    expect(inserts).toMatchObject([{ kind: "calendar_sync_failed", data: { message: expect.stringContaining("failed") } }])
  })
  it("a lead that cannot be found is skipped, not an error", async () => {
    const g = new FakeGcal(); const { db } = stubDb(null)
    expect(await syncAfterAppointment({ db, teamId: "t", leadId: "nope", actor: "a@x.com", action: { kind: "cancel" }, api: g })).toEqual({ state: "skipped" })
  })
})
