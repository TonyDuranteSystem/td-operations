import { describe, it, expect } from "vitest"
import { isWorkMailbox, eventFromGoogle, shareResults, checkShare, shareOk } from "@/lib/marketing/gcal"
import { loadGoogleLayer } from "@/lib/marketing/calendar-google"
import { addOwnerEvent, moveOwnerEvent } from "@/lib/marketing/owner-calendar-server"
import { syncCall, latestSynced } from "@/lib/marketing/call-sync"
import { timePrefsFrom } from "@/lib/marketing/time-prefs"
import { FakeGcal } from "./helpers/fake-gcal"

const ANT = "antonio.durante@tonydurante.us"
const ROC = "rocco@tonydurante.us"
const PERS = "roccorestapro@gmail.com"
const ROCCO_ID = "22222222-2222-4222-8222-222222222222"
const T = (iso: string) => Date.parse(iso)
const takers = [{ userId: ROCCO_ID, label: "Rocco", email: ROC }]
const prefs = (over: Record<string, unknown> = {}) => timePrefsFrom({
  owner_clock: { zone: "America/New_York", label: "Antonio", email: ANT }, member_call_hours: { [ROCCO_ID]: {} }, member_personal_calendars: { [ROCCO_ID]: [PERS] },
  calendar_busy_enabled: true, ...over,
} as Parameters<typeof timePrefsFrom>[0])
const FROM = T("2026-11-03T00:00:00Z"), TO = T("2026-11-04T00:00:00Z")

function world() {
  const g = new FakeGcal()
  g.lists[ROC] = [{ id: ROC, accessRole: "owner", primary: true }, { id: PERS, accessRole: "freeBusyReader", primary: false }]
  g.busy[ROC] = { [PERS]: { busy: [{ start: T("2026-11-03T10:00:00Z"), end: T("2026-11-03T12:00:00Z") }], error: null } }
  g.busy[ANT] = { primary: { busy: [{ start: T("2026-11-03T15:00:00Z"), end: T("2026-11-03T16:00:00Z") }], error: null } }
  g.put(ROC, "primary", { id: "weeklyevt", title: "Weekly call", startMs: T("2026-11-03T14:00:00Z"), endMs: T("2026-11-03T14:30:00Z"), guests: [ROC, ANT] })
  g.put(ROC, "primary", { id: "secretevt", title: "Private appointment", startMs: T("2026-11-03T17:00:00Z"), endMs: T("2026-11-03T18:00:00Z") })
  g.put(ROC, "primary", { id: "ourevent1", title: "Marco · Call", startMs: T("2026-11-03T16:00:00Z"), endMs: T("2026-11-03T16:30:00Z"), marketingLeadId: "lead-1" })
  g.put(ANT, "primary", { id: "bankevent", title: "Bank meeting", startMs: T("2026-11-03T15:00:00Z"), endMs: T("2026-11-03T16:00:00Z"), guests: ["x@bank.com"] })
  g.put(ANT, "primary", { id: "weeklyown", title: "Weekly call", startMs: T("2026-11-03T14:00:00Z"), endMs: T("2026-11-03T14:30:00Z"), guests: [ROC] })
  return g
}

describe("only a mailbox of the company is ever acted as", () => {
  it("accepts work mailboxes and nothing else", () => {
    expect(isWorkMailbox(ROC)).toBe(true); expect(isWorkMailbox(ANT)).toBe(true)
    for (const v of [PERS, "x@evil.com", "a@tonydurante.us.evil.com", "", null, undefined, "rocco@tonydurante.us\nbcc:x@y.z", 5]) expect(isWorkMailbox(v)).toBe(false)
  })
})

