import { describe, it, expect } from "vitest"
import { buildAgenda, callBackOwner, latestSetters, relativeDay, type CalEvent, type CalLead, type CalMember } from "@/lib/marketing/calendar"
import { modulesFor } from "@/lib/marketing/workspace"

const NOW = new Date("2026-10-22T10:00:00Z") // 12:00 in Rome (CEST)
const at = (h: number) => new Date(NOW.getTime() + h * 3600_000).toISOString()
const members: CalMember[] = [
  { user_id: "u-chiara", email: "chiara.neri@x.com" }, { user_id: "u-marco", email: "Marco.Bianchi@x.com" }, { user_id: "u-rocco", email: "rocco@x.com" },
  { user_id: "u-gone", email: "gone@x.com", status: "removed" },
]
const lead = (id: string, o: Partial<CalLead> = {}): CalLead => ({ id, full_name: id, email: null, ad_name: "Ad Alpha", claimed_by: null, callback_at: at(2), ...o })
const ev = (lead_id: string, actor: string, created_at = at(-5), data: Record<string, unknown> = {}): CalEvent => ({ lead_id, actor, created_at, data: { outcome: "call_back", ...data } })

describe("who owns a call back", () => {
  it("the person who set it (by the email in the history), matched without regard to capital letters", () => {
    expect(callBackOwner({ claimed_by: null }, "chiara.neri@x.com", members)).toBe("u-chiara")
    expect(callBackOwner({ claimed_by: null }, "marco.bianchi@x.com", members)).toBe("u-marco")
  })
  it("whoever picked the lead since, if somebody did", () => {
    expect(callBackOwner({ claimed_by: "u-rocco" }, "chiara.neri@x.com", members)).toBe("u-rocco")
  })
  it("nobody when the setter is not on the team (Antonio looking in), or was removed, or the history has no row", () => {
    expect(callBackOwner({ claimed_by: null }, "antonio@x.com", members)).toBeNull()
    expect(callBackOwner({ claimed_by: null }, "gone@x.com", members)).toBeNull()
    expect(callBackOwner({ claimed_by: null }, null, members)).toBeNull()
  })
  it("the setter is the actor of the NEWEST call back row (a View-as row included: if Antonio changed the time, it is his); other outcomes are ignored", () => {
    const s = latestSetters([
      ev("l1", "chiara.neri@x.com", "2026-10-21T09:00:00Z"), ev("l1", "marco.bianchi@x.com", "2026-10-21T10:00:00Z"),
      ev("l1", "antonio@x.com", "2026-10-21T11:00:00Z", { via_view_as: true }), ev("l1", "rocco@x.com", "2026-10-21T12:00:00Z", { outcome: "good" }),
    ])
    expect(s.get("l1")?.actor).toBe("antonio@x.com")
    expect(latestSetters([ev("l1", "antonio@x.com", "2026-10-21T11:00:00Z", { via_view_as: true }), ev("l1", "chiara.neri@x.com", "2026-10-21T12:00:00Z")]).get("l1")?.actor).toBe("chiara.neri@x.com")
  })
  it("a call back changed by Antonio while looking in is not attributed to the earlier setter", () => {
    const l = [lead("v")]
    const e = [ev("v", "chiara.neri@x.com", "2026-10-21T09:00:00Z"), ev("v", "antonio@x.com", "2026-10-21T10:00:00Z", { via_view_as: true })]
    expect(buildAgenda({ leads: l, events: e, members, ownerId: "u-chiara", now: NOW, days: 14 }).days).toEqual([])
    const all = buildAgenda({ leads: l, events: e, members, ownerId: "all", now: NOW, days: 14 })
    expect(all.days[0].items[0]).toMatchObject({ setBy: "Antonio", setByMember: false })
  })
  it("no history row at all: the item exists for Everyone, with no setter named and not attributed to anyone", () => {
    const all = buildAgenda({ leads: [lead("n")], events: [], members, ownerId: "all", now: NOW, days: 14 })
    expect(all.days[0].items[0]).toMatchObject({ setBy: null, setByMember: false, ownerId: null })
  })
  it("a very long late list shows the most overdue 50 and counts the rest", () => {
    const many = Array.from({ length: 60 }, (_, k) => lead(`m${k}`, { callback_at: at(-1 - k) }))
    const a = buildAgenda({ leads: many, events: [], members, ownerId: "all", now: NOW, days: 14 })
    expect(a.late).toHaveLength(50)
    expect(a.lateMore).toBe(10)
  })
})

