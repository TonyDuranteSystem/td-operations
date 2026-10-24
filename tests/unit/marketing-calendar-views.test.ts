import { describe, it, expect } from "vitest"
import {
  BUCKETS, HOUR_FROM, HOUR_TO, addDays, bucketDrop, bucketOf, layoutDay, monthGrid, moveToDay, romeLocalValue, romeParts, shiftMonth, slotIso, timeFromFraction, weekDays, weekStart, weekdayIndex,
} from "@/lib/marketing/calendar-grid"
import { calendarItems, CALENDAR_LATE_CAP, type CalAppointment, type CalLead } from "@/lib/marketing/calendar"
import { planLeadAction, leadActionSchema, permissionFor, type ActionSettings, type Actor } from "@/lib/marketing/lead-actions"
import { rescheduleRecipients, reschedulePush } from "@/lib/marketing/calendar-notify"
import { eventText } from "@/lib/marketing/lead-view"
import { redactTimeline } from "@/lib/marketing/lead-privacy"

// Monday 26 Oct 2026, 09:00 in Rome (CET after the clock change on 25 Oct = 08:00Z)
const NOW = "2026-10-26T08:00:00.000Z"

describe("calendar grid: Rome days and times", () => {
  it("reads the Rome day and wall clock of an instant, in summer and winter time", () => {
    expect(romeParts("2026-10-26T08:00:00Z")).toEqual({ key: "2026-10-26", h: 9, m: 0 })
    expect(romeParts("2026-07-01T22:30:00Z")).toEqual({ key: "2026-07-02", h: 0, m: 30 })
    expect(romeParts("nonsense")).toBeNull()
  })
  it("weeks start on Monday; a month shows six whole weeks", () => {
    expect(weekdayIndex("2026-10-26")).toBe(0)
    expect(weekdayIndex("2026-11-01")).toBe(6)
    expect(weekStart("2026-10-29")).toBe("2026-10-26")
    expect(weekDays("2026-10-28")).toEqual(["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"])
    const m = monthGrid("2026-10-15")
    expect(m).toHaveLength(42)
    expect(m[0]).toBe("2026-09-28")
    expect(m[41]).toBe("2026-11-08")
  })
  it("adding days and months crosses month ends and keeps a day number that fits", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01")
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28")
    expect(shiftMonth("2026-01-31", 1)).toBe("2026-02-28")
    expect(shiftMonth("2026-12-15", 1)).toBe("2027-01-15")
    expect(shiftMonth("2026-01-15", -1)).toBe("2025-12-15")
  })
  it("a time on a day becomes the real instant, and the same time of day can move to another day", () => {
    expect(slotIso("2026-10-27", 11, 0)).toBe("2026-10-27T10:00:00.000Z")
    expect(moveToDay("2026-10-26T10:30:00.000Z", "2026-10-28")).toBe("2026-10-28T10:30:00.000Z")
    expect(romeLocalValue("2026-10-27T10:00:00.000Z")).toBe("2026-10-27T11:00")
    expect(moveToDay("nonsense", "2026-10-28")).toBeNull()
  })
  it("a drop on the hour grid snaps to 15 minutes and never leaves the grid", () => {
    expect(timeFromFraction(0)).toEqual({ h: HOUR_FROM, m: 0 })
    expect(timeFromFraction(1)).toEqual({ h: HOUR_TO - 1, m: 45 })
    expect(timeFromFraction(-5)).toEqual({ h: HOUR_FROM, m: 0 })
    expect(timeFromFraction(((13 - HOUR_FROM) * 60 + 10) / ((HOUR_TO - HOUR_FROM) * 60))).toEqual({ h: 13, m: 15 })
  })
})