describe("a Google event in Marketing's shape", () => {
  it("drops a cancelled one, flags an all-day one, leaves out rooms, reads our private mark", () => {
    expect(eventFromGoogle({ id: "a", status: "cancelled", start: { dateTime: "2026-11-03T10:00:00Z" }, end: { dateTime: "2026-11-03T11:00:00Z" } }, "primary")).toBeNull()
    expect(eventFromGoogle({ id: "b", start: { date: "2026-11-03" }, end: { date: "2026-11-04" } }, "primary")).toMatchObject({ allDay: true })
    const e = eventFromGoogle({ id: "c", summary: " Hi ", start: { dateTime: "2026-11-03T10:00:00Z" }, end: { dateTime: "2026-11-03T11:00:00Z" }, attendees: [{ email: "a@x.com" }, { email: "room@x.com", resource: true }], extendedProperties: { private: { td_marketing_call: "lead-9" } } }, "primary")
    expect(e).toMatchObject({ title: "Hi", guests: ["a@x.com"], marketingLeadId: "lead-9" })
    expect(eventFromGoogle({ id: "d", start: { dateTime: "2026-11-03T11:00:00Z" }, end: { dateTime: "2026-11-03T10:00:00Z" } }, "primary")).toBeNull()
  })
})

describe("the share check: only 'free/busy only' is accepted", () => {
  const list = [{ id: PERS, accessRole: "freeBusyReader", primary: false }, { id: "b@x.com", accessRole: "writer", primary: false }, { id: "c@x.com", accessRole: "reader", primary: false }]
  it("free/busy only is fine; reader and writer are too wide; absent is missing", () => {
    expect(shareResults(list, [PERS, "b@x.com", "c@x.com", "d@x.com"]).map(r => r.state)).toEqual(["free_busy", "wide", "wide", "missing"])
    expect(shareResults(list, [PERS.toUpperCase()])[0].state).toBe("free_busy")
  })
  it("an answer that could not be had is not 'fine'", async () => {
    const g = world()
    expect(shareOk(await checkShare(g, ROC, [PERS]))).toBe(true)
    expect(shareOk([])).toBe(true)
    g.fail.add("calendarList")
    expect((await checkShare(g, ROC, [PERS]))[0].state).toBe("error")
    expect((await checkShare(g, PERS, [PERS]))[0].state).toBe("error") // a personal address is never acted as
    expect(await checkShare(g, ROC, [])).toEqual([])
  })
})

