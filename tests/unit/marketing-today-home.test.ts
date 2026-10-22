import { describe, it, expect } from "vitest"
import { romeStartOfDay, romeStartOfNextDay, type MasterEvent } from "@/lib/marketing/master-view"
import { todayModel, type TodayLead } from "@/lib/marketing/workspace"

const NOW = new Date("2026-10-21T14:00:00Z")
const H = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString()
const lead = (o: Partial<TodayLead> & { id: string }): TodayLead => ({
  team_id: "t", full_name: o.id, email: null, phone: null, claimed_by: null, callback_at: null, received_at: H(2), meta_created_time: null, existing_client: null, status: "new", ...o,
})
const ev = (lead_id: string, data: Record<string, unknown>, at = H(1), actor = "s@x.com"): MasterEvent => ({ lead_id, kind: "status_changed", actor, data, created_at: at })
const stages = [{ key: "new", label: "New" }, { key: "qualified", label: "Qualified" }, { key: "not_in_target", label: "Not in target" }]
const outcomeStages = { good: "qualified", not_in_target: "not_in_target", call_back: "contacted" }
const run = (leads: TodayLead[], events: MasterEvent[]) => todayModel({ leads, events, members: [], stages, outcomeStages, me: "rocco", now: NOW })

describe("new leads untouched for over a day", () => {
  it("lists only unpicked, unworked, first-stage leads older than 24 h, the oldest first", () => {
    const m = run([
      lead({ id: "fresh", received_at: H(5) }), lead({ id: "old", received_at: H(30) }), lead({ id: "older", received_at: H(80) }),
      lead({ id: "picked", received_at: H(40), claimed_by: "rocco" }), lead({ id: "cb", received_at: H(40), callback_at: H(-3) }), lead({ id: "worked", received_at: H(40), status: "qualified" }),
    ], [])
    expect(m.waitingOver24h.map(l => l.id)).toEqual(["older", "old"])
  })
  it("a meta_created_time (the real arrival) wins over received_at", () => {
    expect(run([lead({ id: "a", received_at: H(2), meta_created_time: H(50) })], []).waitingOver24h.map(l => l.id)).toEqual(["a"])
  })
})

describe("rejected today, for the owner to look over", () => {
  const rej = (id: string, extra: Record<string, unknown> = {}, at = H(1), actor = "s@x.com") => ev(id, { outcome: "not_in_target", reason: "no_budget", note: "no money", ...extra }, at, actor)
  it("lists today's Not-in-target decisions with who, reason and note, for leads still rejected", () => {
    const m = run([lead({ id: "r1", status: "not_in_target" })], [rej("r1")])
    expect(m.rejectedToday).toHaveLength(1)
    expect(m.rejectedToday[0]).toMatchObject({ by: "s@x.com", reason: "no_budget", note: "no money" })
  })
  it("ignores yesterday's, View-as ones, and a lead that is no longer rejected (picked back up)", () => {
    const m = run([lead({ id: "y", status: "not_in_target" }), lead({ id: "v", status: "not_in_target" }), lead({ id: "back", status: "qualified" })],
      [rej("y", {}, H(30)), rej("v", { via_view_as: true }), rej("back")])
    expect(m.rejectedToday).toEqual([])
  })
  it("a lead rejected twice shows once, with the newest decision", () => {
    const m = run([lead({ id: "r", status: "not_in_target" })], [rej("r", { note: "first" }, H(3)), rej("r", { note: "second" }, H(1), "t@x.com")])
    expect(m.rejectedToday).toHaveLength(1)
    expect(m.rejectedToday[0]).toMatchObject({ note: "second", by: "t@x.com" })
  })
  it("no first stage configured -> no 'waiting' list, never a crash", () => {
    const m = todayModel({ leads: [lead({ id: "a" })], events: [], members: [], stages: [], outcomeStages, me: "rocco", now: NOW })
    expect(m.waitingOver24h).toEqual([])
  })
})

import { readPaged } from "@/lib/marketing/paged"

describe("a Rome day is not always 24 hours", () => {
  it("the next day starts 25 h later on the day the clocks go back (2026-10-25) and 23 h later when they go forward (2027-03-28)", () => {
    const back = new Date("2026-10-25T10:00:00Z")
    expect((romeStartOfNextDay(back).getTime() - romeStartOfDay(back).getTime()) / 3600_000).toBe(25)
    const fwd = new Date("2027-03-28T10:00:00Z")
    expect((romeStartOfNextDay(fwd).getTime() - romeStartOfDay(fwd).getTime()) / 3600_000).toBe(23)
    const normal = new Date("2026-10-21T10:00:00Z")
    expect((romeStartOfNextDay(normal).getTime() - romeStartOfDay(normal).getTime()) / 3600_000).toBe(24)
  })
  it("a call back due at 23:30 Rome on the 25-hour day is still 'due today'", () => {
    const now = new Date("2026-10-25T08:00:00Z") // 09:00 Rome (CET)
    const due = new Date("2026-10-25T22:30:00Z").toISOString() // 23:30 Rome
    const m = todayModel({ leads: [lead({ id: "cb", callback_at: due })], events: [], members: [], stages, outcomeStages, me: "rocco", now })
    expect(m.callBacks.map(c => c.lead.id)).toEqual(["cb"])
  })
})

describe("a failed read never looks like an empty one", () => {
  it("readPaged throws when the database reports an error", async () => {
    await expect(readPaged(async () => ({ data: null, error: { message: "statement timeout" } }), 5000)).rejects.toThrow(/statement timeout/)
  })
})