describe("pipeline groups", () => {
  it("a call is Late, Today, Tomorrow, This week (up to Sunday) or Later", () => {
    expect(bucketOf("2026-10-26T07:59:00Z", NOW)).toBe("late")
    expect(bucketOf("2026-10-26T10:00:00Z", NOW)).toBe("today")
    expect(bucketOf("2026-10-27T10:00:00Z", NOW)).toBe("tomorrow")
    expect(bucketOf("2026-10-28T10:00:00Z", NOW)).toBe("week")
    expect(bucketOf("2026-11-01T10:00:00Z", NOW)).toBe("week")
    expect(bucketOf("2026-11-02T10:00:00Z", NOW)).toBe("later")
    expect(bucketOf("nonsense", NOW)).toBeNull()
    expect(BUCKETS).toEqual(["late", "today", "tomorrow", "week", "later"])
  })
  it("on a Sunday, Tomorrow is the Monday after and This week is empty", () => {
    const sunday = "2026-11-01T09:00:00.000Z"
    expect(bucketOf("2026-11-02T09:00:00Z", sunday)).toBe("tomorrow")
    expect(bucketOf("2026-11-03T09:00:00Z", sunday)).toBe("later")
  })
  it("dropping on Today or Tomorrow keeps the time of day; a time already past today becomes the next full hour; Late refuses; This week and Later ask for a day", () => {
    expect(bucketDrop("tomorrow", "2026-10-30T14:30:00Z", NOW)).toEqual({ kind: "move", at: "2026-10-27T14:30:00.000Z" })
    expect(bucketDrop("today", "2026-10-30T14:30:00Z", NOW)).toEqual({ kind: "move", at: "2026-10-26T14:30:00.000Z" })
    expect(bucketDrop("today", "2026-10-30T07:00:00Z", NOW)).toEqual({ kind: "move", at: "2026-10-26T09:00:00.000Z" })
    expect(bucketDrop("late", "2026-10-30T14:30:00Z", NOW)).toEqual({ kind: "refuse" })
    // after 23:00 Rome there is no hour left today: the person chooses, starting tomorrow
    expect(bucketDrop("today", "2026-10-30T14:30:00Z", "2026-10-26T22:30:00.000Z")).toEqual({ kind: "choose", suggest: "2026-10-27T14:30:00.000Z" })
    expect(bucketDrop("week", "2026-11-05T14:30:00Z", NOW)).toEqual({ kind: "choose", suggest: "2026-10-28T14:30:00.000Z" })
    expect(bucketDrop("later", "2026-10-27T14:30:00Z", NOW)).toEqual({ kind: "choose", suggest: "2026-11-03T14:30:00.000Z" })
  })
})

describe("calls that start close together sit side by side", () => {
  it("a lone call takes the whole width; two at the same time share it; a later call is alone again; calls outside the grid are left out", () => {
    const p = layoutDay([{ h: 9, m: 0 }, { h: 9, m: 0 }, { h: 15, m: 0 }, { h: 6, m: 0 }, { h: 22, m: 0 }])
    expect(p).toHaveLength(3)
    const at = (i: number) => p.find(x => x.index === i)!
    expect([at(0).lanes, at(1).lanes]).toEqual([2, 2])
    expect(new Set([at(0).lane, at(1).lane]).size).toBe(2)
    expect(at(2)).toMatchObject({ lane: 0, lanes: 1, top: 15 - HOUR_FROM })
  })
  it("two calls half an hour apart overlap; two an hour apart do not", () => {
    expect(layoutDay([{ h: 10, m: 0 }, { h: 10, m: 30 }]).map(x => x.lanes)).toEqual([2, 2])
    expect(layoutDay([{ h: 10, m: 0 }, { h: 11, m: 0 }]).map(x => x.lanes)).toEqual([1, 1])
  })
})

const lead = (id: string, over: Partial<CalLead> = {}): CalLead => ({ id, full_name: `Lead ${id}`, email: null, ad_name: null, claimed_by: null, callback_at: null, status: "contacted", ...over })
const members = [{ user_id: "u-setter", email: "cristina@x.com" }, { user_id: "u-seller", email: "rocco@x.com" }]