describe("the Google layer: who sees what, and what is never asked", () => {
  const base = (g: FakeGcal, viewer: "owner" | "seller" | "setter", p = prefs()) => loadGoogleLayer({ api: g, viewer, viewerUserId: viewer === "seller" ? ROCCO_ID : "owner-id", viewerEmail: viewer === "seller" ? ROC : ANT, prefs: p, takers, fromMs: FROM, toMs: TO })

  it("the setter gets nothing and Google is not called at all", async () => {
    const g = world()
    expect(await base(g, "setter")).toMatchObject({ items: [], warnings: [] })
    expect(g.log).toEqual([])
  })
  it("the owner: his own events in full; Rocco's personal time and unshared events only as Busy; the event he is a guest of in full", async () => {
    const g = world()
    const r = await base(g, "owner")
    const by = (id: RegExp) => r.items.find(i => id.test(i.id))!
    expect(r.items.filter(i => i.tone === "mine").map(i => i.title).sort()).toEqual(["Bank meeting", "Weekly call"])
    expect(r.ownerCalendar).toBe(true)
    expect(by(/^p/)).toMatchObject({ tone: "busy", title: "Busy", sub: "Rocco" })
    expect(r.items.filter(i => i.kind === "seller_td").map(i => `${i.tone}:${i.title}`)).toEqual(["busy:Busy"]) // the weekly call is drawn once, from his own calendar
    const all = JSON.stringify(r.items)
    expect(all).not.toContain("Private appointment"); expect(all).not.toContain("Marco · Call")
  })
  it("a personal calendar is only ever asked free/busy; its events are never listed", async () => {
    const g = world()
    await base(g, "owner")
    expect(g.log.filter(l => l.startsWith("listEvents")).every(l => !l.includes(PERS))).toBe(true)
    expect(g.calls("freeBusy").some(l => l.includes(PERS))).toBe(true)
    expect(g.log.some(l => /createEvent|moveEvent|removeEvent/.test(l))).toBe(false)
  })
  it("the Busy switch off: the owner still reads his own calendar, and nothing of Rocco's is read", async () => {
    const g = world()
    const r = await base(g, "owner", prefs({ calendar_busy_enabled: false }))
    expect(r.items.every(i => i.kind === "owner")).toBe(true)
    expect(g.log.some(l => l.includes(ROC))).toBe(false)
  })
  it("a share that is too wide hides the personal Busy time, never reads it, and says so", async () => {
    const g = world(); g.lists[ROC][1].accessRole = "writer"
    const r = await base(g, "owner")
    expect(r.shareOk).toBe(false); expect(r.share[0]).toMatchObject({ state: "wide", who: "Rocco" })
    expect(r.items.some(i => i.kind === "seller_personal")).toBe(false)
    expect(g.calls("freeBusy").some(l => l.includes(PERS))).toBe(false)
  })
  it("the seller: his work calendar in full, his personal time as Busy, the owner's time only as Busy and never the owner's events", async () => {
    const g = world()
    const r = await base(g, "seller")
    expect(r.items.filter(i => i.tone === "td").map(i => i.title).sort()).toEqual(["Private appointment", "Weekly call"])
    expect(r.items.filter(i => i.kind === "owner")).toMatchObject([{ tone: "busy", title: "Busy", sub: "Antonio" }])
    expect(JSON.stringify(r.items)).not.toContain("Bank meeting")
    expect(g.log.some(l => l.startsWith("listEvents " + ANT))).toBe(false)
  })
  it("an event both are part of is drawn once for each viewer: no second Busy block for it", async () => {
    const g = world()
    g.busy[ANT].primary.busy.push({ start: T("2026-11-03T14:00:00Z"), end: T("2026-11-03T14:30:00Z") }) // Google also counts the weekly call as the owner's busy time
    const seller = await base(g, "seller")
    expect(seller.items.filter(i => i.start === T("2026-11-03T14:00:00Z"))).toHaveLength(1)
    expect(seller.items.find(i => i.start === T("2026-11-03T14:00:00Z"))).toMatchObject({ tone: "td", title: "Weekly call" })
    const owner = await base(g, "owner")
    expect(owner.items.filter(i => i.start === T("2026-11-03T14:00:00Z"))).toHaveLength(1)
  })
  it("a call Marketing wrote into the seller's calendar is not drawn twice", async () => {
    const r = await base(world(), "seller")
    expect(r.items.some(i => i.title === "Marco · Call")).toBe(false)
  })
  it("a source that fails becomes a warning; the others still come back", async () => {
    const g = world(); g.fail.add("freeBusy")
    const r = await base(g, "owner")
    expect(r.warnings.length).toBeGreaterThan(0)
    expect(r.items.some(i => i.tone === "mine")).toBe(true)
    expect(r.shareOk).toBe(false) // a personal calendar that could not be read is not shown as free
  })
})

