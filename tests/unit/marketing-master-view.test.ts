import { describe, it, expect } from "vitest"
import { ageText, buildMasterView, romeStartOfDay, romeStartOfMonth, type MasterEvent, type MasterLead, type MasterMember } from "@/lib/marketing/master-view"

const stages = [{ key: "new", label: "New" }, { key: "contacted", label: "Contacted" }, { key: "qualified", label: "Qualified" }, { key: "paid_call", label: "Paid call" }, { key: "not_in_target", label: "Not in target" }]
// Tue 20 Oct 2026, 12:00 UTC = 14:00 in Rome (summer time ended 25 Oct, so still UTC+2)
const NOW = new Date("2026-10-20T12:00:00Z")
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString()
let n = 0
const lead = (o: Partial<MasterLead> = {}): MasterLead => ({ id: `l${++n}`, status: "new", team_id: "T", full_name: `Lead ${n}`, email: null, claimed_by: null, callback_at: null, received_at: hoursAgo(1), meta_created_time: null, existing_client: null, ...o })
const ev = (o: Partial<MasterEvent>): MasterEvent => ({ lead_id: "l1", kind: "status_changed", actor: "chiara@x.com", data: {}, created_at: hoursAgo(1), ...o })
const members: MasterMember[] = [
  { email: "rocco@x.com", role: "owner", bundle: null, status: "active", lastSignInAt: hoursAgo(5) },
  { email: "chiara@x.com", role: "member", bundle: "setter", status: "active", lastSignInAt: hoursAgo(30) },
  { email: "gone@x.com", role: "member", bundle: "setter", status: "removed", lastSignInAt: null },
]
const view = (leads: MasterLead[], events: MasterEvent[] = []) => buildMasterView({ leads, events, members, stages, now: NOW })

describe("Rome day and month", () => {
  it("the Rome day starts at 22:00 UTC the evening before (summer time)", () => {
    expect(romeStartOfDay(NOW).toISOString()).toBe("2026-10-19T22:00:00.000Z")
    expect(romeStartOfMonth(NOW).toISOString()).toBe("2026-09-30T22:00:00.000Z")
  })
  it("after the clocks go back the offset is one hour", () => {
    expect(romeStartOfDay(new Date("2026-10-27T12:00:00Z")).toISOString()).toBe("2026-10-26T23:00:00.000Z")
  })
  it("a time just after Rome midnight belongs to the new Rome day", () => {
    expect(romeStartOfDay(new Date("2026-10-19T22:30:00Z")).toISOString()).toBe("2026-10-19T22:00:00.000Z")
    expect(romeStartOfDay(new Date("2026-10-19T21:30:00Z")).toISOString()).toBe("2026-10-18T22:00:00.000Z")
  })
})

describe("counts", () => {
  it("new in the last 24 hours uses Meta's time when there is one", () => {
    const v = view([lead({ received_at: hoursAgo(2) }), lead({ received_at: hoursAgo(30) }), lead({ received_at: hoursAgo(1), meta_created_time: hoursAgo(40) })])
    expect(v.newLast24h).toBe(1)
  })
  it("untouched = still New, nobody picked it, older than a day; the oldest age is reported", () => {
    const v = view([lead({ received_at: hoursAgo(30) }), lead({ received_at: hoursAgo(80) }), lead({ received_at: hoursAgo(30), claimed_by: "u" }), lead({ received_at: hoursAgo(30), status: "contacted" }), lead({ received_at: hoursAgo(5) })])
    expect(v.untouchedOver24h).toBe(2)
    expect(v.oldestUntouchedMs).toBe(80 * 3600_000)
    expect(v.needs[0].text).toBe("2 leads untouched for over a day (oldest: 3 d)")
  })
  it("call backs due today include the overdue ones and exclude tomorrow's", () => {
    const at = (h: number) => new Date(NOW.getTime() + h * 3600_000).toISOString()
    const v = view([lead({ callback_at: at(-2) }), lead({ callback_at: at(3) }), lead({ callback_at: at(20) }), lead({ callback_at: null })])
    expect(v.callBacksDueToday).toBe(2)
    expect(v.needs.find(x => x.key === "late_callbacks")?.text).toMatch(/^Call back with Lead \d+ is 2 h late$/)
  })
  it("paid calls this month count each lead once, from the history", () => {
    const v = view([lead()], [ev({ lead_id: "a", data: { to: "paid_call" }, created_at: hoursAgo(10) }), ev({ lead_id: "a", data: { to: "paid_call" }, created_at: hoursAgo(5) }), ev({ lead_id: "b", data: { to: "paid_call" }, created_at: "2026-09-01T00:00:00Z" })])
    expect(v.paidCallsThisMonth).toBe(1)
  })
  it("the funnel follows the pipeline order, and a stage that no longer exists shows as Other", () => {
    const v = view([lead(), lead(), lead({ status: "qualified" }), lead({ status: "retired_stage" })])
    expect(v.funnel.map(f => `${f.key}:${f.count}`)).toEqual(["new:2", "contacted:0", "qualified:1", "paid_call:0", "not_in_target:0", "_other:1"])
  })
  it("with no leads every number is zero and nothing is flagged", () => {
    const v = view([])
    expect(v).toMatchObject({ newLast24h: 0, untouchedOver24h: 0, oldestUntouchedMs: null, callBacksDueToday: 0, paidCallsThisMonth: 0, needs: [] })
  })
})