describe("calendar items", () => {
  it("a past call back is late, a past booked call is done (or paid), a future one is booked", () => {
    const leads = [lead("a", { callback_at: "2026-10-20T10:00:00Z" }), lead("b", { callback_at: "2026-10-28T10:00:00Z" })]
    const appointments: CalAppointment[] = [
      { lead: lead("c"), at: "2026-10-30T10:00:00Z", actor: "cristina@x.com" },
      { lead: lead("d"), at: "2026-10-21T10:00:00Z", actor: "cristina@x.com" },
      { lead: lead("e", { status: "paid_call" }), at: "2026-10-22T10:00:00Z", actor: "cristina@x.com" },
    ]
    const events = [{ lead_id: "a", actor: "cristina@x.com", created_at: "2026-10-19T10:00:00Z", data: { outcome: "call_back" } }]
    const { items } = calendarItems({ leads, events, members, ownerId: "all", now: new Date(NOW), appointments })
    const by = Object.fromEntries(items.map(i => [i.leadId, i]))
    expect(by.a).toMatchObject({ kind: "callback", late: true, done: false, stage: "back", setBy: "Cristina" })
    expect(by.b).toMatchObject({ late: false, stage: "back" })
    expect(by.c).toMatchObject({ kind: "appointment", done: false, stage: "booked" })
    expect(by.d).toMatchObject({ done: true, stage: "done" })
    expect(by.e).toMatchObject({ done: true, stage: "paid" })
  })
  it("a call back is hidden once a call is booked at or after it (it was answered), but shown when the booked call comes BEFORE it", () => {
    const a = (id: string, at: string): CalAppointment => ({ lead: lead(id), at, actor: "cristina@x.com" })
    const leads = [lead("x", { callback_at: "2026-10-28T10:00:00Z" }), lead("y", { callback_at: "2026-10-28T10:00:00Z" }), lead("z", { callback_at: "2026-10-20T10:00:00Z" })]
    const { items } = calendarItems({ leads, events: [], members, ownerId: "all", now: new Date(NOW), appointments: [a("x", "2026-10-30T10:00:00Z"), a("y", "2026-10-27T10:00:00Z"), a("z", "2026-10-29T10:00:00Z")] })
    const cb = items.filter(i => i.kind === "callback").map(i => i.leadId).sort()
    expect(cb).toEqual(["y"])
  })
  it("a person sees only her own calls; the old backlog of late call backs is capped and the rest counted", () => {
    const leads = Array.from({ length: CALENDAR_LATE_CAP + 20 }, (_, i) => lead(`l${i}`, { callback_at: new Date(Date.parse("2026-01-01T10:00:00Z") + i * 3600_000).toISOString(), claimed_by: "u-seller" }))
    const { items, lateMore } = calendarItems({ leads, events: [], members, ownerId: "all", now: new Date(NOW) })
    expect(items).toHaveLength(CALENDAR_LATE_CAP)
    expect(lateMore).toBe(20)
    expect(items[0].leadId).toBe("l20")
    expect(calendarItems({ leads, events: [], members, ownerId: "u-setter", now: new Date(NOW) }).items).toHaveLength(0)
  })
})

const settings: ActionSettings = {
  stages: [{ key: "new", label: "New" }, { key: "contacted", label: "Contacted" }, { key: "booked", label: "Booked" }, { key: "qualified", label: "Qualified" }, { key: "not_in_target", label: "Not in target" }],
  reasons: [], checklist: [], outcomeStages: { good: "qualified", not_in_target: "not_in_target", call_back: "contacted" },
}
const nowDate = new Date(NOW)
const setter: Actor = { id: "u-setter", email: "cristina@x.com", role: "member" }
// what stands on the lead: a booked call, and/or a call back at the call back stage
const withAppt = { claimed_by: null, status: "contacted", appointment_at: "2026-10-27T10:00:00.000Z" }
const withCb = { claimed_by: null, status: "contacted", callback_at: "2026-10-27T10:00:00.000Z" }
const owner: Actor = { id: "u-owner", email: "antonio@x.com", role: "owner" }