describe("the owner's own calendar: add and move, never delete", () => {
  const ZONE = "America/New_York"
  it("adds an event with a title, a start and a length", async () => {
    const g = world()
    const r = await addOwnerEvent(g, ANT, ZONE, { title: " Call Marco ", startIso: "2026-11-03T16:00:00Z", endIso: "2026-11-03T16:30:00Z" })
    expect(r.ok).toBe(true)
    expect(g.all(ANT).some(e => e.title === "Call Marco")).toBe(true)
  })
  it("refuses an empty title, a bad time, an upside-down or a more-than-a-day event, and a login with no work calendar", async () => {
    const g = world()
    const bad = [{ title: "", startIso: "2026-11-03T16:00:00Z", endIso: "2026-11-03T17:00:00Z" }, { title: "x", startIso: "nope", endIso: "2026-11-03T17:00:00Z" }, { title: "x", startIso: "2026-11-03T17:00:00Z", endIso: "2026-11-03T16:00:00Z" }, { title: "x", startIso: "2026-11-03T16:00:00Z", endIso: "2026-11-05T16:00:00Z" }]
    for (const b of bad) expect(await addOwnerEvent(g, ANT, ZONE, b)).toMatchObject({ ok: false, status: 400 })
    expect(await addOwnerEvent(g, PERS, ZONE, { title: "x", startIso: "2026-11-03T16:00:00Z", endIso: "2026-11-03T17:00:00Z" })).toMatchObject({ ok: false, status: 400 })
    expect(g.calls("createEvent")).toEqual([])
  })
  it("moves an event with no guests and keeps its length", async () => {
    const g = world(); g.put(ANT, "primary", { id: "solo1234", title: "Focus time", startMs: T("2026-11-03T15:00:00Z"), endMs: T("2026-11-03T16:00:00Z") })
    const r = await moveOwnerEvent(g, ANT, ZONE, "solo1234", { startIso: "2026-11-03T15:30:00Z" })
    expect(r.ok).toBe(true)
    expect(g.all(ANT).find(e => e.id === "solo1234")).toMatchObject({ startMs: T("2026-11-03T15:30:00Z"), endMs: T("2026-11-03T16:30:00Z") })
  })
  it("an event with guests is not moved until he has said yes, and the answer names the guests", async () => {
    const g = world()
    const first = await moveOwnerEvent(g, ANT, ZONE, "bankevent", { startIso: "2026-11-03T15:30:00Z" })
    expect(first).toMatchObject({ ok: false, status: 409, code: "GUESTS", guests: ["x@bank.com"] })
    expect(g.calls("moveEvent")).toEqual([])
    expect((await moveOwnerEvent(g, ANT, ZONE, "bankevent", { startIso: "2026-11-03T15:30:00Z", confirmGuests: true })).ok).toBe(true)
    expect(g.calls("moveEvent").length).toBe(1)
  })
  it("a missing event, an all-day event, a bad id and a failing Google are plain refusals", async () => {
    const g = world(); g.put(ANT, "primary", { id: "alldayevt", allDay: true, startMs: T("2026-11-03T00:00:00Z"), endMs: T("2026-11-04T00:00:00Z") })
    expect(await moveOwnerEvent(g, ANT, ZONE, "nothere1", { startIso: "2026-11-03T15:30:00Z" })).toMatchObject({ ok: false, status: 404 })
    expect(await moveOwnerEvent(g, ANT, ZONE, "alldayevt", { startIso: "2026-11-03T15:30:00Z" })).toMatchObject({ ok: false, status: 400 })
    expect(await moveOwnerEvent(g, ANT, ZONE, "../x", { startIso: "2026-11-03T15:30:00Z" })).toMatchObject({ ok: false, status: 404 })
    g.fail.add("moveEvent")
    expect(await moveOwnerEvent(g, ANT, ZONE, "bankevent", { startIso: "2026-11-03T15:30:00Z", confirmGuests: true })).toMatchObject({ ok: false, status: 502 })
  })
  it("the module has no way to delete an event", async () => {
    const m = await import("@/lib/marketing/owner-calendar-server")
    expect(Object.keys(m).sort()).toEqual(["addOwnerEvent", "moveOwnerEvent"])
  })
})

