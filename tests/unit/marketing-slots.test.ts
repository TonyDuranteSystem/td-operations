import { describe, it, expect, vi } from "vitest"
import { timePrefsFrom } from "@/lib/marketing/time-prefs"
import { FakeGcal } from "./helpers/fake-gcal"

vi.mock("@/lib/marketing/calendar-read", () => ({
  loadCalendarData: async () => ({ leads: [], events: [], truncated: false, appointments: [{ lead: { id: "L-booked" }, at: "2026-11-03T16:00:00Z", actor: "x" }, { lead: { id: "L-mine" }, at: "2026-11-03T13:00:00Z", actor: "x" }] }),
}))
import { buildSlotOffer, loadSlotOffer } from "@/lib/marketing/slots-server"
import { clockText } from "@/lib/marketing/zones"

const ROC = "rocco@tonydurante.us"
const PERS = "roccorestapro@gmail.com"
const ID = "22222222-2222-4222-8222-222222222222"
const seller = { userId: ID, label: "Rocco", email: ROC }
const prefs = (over: Record<string, unknown> = {}) => timePrefsFrom({ member_time_zones: { [ID]: "Atlantic/Canary" }, member_call_hours: { [ID]: { ahead: 7 } }, member_personal_calendars: { [ID]: [PERS] }, calendar_busy_enabled: true, ...over } as Parameters<typeof timePrefsFrom>[0])
const T = (iso: string) => Date.parse(iso)
const NOW = T("2026-11-02T12:05:00Z")
const dayOf = (o: ReturnType<typeof buildSlotOffer>, key: string) => (o.state === "ok" ? o.days.find(d => d.key === key)?.slots.map(s => clockText(s, "Europe/Rome")) : undefined)

function world() {
  const g = new FakeGcal()
  g.lists[ROC] = [{ id: ROC, accessRole: "owner", primary: true }, { id: PERS, accessRole: "freeBusyReader", primary: false }]
  g.busy[ROC] = {
    primary: { busy: [{ start: T("2026-11-03T14:00:00Z"), end: T("2026-11-03T14:30:00Z") }], error: null },
    [PERS]: { busy: [{ start: T("2026-11-03T10:00:00Z"), end: T("2026-11-03T12:00:00Z") }], error: null },
  }
  return g
}

describe("the slots offered when booking (Addendum K.8)", () => {
  it("the worked example: nine slots on Tue 3 Nov, read one hour later in Rome", () => {
    const o = buildSlotOffer({ prefs: prefs(), seller, nowMs: NOW, busy: [{ start: T("2026-11-03T10:00:00Z"), end: T("2026-11-03T12:00:00Z") }, { start: T("2026-11-03T14:00:00Z"), end: T("2026-11-03T14:30:00Z") }] })
    expect(dayOf(o, "2026-11-03")).toEqual(["10:00", "13:30", "14:00", "16:00", "16:30", "17:00", "17:30", "18:00", "18:30"])
  })
  it("only working days, only inside the look-ahead, and a day with no slot is left out", () => {
    const o = buildSlotOffer({ prefs: prefs(), seller, nowMs: NOW, busy: [{ start: T("2026-11-04T00:00:00Z"), end: T("2026-11-05T00:00:00Z") }] })
    expect(o.state === "ok" && o.days.map(d => d.key)).toEqual(["2026-11-02", "2026-11-03", "2026-11-05", "2026-11-06", "2026-11-09"])
  })
  it("reads Google (free/busy only) and the booked calls; the lead's own call does not hold its own hour", async () => {
    const g = world()
    const o = await loadSlotOffer({ api: g, db: {} as never, teamId: "t", prefs: prefs(), seller, excludeLeadId: "L-mine", nowMs: NOW })
    // the other lead's call at 16:00Z (17:00 Rome) takes its hour and the gap around it; this lead's own call (13:00Z) does not hold its own hour
    expect(dayOf(o!, "2026-11-03")).toEqual(["10:00", "13:30", "14:00", "16:00", "18:00", "18:30"])
    expect(g.calls("freeBusy")).toEqual([`freeBusy ${ROC} primary,${PERS}`])
    expect(g.log.some(l => l.startsWith("listEvents"))).toBe(false)
  })
  it("the lead's own booked call does not block itself when it is being moved", async () => {
    const g = world()
    const o = await loadSlotOffer({ api: g, db: {} as never, teamId: "t", prefs: prefs(), seller, excludeLeadId: "L-booked", nowMs: NOW })
    // L-booked (16:00Z) is the one being moved, so 17:00 Rome is free again; the other lead's call at 13:00Z (14:00 Rome) still holds 13:30 and 14:00
    expect(dayOf(o!, "2026-11-03")).toEqual(["10:00", "16:00", "16:30", "17:00", "17:30", "18:00", "18:30"])
  })
  it("a share that is too wide, or a calendar Google cannot read, offers NO slot and says why", async () => {
    const wide = world(); wide.lists[ROC][1].accessRole = "writer"
    expect(await loadSlotOffer({ api: wide, db: {} as never, teamId: "t", prefs: prefs(), seller, excludeLeadId: "x", nowMs: NOW })).toMatchObject({ state: "hidden", reason: "share" })
    expect(wide.calls("freeBusy")).toEqual([])
    const down = world(); down.fail.add("freeBusy")
    expect(await loadSlotOffer({ api: down, db: {} as never, teamId: "t", prefs: prefs(), seller, excludeLeadId: "x", nowMs: NOW })).toMatchObject({ state: "hidden", reason: "error" })
    const unanswered = world(); unanswered.busy[ROC][PERS] = { busy: [], error: "notFound" }
    expect(await loadSlotOffer({ api: unanswered, db: {} as never, teamId: "t", prefs: prefs(), seller, excludeLeadId: "x", nowMs: NOW })).toMatchObject({ state: "hidden", reason: "error" })
  })
  it("nothing is offered, and Google is not asked, while the switch is off or when there is no seller with a work mailbox", async () => {
    const g = world()
    expect(await loadSlotOffer({ api: g, db: {} as never, teamId: "t", prefs: prefs({ calendar_busy_enabled: false }), seller, excludeLeadId: "x", nowMs: NOW })).toBeNull()
    expect(await loadSlotOffer({ api: g, db: {} as never, teamId: "t", prefs: prefs(), seller: null, excludeLeadId: "x", nowMs: NOW })).toBeNull()
    expect(await loadSlotOffer({ api: g, db: {} as never, teamId: "t", prefs: prefs(), seller: { ...seller, email: PERS }, excludeLeadId: "x", nowMs: NOW })).toBeNull()
    expect(g.log).toEqual([])
  })
  it("the offer carries slot start times only: nothing that says why a time is busy", async () => {
    const o = await loadSlotOffer({ api: world(), db: {} as never, teamId: "t", prefs: prefs(), seller, excludeLeadId: "x", nowMs: NOW })
    const text = JSON.stringify(o)
    for (const w of ["busy", "Private", "title", PERS, "Weekly"]) expect(text.toLowerCase()).not.toContain(w.toLowerCase())
  })
})