describe("moving a call: the reschedule action", () => {
  it("a reason is required (the schema refuses an empty one) and the right to mark leads is enough", () => {
    expect(leadActionSchema.safeParse({ action: "reschedule", target: "appointment", at: "2026-10-28T10:00:00Z", reason: "" }).success).toBe(false)
    expect(leadActionSchema.safeParse({ action: "reschedule", target: "appointment", at: "2026-10-28T10:00:00Z", reason: "   " }).success).toBe(false)
    expect(leadActionSchema.safeParse({ action: "reschedule", target: "nothing", at: "2026-10-28T10:00:00Z", reason: "x" }).success).toBe(false)
    expect(leadActionSchema.safeParse({ action: "reschedule", target: "callback", at: "2026-10-28T10:00:00Z", reason: "The lead asked to move" }).success).toBe(true)
    expect(permissionFor("reschedule")).toBe("leads.mark")
  })
  it("a booked call is written as a new booking row that says it was moved, why, and from when", () => {
    const p = planLeadAction({ action: "reschedule", target: "appointment", at: "2026-10-28T10:00:00Z", reason: "The seller is not available", from: "2026-10-27T10:00:00Z" }, withAppt, setter, settings, nowDate)
    expect(p).toMatchObject({ ok: true, change: { patch: { status: "booked" }, event: { kind: "appointment", data: { at: "2026-10-28T10:00:00.000Z", from: "2026-10-27T10:00:00.000Z", reason: "The seller is not available", rescheduled: true } } } })
  })
  it("a call back moves ONLY its time: the stage is never touched, and the history row is its own kind (so no counter reads it as a new call back)", () => {
    const p = planLeadAction({ action: "reschedule", target: "callback", at: "2026-10-28T10:00:00Z", reason: "The lead did not answer" }, withCb, setter, settings, nowDate)
    expect(p).toMatchObject({ ok: true, change: { patch: { callback_at: "2026-10-28T10:00:00.000Z" }, event: { kind: "callback_moved", data: { reason: "The lead did not answer", rescheduled: true } } } })
    if (p.ok) expect(p.change.patch).not.toHaveProperty("status")
  })
  it("a call that no longer stands cannot be moved: no booking (never booked, or cancelled), a booking that already took place, a lead that is Booked/Paid/Not in target (no call back), a stale page", () => {
    const mv = (target: "appointment" | "callback", facts: object, extra: object = {}) => planLeadAction({ action: "reschedule", target, at: "2026-10-28T10:00:00Z", reason: "x", ...extra }, { claimed_by: null, status: "contacted", ...facts }, setter, settings, nowDate)
    expect(mv("appointment", {})).toMatchObject({ ok: false, status: 409 })
    expect(mv("appointment", { appointment_at: null })).toMatchObject({ ok: false, status: 409 })
    expect(mv("appointment", { appointment_at: "2026-10-20T10:00:00.000Z" })).toMatchObject({ ok: false, status: 409 })
    expect(mv("appointment", { appointment_at: "2026-10-27T10:00:00.000Z" }, { from: "2026-10-27T11:00:00.000Z" })).toMatchObject({ ok: false, status: 409 })
    expect(mv("appointment", { appointment_at: "2026-10-27T10:00:00.000Z" }, { from: "2026-10-27T10:00:30.000Z" }).ok).toBe(true)
    expect(mv("callback", {})).toMatchObject({ ok: false, status: 409 })
    expect(mv("callback", { callback_at: "2026-10-27T10:00:00.000Z", status: "booked" })).toMatchObject({ ok: false, status: 409 })
    expect(mv("callback", { callback_at: "2026-10-27T10:00:00.000Z", status: "not_in_target" })).toMatchObject({ ok: false, status: 409 })
    expect(mv("callback", { callback_at: "2026-10-27T10:00:00.000Z" }, { from: "2026-10-29T10:00:00.000Z" })).toMatchObject({ ok: false, status: 409 })
  })
  it("'Other' needs a few words on the server too, and a bare date without a time is refused", () => {
    expect(planLeadAction({ action: "reschedule", target: "appointment", at: "2026-10-28T10:00:00Z", reason: "Other" }, withAppt, setter, settings, nowDate)).toMatchObject({ ok: false, status: 400 })
    expect(planLeadAction({ action: "reschedule", target: "appointment", at: "2026-10-28T10:00:00Z", reason: "Other", note: "he travels" }, withAppt, setter, settings, nowDate).ok).toBe(true)
    expect(planLeadAction({ action: "reschedule", target: "appointment", at: "2026-10-28", reason: "x" }, withAppt, setter, settings, nowDate)).toMatchObject({ ok: false, status: 400 })
  })
  it("both the setter and the seller work the same call: a lead someone else picked can still be moved, while other actions stay locked", () => {
    const picked = { claimed_by: "u-seller", status: "booked", appointment_at: "2026-10-27T10:00:00.000Z" }
    expect(planLeadAction({ action: "reschedule", target: "appointment", at: "2026-10-28T10:00:00Z", reason: "x" }, picked, setter, settings, nowDate).ok).toBe(true)
    expect(planLeadAction({ action: "note", note: "hello" }, picked, setter, settings, nowDate).ok).toBe(false)
    expect(planLeadAction({ action: "reschedule", target: "appointment", at: "2026-10-28T10:00:00Z", reason: "x" }, picked, owner, settings, nowDate).ok).toBe(true)
  })
  it("the new time must be in the future and within six months", () => {
    const l = withAppt
    expect(planLeadAction({ action: "reschedule", target: "appointment", at: "2026-10-26T07:00:00Z", reason: "x" }, l, setter, settings, nowDate)).toMatchObject({ ok: false, status: 400 })
    expect(planLeadAction({ action: "reschedule", target: "appointment", at: "2027-06-01T10:00:00Z", reason: "x" }, l, setter, settings, nowDate)).toMatchObject({ ok: false, status: 400 })
    expect(planLeadAction({ action: "reschedule", target: "appointment", at: "nonsense-date", reason: "x" }, l, setter, settings, nowDate)).toMatchObject({ ok: false, status: 400 })
  })
  it("the history says what happened, in plain words", () => {
    const row = eventText("appointment", { at: "2026-10-28T10:00:00.000Z", reason: "The seller is not available", rescheduled: true }, [], [])
    expect(row).toContain("Call moved to")
    expect(row).toContain("The seller is not available")
    expect(eventText("callback_moved", { callback_at: "2026-10-28T10:00:00.000Z", reason: "Other", rescheduled: true, note: "he travels" }, [], [])).toContain("Call back moved to")
  })
})