describe("writing a booked call into the seller's calendar", () => {
  const seller = { email: ROC, label: "Rocco" }
  const set = (start = "2026-11-03T16:00:00Z") => ({ kind: "set" as const, startIso: start, minutes: 30, zone: "Atlantic/Canary" })
  const input = (g: FakeGcal, over: Partial<Parameters<typeof syncCall>[0]> = {}) => ({ api: g, enabled: true, seller, action: set(), leadId: "lead-7", leadName: "Marco Rossi", existing: null, ...over })

  it("does nothing, and asks Google nothing, while the switch is off or there is no seller or no work mailbox", async () => {
    const g = world()
    expect(await syncCall(input(g, { enabled: false }))).toEqual({ state: "skipped", reason: "off" })
    expect(await syncCall(input(g, { seller: null }))).toEqual({ state: "skipped", reason: "no_seller" })
    expect(await syncCall(input(g, { seller: { email: PERS, label: "R" } }))).toEqual({ state: "skipped", reason: "no_mailbox" })
    expect(g.log).toEqual([])
  })
  it("creates an event with only the first name and 'Call', the right hour and a private mark", async () => {
    const g = world()
    const r = await syncCall(input(g))
    expect(r).toMatchObject({ state: "synced", event: { actAs: ROC, calendarId: "primary" } })
    const ev = g.all(ROC).find(e => e.title === "Marco · Call" && e.marketingLeadId === "lead-7")!
    expect(ev).toMatchObject({ startMs: T("2026-11-03T16:00:00Z"), endMs: T("2026-11-03T16:30:00Z") })
  })
  it("moving the call moves OUR event; it never creates a second one", async () => {
    const g = world()
    const first = await syncCall(input(g)); const existing = (first as unknown as { event: never }).event
    const r = await syncCall(input(g, { action: set("2026-11-04T10:00:00Z"), existing }))
    expect(r.state).toBe("synced")
    expect(g.all(ROC).filter(e => e.marketingLeadId === "lead-7")).toHaveLength(1)
    expect(g.all(ROC).find(e => e.marketingLeadId === "lead-7")!.startMs).toBe(T("2026-11-04T10:00:00Z"))
  })
  it("an event that is NOT ours (no mark for this lead) is never moved or removed: a new one is written instead", async () => {
    const g = world()
    const stranger = { eventId: "secretevt", actAs: ROC, calendarId: "primary" }
    await syncCall(input(g, { action: set("2026-11-04T10:00:00Z"), existing: stranger }))
    expect(g.all(ROC).find(e => e.id === "secretevt")).toMatchObject({ title: "Private appointment", startMs: T("2026-11-03T17:00:00Z") })
    expect(g.calls("moveEvent")).toEqual([]); expect(g.calls("removeEvent")).toEqual([])
    const cancel = await syncCall(input(g, { action: { kind: "cancel" }, existing: stranger }))
    expect(cancel).toEqual({ state: "skipped", reason: "nothing_to_remove" })
    expect(g.all(ROC).some(e => e.id === "secretevt")).toBe(true)
  })
  it("cancelling the call removes our event only", async () => {
    const g = world()
    const first = await syncCall(input(g)); const existing = (first as unknown as { event: never }).event
    const before = g.all(ROC).length
    expect(await syncCall(input(g, { action: { kind: "cancel" }, existing }))).toEqual({ state: "synced", event: null })
    expect(g.all(ROC).length).toBe(before - 1)
    expect(g.all(ROC).some(e => e.id === "weeklyevt")).toBe(true)
  })
  it("a new seller: the old event comes off the old calendar, the new one goes on the new", async () => {
    const g = world(); const BEA = "bea@tonydurante.us"
    const first = await syncCall(input(g)); const existing = (first as unknown as { event: never }).event
    const r = await syncCall(input(g, { seller: { email: BEA, label: "Bea" }, existing }))
    expect(r).toMatchObject({ state: "synced", event: { actAs: BEA } })
    expect(g.all(ROC).some(e => e.marketingLeadId === "lead-7")).toBe(false)
    expect(g.all(BEA).filter(e => e.marketingLeadId === "lead-7")).toHaveLength(1)
  })
  it("if Google refuses, the answer is 'failed' with a short message and nothing throws", async () => {
    const g = world(); g.fail.add("createEvent")
    const r = await syncCall(input(g))
    expect(r).toMatchObject({ state: "failed" }); expect((r as { message: string }).message.length).toBeGreaterThan(0)
    expect(await syncCall(input(g, { action: { kind: "set", startIso: "nope", minutes: 30, zone: "Europe/Rome" } }))).toMatchObject({ state: "failed" })
  })
  it("the history remembers the newest event written, and a removal clears it", () => {
    const e = (created_at: string, data: Record<string, unknown>, kind = "calendar_synced") => ({ kind, created_at, data })
    expect(latestSynced([])).toBeNull()
    expect(latestSynced([e("2026-11-01T10:00:00Z", { event_id: "a", act_as: ROC, calendar_id: "primary" }), e("2026-11-02T10:00:00Z", { event_id: "b", act_as: ROC, calendar_id: "primary" })])).toEqual({ eventId: "b", actAs: ROC, calendarId: "primary" })
    expect(latestSynced([e("2026-11-01T10:00:00Z", { event_id: "a", act_as: ROC, calendar_id: "primary" }), e("2026-11-02T10:00:00Z", { event_id: null, act_as: ROC, calendar_id: "primary", removed: true })])).toBeNull()
    expect(latestSynced([e("2026-11-01T10:00:00Z", { event_id: "a", act_as: ROC, calendar_id: "primary" }, "note")])).toBeNull()
  })
})
