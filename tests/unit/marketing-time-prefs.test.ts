import { describe, it, expect } from "vitest"
import { timePrefsFrom, resolveCallHours, memberZone, viewerZone, callTakers, sellerForLead, leadClocks, bannerClocks, type TimePrefs } from "@/lib/marketing/time-prefs"
import { freeSlots, slotDays } from "@/lib/marketing/free-slots"
import { shownTo, shownList, type GoogleItem, type VisibilityContext } from "@/lib/marketing/calendar-visibility"
import { parseSettingValue, resolveSetting, DEFAULT_CALL_HOURS } from "@/lib/marketing/settings-schema"
import { clockText } from "@/lib/marketing/zones"

const ANTONIO = "11111111-1111-4111-8111-111111111111"
const ROCCO = "22222222-2222-4222-8222-222222222222"
const SETTER = "33333333-3333-4333-8333-333333333333"
const prefs: TimePrefs = timePrefsFrom({
  owner_clock: { zone: "America/New_York", label: "Antonio" },
  member_time_zones: { [ROCCO]: "Atlantic/Canary", [SETTER]: "Europe/Rome" },
  member_call_hours: { [ROCCO]: {} },
})

describe("the new settings", () => {
  it("start with safe values", () => {
    expect(resolveSetting("owner_clock", undefined).value).toEqual({ zone: "Europe/Rome", label: "Owner" })
    for (const k of ["member_time_zones", "member_call_hours", "member_calendly_links", "member_personal_calendars"] as const) expect(resolveSetting(k, undefined).value).toEqual({})
    expect(resolveSetting("calendar_busy_enabled", undefined).value).toBe(false)
    expect(resolveSetting("calendar_write_through_enabled", undefined).value).toBe(false)
  })
  it("refuse a made-up zone, a bad person id, a bad link and an upside-down day", () => {
    expect(parseSettingValue("owner_clock", { zone: "Mars/Base", label: "A" }).ok).toBe(false)
    expect(parseSettingValue("member_time_zones", { "not-a-uuid": "Europe/Rome" }).ok).toBe(false)
    expect(parseSettingValue("member_time_zones", { [ROCCO]: "Nowhere/City" }).ok).toBe(false)
    expect(parseSettingValue("member_calendly_links", { [ROCCO]: [{ id: "solo", name: "Solo", url: "http://calendly.com/x" }] }).ok).toBe(false)
    expect(parseSettingValue("member_calendly_links", { [ROCCO]: [{ id: "solo", name: "Solo", url: "https://calendly.com/x" }] }).ok).toBe(true)
    expect(parseSettingValue("member_call_hours", { [ROCCO]: { start: 18, end: 9 } }).ok).toBe(false)
    expect(parseSettingValue("member_call_hours", { [ROCCO]: { start: 9, end: 18, slot: 30, gap: 15, days: [1, 2, 3] } }).ok).toBe(true)
    expect(parseSettingValue("member_personal_calendars", { [ROCCO]: ["roccorestapro@gmail.com"] }).ok).toBe(true)
    expect(parseSettingValue("member_personal_calendars", { [ROCCO]: ["not an address"] }).ok).toBe(false)
  })
  it("a broken stored value falls back to the safe default instead of breaking the page", () => {
    expect(resolveSetting("member_time_zones", { x: 5 })).toEqual({ value: {}, usedFallback: true })
  })
})

describe("whose zone a screen is read in", () => {
  it("a person reads their own zone; Rome when none is set", () => {
    expect(memberZone(prefs, ROCCO)).toBe("Atlantic/Canary"); expect(memberZone(prefs, "someone-else")).toBe("Europe/Rome"); expect(memberZone(prefs, null)).toBe("Europe/Rome")
  })
  it("the owner on his own login reads the owner clock; View as reads the zone of a person holding the role", () => {
    expect(viewerZone(prefs, { userId: ANTONIO, ownerLogin: true })).toBe("America/New_York")
    expect(viewerZone(prefs, { userId: ANTONIO, ownerLogin: false, viewAsMemberId: ROCCO })).toBe("Atlantic/Canary")
    expect(viewerZone(prefs, { userId: ANTONIO, ownerLogin: false, viewAsMemberId: null })).toBe("Europe/Rome")
    expect(viewerZone(prefs, { userId: ROCCO, ownerLogin: false })).toBe("Atlantic/Canary")
  })
})