describe("needs you", () => {
  it("flags leads with no team and likely existing clients, and a failed client check", () => {
    const v = view([lead({ team_id: null }), lead({ full_name: "Anna Vitale", existing_client: { contact_ids: ["c1"] } }), lead({ full_name: "Odd", existing_client: { check_failed: true } })])
    const t = v.needs.map(x => x.text)
    expect(t).toContain("1 lead that arrived with no team")
    expect(t).toContain("Anna Vitale looks like an existing client")
    expect(t).toContain("Odd could not be checked against TD clients")
  })
  it("an explicit count of team-less leads wins over counting the list", () => {
    const v = buildMasterView({ leads: [lead()], events: [], members, stages, now: NOW, unassignedCount: 3 })
    expect(v.needs.map(x => x.text)).toContain("3 leads that arrived with no team")
  })
  it("an existing client already worked (not New any more) is not flagged again", () => {
    expect(view([lead({ status: "contacted", existing_client: { contact_ids: ["c1"] } })]).needs).toEqual([])
  })
  it("late call backs show at most three names and then a count", () => {
    const old = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString()
    const v = view([1, 2, 3, 4, 5].map(h => lead({ callback_at: old(h) })))
    expect(v.needs.filter(x => x.key === "late_callbacks")).toHaveLength(4)
    expect(v.needs.at(-1)?.text).toBe("2 more call backs are late")
  })
})

describe("people", () => {
  it("counts today's outcomes per person by the email on the history row, ignores yesterday and removed people", () => {
    const v = view([lead()], [
      ev({ data: { outcome: "good" } }), ev({ data: { outcome: "good" } }), ev({ data: { outcome: "not_in_target" } }), ev({ data: { outcome: "call_back" } }),
      ev({ kind: "claimed", actor: "rocco@x.com" }), ev({ data: { outcome: "good" }, created_at: hoursAgo(20) }),
    ])
    const chiara = v.people.find(p => p.email === "chiara@x.com")!
    expect(chiara).toMatchObject({ role: "setter", good: 2, notInTarget: 1, callBacks: 1, picked: 0 })
    expect(v.people.find(p => p.email === "rocco@x.com")).toMatchObject({ role: "Owner", picked: 1, good: 0 })
    expect(v.people.some(p => p.email === "gone@x.com")).toBe(false)
  })
  it("last active is the later of his last action and his last sign-in", () => {
    const v = view([lead()], [ev({ created_at: hoursAgo(3) })])
    expect(v.people.find(p => p.email === "chiara@x.com")?.lastActive).toBe(hoursAgo(3))
    expect(v.people.find(p => p.email === "rocco@x.com")?.lastActive).toBe(hoursAgo(5))
  })
})

describe("ageText", () => {
  it("says minutes, hours, days", () => {
    expect(ageText(30_000)).toBe("1 min")
    expect(ageText(25 * 60_000)).toBe("25 min")
    expect(ageText(5 * 3600_000)).toBe("5 h")
    expect(ageText(47 * 3600_000)).toBe("47 h")
    expect(ageText(72 * 3600_000)).toBe("3 d")
  })
})
