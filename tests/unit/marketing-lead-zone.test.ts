import { describe, it, expect } from "vitest"
import { guessZoneFromPhone, leadZoneOf, type ZoneEvent } from "@/lib/marketing/lead-zone"

const NOW = new Date("2026-10-30T12:00:00Z")
const ev = (zone: unknown, created_at: string, actor = "rocco@tonydurante.us", kind = "zone_set"): ZoneEvent => ({ kind, created_at, actor, data: { zone } })

describe("the zone a phone number gives", () => {
  it("an Italian number is Rome (the country has one clock)", () => {
    const g = guessZoneFromPhone("+39 02 1234 5678", NOW)
    expect(g).toMatchObject({ kind: "zone", zone: "Europe/Rome", callingCode: "39" })
  })
  it("a number written with spaces, dashes or brackets still gives its country", () => {
    expect(guessZoneFromPhone("+39 (333) 123-4567", NOW)).toMatchObject({ kind: "zone", zone: "Europe/Rome" })
  })
  it("a United Kingdom number is London", () => expect(guessZoneFromPhone("+44 20 7946 0958", NOW)).toMatchObject({ kind: "zone", zone: "Europe/London" }))
  it("a German number is Berlin", () => expect(guessZoneFromPhone("+49 30 123456", NOW)).toMatchObject({ kind: "zone", zone: "Europe/Berlin" }))
  it("a US number has several zones, so the page is asked, with the zones to offer first", () => {
    const g = guessZoneFromPhone("+1 212 555 0100", NOW)
    expect(g.kind).toBe("ask")
    if (g.kind === "ask") { expect(g.callingCode).toBe("1"); expect(g.zones).toContain("America/New_York"); expect(g.zones).toContain("America/Los_Angeles") }
  })
  it("a +1 number that matches no area code still asks, with the zones of the whole +1 family", () => {
    const g = guessZoneFromPhone("+1 555 000 0002", NOW)
    expect(g.kind).toBe("ask")
    if (g.kind === "ask") expect(g.zones.length).toBeGreaterThan(3)
  })
  it("Spain is asked, because the Canary Islands keep a different clock from the mainland", () => {
    const g = guessZoneFromPhone("+34 91 123 4567", NOW)
    expect(g.kind).toBe("ask")
    if (g.kind === "ask") { expect(g.zones).toContain("Europe/Madrid"); expect(g.zones).toContain("Atlantic/Canary") }
  })
  it("a number without a country code, an empty one and a made-up one say nothing", () => {
    for (const v of ["333 123 4567", "0039 333 1234567", "", "  ", null, undefined, "+", "hello"]) expect(guessZoneFromPhone(v as string, NOW)).toEqual({ kind: "none" })
  })
})

describe("the zone of a lead", () => {
  it("comes from the phone number when nobody set one", () => {
    expect(leadZoneOf({ phone: "+39 02 1234 5678", events: [], now: NOW })).toMatchObject({ zone: "Europe/Rome", source: "phone", by: null, callingCode: "39" })
  })
  it("a zone a person set wins over the phone number, and the newest one wins", () => {
    const r = leadZoneOf({ phone: "+39 02 1234 5678", events: [ev("Europe/London", "2026-10-29T10:00:00Z", "a@x.us"), ev("Atlantic/Canary", "2026-10-30T09:00:00Z", "b@x.us")], now: NOW })
    expect(r).toMatchObject({ zone: "Atlantic/Canary", source: "set", by: "b@x.us" })
  })
  it("an entry with a made-up zone, or of another kind, is ignored", () => {
    const r = leadZoneOf({ phone: "+39 02 1234 5678", events: [ev("Mars/Base", "2026-10-30T09:00:00Z"), ev("America/Chicago", "2026-10-30T09:30:00Z", "x", "note")], now: NOW })
    expect(r).toMatchObject({ zone: "Europe/Rome", source: "phone" })
  })
  it("is unknown for a US number until somebody picks, and then it is that zone", () => {
    expect(leadZoneOf({ phone: "+1 212 555 0100", events: [], now: NOW })).toMatchObject({ zone: null, source: "none", callingCode: "1" })
    expect(leadZoneOf({ phone: "+1 212 555 0100", events: [], now: NOW }).options).toContain("America/New_York")
    expect(leadZoneOf({ phone: "+1 212 555 0100", events: [ev("America/Chicago", "2026-10-30T09:30:00Z")], now: NOW })).toMatchObject({ zone: "America/Chicago", source: "set" })
  })
  it("is unknown with no phone and no entry", () => expect(leadZoneOf({ phone: null, events: [], now: NOW })).toEqual({ zone: null, source: "none", by: null, callingCode: null, options: [] }))
})