describe("who takes calls, and who is the seller of a lead", () => {
  const members = [{ userId: ANTONIO, email: "antonio.durante@tonydurante.us" }, { userId: ROCCO, email: "rocco@tonydurante.us" }, { userId: SETTER, email: "ale@x.com" }, { userId: "p", email: "paused@x.com", status: "paused" }]
  it("a member with working hours takes calls; a paused or removed one does not", () => {
    expect(callTakers(prefs, members)).toEqual([{ userId: ROCCO, label: "Rocco" }])
    expect(callTakers({ callHours: { [ROCCO]: {}, p: {} } }, members).map(t => t.userId)).toEqual([ROCCO])
  })
  it("the seller is the one who picked the lead, else the first who takes calls, else nobody", () => {
    const two = [{ userId: ROCCO, label: "Rocco" }, { userId: "b", label: "Bea" }]
    expect(sellerForLead(two, "b")).toEqual({ userId: "b", label: "Bea" })
    expect(sellerForLead(two, SETTER)).toEqual({ userId: ROCCO, label: "Rocco" })
    expect(sellerForLead(two, null)).toEqual({ userId: ROCCO, label: "Rocco" })
    expect(sellerForLead([], ROCCO)).toBeNull()
  })
})

describe("the clocks on a lead: the setter never gets the owner's", () => {
  const seller = { label: "Rocco", zone: "Atlantic/Canary" }
  const owner = prefs.ownerClock
  it("the owner and the seller see client, seller and owner", () => {
    const c = leadClocks({ leadName: "Marco", clientZone: "Europe/Rome", seller, owner, youZone: "America/New_York", hideOwner: false })
    expect(c.map(x => x.key)).toEqual(["client", "seller", "owner"]); expect(c.map(x => x.zone)).toEqual(["Europe/Rome", "Atlantic/Canary", "America/New_York"])
  })
  it("the setter sees client, seller and herself, and no zone or name of the owner appears anywhere", () => {
    const c = leadClocks({ leadName: "Marco", clientZone: "Europe/Rome", seller, owner, youZone: "Europe/Rome", hideOwner: true })
    expect(c.map(x => x.key)).toEqual(["client", "seller", "you"])
    const text = JSON.stringify(c)
    expect(text).not.toContain("America/New_York"); expect(text).not.toContain("Antonio")
  })
  it("with no seller there are two clocks; an unknown client zone is an empty clock that asks", () => {
    expect(leadClocks({ leadName: "Dana", clientZone: null, seller: null, owner, youZone: "Europe/Rome", hideOwner: true }).map(x => [x.key, x.zone])).toEqual([["client", null], ["you", "Europe/Rome"]])
  })
  it("the banner is for a person who takes calls and may see the owner's clock", () => {
    expect(bannerClocks({ isTaker: true, hideOwner: false, youZone: "Atlantic/Canary", owner }).map(x => x.zone)).toEqual(["Atlantic/Canary", "America/New_York"])
    expect(bannerClocks({ isTaker: false, hideOwner: false, youZone: "Europe/Rome", owner })).toEqual([])
    expect(bannerClocks({ isTaker: true, hideOwner: true, youZone: "Europe/Rome", owner })).toEqual([])
  })
})

describe("the seller's free slots (the worked example of Addendum K.8)", () => {
  const hours = resolveCallHours({})
  const T = (iso: string) => Date.parse(iso)
  // Tue 3 Nov 2026, Canary Islands (UTC+0): other job 10:00-12:00, weekly call 14:00-14:30
  const busy = [{ start: T("2026-11-03T10:00:00Z"), end: T("2026-11-03T12:00:00Z") }, { start: T("2026-11-03T14:00:00Z"), end: T("2026-11-03T14:30:00Z") }]
  const NOW = T("2026-11-02T12:05:00Z")
  const inRome = (ms: number) => clockText(ms, "Europe/Rome")
  it("has the built-in hours", () => expect(hours).toEqual({ ...DEFAULT_CALL_HOURS }))
  it("gives the nine slots of the worked example, which the setter reads one hour later in Rome", () => {
    const s = freeSlots({ zone: "Atlantic/Canary", day: "2026-11-03", hours, busy, nowMs: NOW })
    expect(s.map(ms => clockText(ms, "Atlantic/Canary"))).toEqual(["09:00", "12:30", "13:00", "15:00", "15:30", "16:00", "16:30", "17:00", "17:30"])
    expect(s.map(inRome)).toEqual(["10:00", "13:30", "14:00", "16:00", "16:30", "17:00", "17:30", "18:00", "18:30"])
  })
  it("a call booked at 17:00 Rome time takes its hour and the gap around it", () => {
    const booked = { start: T("2026-11-03T16:00:00Z"), end: T("2026-11-03T16:30:00Z") }
    const s = freeSlots({ zone: "Atlantic/Canary", day: "2026-11-03", hours, busy: [...busy, booked], nowMs: NOW })
    expect(s.map(inRome)).toEqual(["10:00", "13:30", "14:00", "16:00", "18:00", "18:30"])
  })
  it("a day he does not work (Saturday) has no slot; so does a bad day", () => {
    expect(freeSlots({ zone: "Atlantic/Canary", day: "2026-11-07", hours, busy: [], nowMs: NOW })).toEqual([])
    expect(freeSlots({ zone: "Atlantic/Canary", day: "nonsense", hours, busy: [], nowMs: NOW })).toEqual([])
  })
  it("nothing before now plus the notice", () => {
    const s = freeSlots({ zone: "Atlantic/Canary", day: "2026-11-03", hours: resolveCallHours({ notice: 60 * 24 }), busy: [], nowMs: T("2026-11-03T08:00:00Z") })
    expect(s).toEqual([]) // none of today's slots is further than 24 h away
  })
  it("longer slots and a bigger gap are settings", () => {
    const s = freeSlots({ zone: "Atlantic/Canary", day: "2026-11-03", hours: resolveCallHours({ slot: 60, gap: 0 }), busy, nowMs: NOW })
    expect(s.map(ms => clockText(ms, "Atlantic/Canary"))).toEqual(["09:00", "12:00", "12:30", "13:00", "14:30", "15:00", "15:30", "16:00", "16:30", "17:00"])
  })
  it("the days a slot may be offered are the working days of the next weeks", () => {
    const days = slotDays(NOW, "Atlantic/Canary", resolveCallHours({ ahead: 7 }))
    expect(days).toEqual(["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-09"])
  })
  it("the day starts and ends in the seller's own zone, also across a clock change", () => {
    // Sun 25 Oct 2026 Europe left summer time; Monday 26 Oct 09:00 Rome is 08:00Z
    const s = freeSlots({ zone: "Europe/Rome", day: "2026-10-26", hours, busy: [], nowMs: T("2026-10-20T00:00:00Z") })
    expect(s[0]).toBe(T("2026-10-26T08:00:00Z")); expect(s.length).toBe(18)
  })
})