describe("telling the team a call was moved", () => {
  const team = [
    { user_id: "u-setter", permissions: ["leads.read", "leads.mark", "leads.worklist"] },
    { user_id: "u-seller", permissions: ["leads.read", "leads.pick", "leads.mark", "calls.host"] },
    { user_id: "u-ale", permissions: ["leads.read", "reports.read"] },
    { user_id: "u-gone", status: "removed", permissions: ["leads.read", "leads.mark"] },
    { user_id: "u-paused", status: "paused", permissions: ["leads.read", "leads.mark"] },
    { user_id: "u-blind", permissions: ["leads.mark"] },
  ]
  it("the seller and the setter are told, never the one who moved it, a removed or paused member, or a person who does not work calls", () => {
    expect(rescheduleRecipients(team, "u-setter")).toEqual(["u-seller"])
    expect(rescheduleRecipients(team, "u-seller")).toEqual(["u-setter"])
    expect(rescheduleRecipients(team, "u-ale").sort()).toEqual(["u-seller", "u-setter"])
  })
  it("the text names who moved which lead, from when to when, and why", () => {
    const p = reschedulePush({ moverName: "Cristina", leadName: "Marco Bianchi", from: "2026-10-27T10:00:00.000Z", to: "2026-10-28T14:00:00.000Z", reason: "The lead asked to move" })
    expect(p.title).toBe("Cristina moved a call · Marco Bianchi")
    expect(p.body).toContain("→")
    expect(p.body).toContain("The lead asked to move")
  })
})

describe("a moved call back in the lead history", () => {
  it("a person who may not read the team's notes still sees that it moved and why, but not the written note", () => {
    const rows = [{ id: "e1", kind: "callback_moved", actor: "rocco@x.com", created_at: "2026-10-26T08:00:00Z", data: { callback_at: "2026-10-28T10:00:00.000Z", reason: "Other", note: "private words", rescheduled: true } }] as never
    const out = redactTimeline(rows, false)
    expect(out).toHaveLength(1)
    expect(out[0].data).toMatchObject({ reason: "Other" })
    expect(out[0].data).not.toHaveProperty("note")
  })
})