describe("the agenda", () => {
  const leads = [lead("late1", { callback_at: at(-3) }), lead("a", { callback_at: at(2) }), lead("b", { callback_at: at(1) }), lead("tmrw", { callback_at: at(20) }), lead("far", { callback_at: at(24 * 20) }), lead("none", { callback_at: null })]
  const events = [ev("late1", "chiara.neri@x.com"), ev("a", "chiara.neri@x.com"), ev("b", "marco.bianchi@x.com"), ev("tmrw", "marco.bianchi@x.com"), ev("far", "chiara.neri@x.com")]
  it("everyone: late first, then each day in order, earliest first; leads with no call back and the far future are not listed (the far ones are counted)", () => {
    const a = buildAgenda({ leads, events, members, ownerId: "all", now: NOW, days: 14 })
    expect(a.late.map(i => i.leadId)).toEqual(["late1"])
    expect(a.days.map(d => d.label)).toEqual(["Today · Thu 22 Oct", "Tomorrow · Fri 23 Oct"])
    expect(a.days[0].items.map(i => i.leadId)).toEqual(["b", "a"])
    expect(a.beyond).toBe(1)
    expect(a.late[0].late).toBe(true)
  })
  it("a person sees only her own: another person's call backs are not in what is returned at all", () => {
    const a = buildAgenda({ leads, events, members, ownerId: "u-chiara", now: NOW, days: 14 })
    expect([...a.late, ...a.days.flatMap(d => d.items)].map(i => i.leadId).sort()).toEqual(["a", "late1"])
  })
  it("the far one is hers and beyond the window, so it is counted for her", () => {
    expect(buildAgenda({ leads, events, members, ownerId: "u-chiara", now: NOW, days: 14 }).beyond).toBe(1)
  })
  it("a wider window brings the far one in", () => {
    const a = buildAgenda({ leads, events, members, ownerId: "all", now: NOW, days: 30 })
    expect(a.days.some(d => d.items.some(i => i.leadId === "far"))).toBe(true)
    expect(a.beyond).toBe(0)
  })
  it("a call back set by a setter and then picked by Rocco is Rocco's, not hers", () => {
    const l = [lead("p", { claimed_by: "u-rocco" })]
    const e = [ev("p", "chiara.neri@x.com")]
    expect(buildAgenda({ leads: l, events: e, members, ownerId: "u-chiara", now: NOW, days: 14 }).days).toEqual([])
    expect(buildAgenda({ leads: l, events: e, members, ownerId: "u-rocco", now: NOW, days: 14 }).days).toHaveLength(1)
  })
  it("a call back whose setter is outside the team shows in Everyone only, with no setter name guessed", () => {
    const l = [lead("o")]
    const e = [ev("o", "antonio@x.com")]
    expect(buildAgenda({ leads: l, events: e, members, ownerId: "u-chiara", now: NOW, days: 14 }).days).toEqual([])
    const all = buildAgenda({ leads: l, events: e, members, ownerId: "all", now: NOW, days: 14 })
    expect(all.days[0].items[0]).toMatchObject({ ownerId: null, setBy: "Antonio" })
  })
  it("late rows carry their date and how late they are", () => {
    const a = buildAgenda({ leads: [lead("x", { callback_at: at(-3) }), lead("y", { callback_at: at(-50) })], events: [], members, ownerId: "all", now: NOW, days: 14 })
    expect(a.late.map(i => [i.leadId, i.lateBy])).toEqual([["y", "2 d late"], ["x", "3 h late"]])
    expect(a.late[0].dateLabel).toBe("Tue 20 Oct")
    expect(a.days).toEqual([])
  })
  it("times are Rome times", () => {
    const a = buildAgenda({ leads: [lead("t", { callback_at: "2026-10-22T13:30:00Z" })], events: [], members, ownerId: "all", now: NOW, days: 14 })
    expect(a.days[0].items[0].time).toBe("15:30")
  })
})

describe("days around midnight and the clock change", () => {
  it("23:30 and 00:10 Rome on the 25-hour day (Sun 25 Oct 2026) are different days", () => {
    const now = new Date("2026-10-24T20:00:00Z") // Sat 22:00 Rome
    const l = [lead("sun", { callback_at: "2026-10-25T22:30:00Z" }), lead("mon", { callback_at: "2026-10-25T23:10:00Z" })] // 23:30 CET Sun, 00:10 CET Mon
    const a = buildAgenda({ leads: l, events: [], members, ownerId: "all", now, days: 14 })
    expect(a.days.map(d => d.label)).toEqual(["Tomorrow · Sun 25 Oct", "Mon 26 Oct"])
  })
  it("'Today' and 'Tomorrow' follow the Rome date, not UTC", () => {
    const now = new Date("2026-10-22T22:30:00Z") // 00:30 Rome on Fri 23
    expect(relativeDay(new Date("2026-10-23T08:00:00Z"), now)).toBe("Today · Fri 23 Oct")
    expect(relativeDay(new Date("2026-10-24T08:00:00Z"), now)).toBe("Tomorrow · Sat 24 Oct")
  })
})

describe("the menu", () => {
  it("Calendar is offered to people who work the call list, who pick leads, or who see the team's activity; not to the ad person", () => {
    const has = (p: string[]) => modulesFor(p).some(m => m.key === "calendar")
    expect(has(["leads.read", "leads.worklist"])).toBe(true)
    expect(has(["leads.read", "leads.pick"])).toBe(true)
    expect(has(["leads.read", "team.activity"])).toBe(true)
    expect(has(["leads.read", "reports.read", "inbox", "chat"])).toBe(false)
  })
})