describe("who sees what on the Calendar (Addendum K.4)", () => {
  const ctx: VisibilityContext = { shareOk: true, ownerEmail: "antonio.durante@tonydurante.us", ownerLabel: "Antonio", sellerLabel: "Rocco" }
  const personal: GoogleItem = { id: "p1", kind: "seller_personal", start: 1, end: 2, title: "Dentist", guests: [] }
  const weekly: GoogleItem = { id: "t1", kind: "seller_td", start: 3, end: 4, title: "Weekly call", guests: ["rocco@tonydurante.us", "Antonio.Durante@tonydurante.us"] }
  const other: GoogleItem = { id: "t2", kind: "seller_td", start: 5, end: 6, title: "Private thing", guests: [] }
  const bank: GoogleItem = { id: "o1", kind: "owner", start: 7, end: 8, title: "Bank meeting", guests: ["x@bank.com"] }
  it("the setter sees nothing of any Google calendar", () => { for (const i of [personal, weekly, other, bank]) expect(shownTo("setter", i, ctx)).toBeNull() })
  it("Rocco's personal time is only Busy (no title) to Antonio and to Rocco, and nothing when the share is not right", () => {
    expect(shownTo("owner", personal, ctx)).toMatchObject({ tone: "busy", title: "Busy", sub: "Rocco", movable: false })
    expect(shownTo("seller", personal, ctx)).toMatchObject({ tone: "busy", title: "Busy", sub: "" })
    expect(JSON.stringify([shownTo("owner", personal, ctx), shownTo("seller", personal, ctx)])).not.toContain("Dentist")
    expect(shownTo("owner", personal, { ...ctx, shareOk: false })).toBeNull(); expect(shownTo("seller", personal, { ...ctx, shareOk: false })).toBeNull()
  })
  it("Rocco's work calendar: in full to Rocco; to Antonio in full only for events he is part of, otherwise Busy", () => {
    expect(shownTo("seller", other, ctx)).toMatchObject({ tone: "td", title: "Private thing" })
    expect(shownTo("owner", weekly, ctx)).toMatchObject({ tone: "td", title: "Weekly call" })
    expect(shownTo("owner", other, ctx)).toMatchObject({ tone: "busy", title: "Busy", sub: "Rocco" })
    expect(shownTo("owner", other, { ...ctx, ownerEmail: null })).toMatchObject({ tone: "busy" })
  })
  it("Antonio's own calendar: in full and movable for him; Busy for Rocco", () => {
    expect(shownTo("owner", bank, ctx)).toMatchObject({ tone: "mine", title: "Bank meeting", movable: true, guests: ["x@bank.com"] })
    expect(shownTo("seller", bank, ctx)).toMatchObject({ tone: "busy", title: "Busy", sub: "Antonio", movable: false, guests: [] })
    expect(JSON.stringify(shownTo("seller", bank, ctx))).not.toContain("Bank meeting")
  })
  it("a list is sorted by time and drops what the viewer may not see", () => {
    expect(shownList("owner", [bank, personal, weekly], ctx).map(x => x.id)).toEqual(["p1", "t1", "o1"])
    expect(shownList("setter", [bank, personal, weekly], ctx)).toEqual([])
  })
})
