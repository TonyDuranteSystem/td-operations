import { describe, it, expect } from "vitest"
import {
  CALENDLY_LATE_MS, EARLY_MS, MARKETING_LATE_MS, QUIET_MINUTES, callStartFromName, decide, findBooking, isCallFolderName, isQuiet, orderForRun, originText, wallToInstant,
  type Booking, type CandidateFolder,
} from "@/lib/crm-store/zoom-call-filing-rules"

const at = (iso: string) => new Date(iso)
const LUCA = "2026-11-10 09.00.57 Luca Comaggi and Antonio Durante"
const calendly = (start: string, who: string | null = "Luca Comaggi"): Booking => ({ kind: "calendly", start: at(start), end: null, who })
const marketing = (start: string, end: string | null = null, who: string | null = "Maria"): Booking => ({ kind: "marketing", start: at(start), end: end ? at(end) : null, who })
const folder = (over: Partial<CandidateFolder> = {}): CandidateFolder => ({ id: "f1", name: LUCA, createdAt: at("2026-11-10T14:01:01Z"), lastActivity: at("2026-11-10T14:27:35Z"), uploadOpen: false, ...over })

describe("reading the time Zoom writes in the folder name (New York, winter and summer)", () => {
  it("09:00:57 in New York on 10 Nov is 14:00:57 UTC (winter time) — the real Luca folder", () => {
    expect(wallToInstant(2026, 11, 10, 9, 0, 57)?.toISOString()).toBe("2026-11-10T14:00:57.000Z")
    expect(callStartFromName(LUCA)?.toISOString()).toBe("2026-11-10T14:00:57.000Z")
  })
  it("13:00:42 on 1 June is 17:00:42 UTC (summer time)", () => {
    expect(callStartFromName("2026-06-01 13.00.42 Pasquale Minasi and Antonio Durante")?.toISOString()).toBe("2026-06-01T17:00:42.000Z")
  })
  it("the day the clocks go back (1 Nov 2026) is read right on both sides of the change", () => {
    expect(wallToInstant(2026, 11, 1, 0, 30, 0)?.toISOString()).toBe("2026-11-01T04:30:00.000Z")   // still summer time (UTC-4)
    expect(wallToInstant(2026, 11, 1, 3, 0, 0)?.toISOString()).toBe("2026-11-01T08:00:00.000Z")    // winter time (UTC-5)
  })
  it("the day the clocks go forward (8 Mar 2026) noon is summer time", () => {
    expect(wallToInstant(2026, 3, 8, 12, 0, 0)?.toISOString()).toBe("2026-03-08T16:00:00.000Z")
  })
  it("a date that does not exist is not a call", () => {
    expect(wallToInstant(2026, 13, 45, 9, 0, 0)).toBeNull()
    expect(wallToInstant(2026, 2, 30, 9, 0, 0)).toBeNull()
    expect(callStartFromName("2026-13-45 09.00.00 Nothing")).toBeNull()
  })
  it("only a name that starts with Zoom's date and time is a call folder", () => {
    expect(isCallFolderName(LUCA)).toBe(true)
    expect(isCallFolderName("2026-11-02 09.06.31 Antonio Durante - Tony Durante LLC's Zoom Meeting")).toBe(true)
    expect(isCallFolderName("2026-11-10 09.00.57")).toBe(true)
    expect(isCallFolderName("TD Zoom Calls")).toBe(false)
    expect(isCallFolderName("Zoom Call from Marketing QA")).toBe(false)
    expect(isCallFolderName("2026")).toBe(false)
    expect(isCallFolderName("2026-11-10 09.00.57Luca")).toBe(false)
    expect(callStartFromName("11 November")).toBeNull()
  })
})

describe("quiet check", () => {
  it("quiet at exactly 10 minutes, not at 9:59", () => {
    expect(QUIET_MINUTES).toBe(10)
    expect(isQuiet({ lastActivity: at("2026-11-10T14:27:35Z") }, at("2026-11-10T14:37:35Z"))).toBe(true)
    expect(isQuiet({ lastActivity: at("2026-11-10T14:27:35Z") }, at("2026-11-10T14:37:34Z"))).toBe(false)
  })
  it("a clock behind the last change is never quiet", () => {
    expect(isQuiet({ lastActivity: at("2026-11-10T15:00:00Z") }, at("2026-11-10T14:00:00Z"))).toBe(false)
  })
})

describe("finding the booking", () => {
  it("the Luca call matches his 14:00 UTC Calendly booking by the time in the folder name", () => {
    const r = findBooking(folder(), [calendly("2026-11-10T14:00:00Z")])
    expect(r?.booking.who).toBe("Luca Comaggi")
    expect(r?.matchedOn).toBe("name_time")
  })
  it("a call may start up to 15 minutes before the booking and up to 90 minutes after a Calendly start", () => {
    const b = calendly("2026-11-10T14:00:00Z")
    expect(findBooking(folder({ name: "2026-11-10 08.44.00 X", createdAt: at("2026-11-10T13:44:00Z") }), [b])).toBeNull()
    expect(findBooking(folder({ name: "2026-11-10 08.45.00 X", createdAt: at("2026-11-10T13:45:00Z") }), [b])?.booking).toBe(b)
    expect(findBooking(folder({ name: "2026-11-10 10.30.00 X", createdAt: at("2026-11-10T15:30:00Z") }), [b])?.booking).toBe(b)
    expect(findBooking(folder({ name: "2026-11-10 10.31.00 X", createdAt: at("2026-11-10T15:31:00Z") }), [b])).toBeNull()
    expect(EARLY_MS).toBe(15 * 60_000)
    expect(CALENDLY_LATE_MS).toBe(90 * 60_000)
  })
  it("a marketing booking counts until an hour after it ends (30 minutes when no end is stored)", () => {
    const withEnd = marketing("2026-11-12T15:00:00Z", "2026-11-12T15:45:00Z")
    expect(findBooking(folder({ name: "2026-11-12 11.45.00 X", createdAt: at("2026-11-12T16:45:00Z") }), [withEnd])?.booking).toBe(withEnd)
    expect(findBooking(folder({ name: "2026-11-12 11.50.00 X", createdAt: at("2026-11-12T16:50:00Z") }), [withEnd])).toBeNull()
    const noEnd = marketing("2026-11-12T15:00:00Z")
    expect(findBooking(folder({ name: "2026-11-12 11.30.00 X", createdAt: at("2026-11-12T16:30:00Z") }), [noEnd])?.booking).toBe(noEnd)
    expect(findBooking(folder({ name: "2026-11-12 11.31.00 X", createdAt: at("2026-11-12T16:31:00Z") }), [noEnd])).toBeNull()
    expect(MARKETING_LATE_MS).toBe(60 * 60_000)
  })
  it("a Mac in another time zone still matches by the moment the folder arrived", () => {
    // the name says 15:00 (a Rome clock), the booking is 14:00 UTC, the folder arrived at 14:01 UTC
    const r = findBooking(folder({ name: "2026-11-10 15.00.57 Luca Comaggi and Antonio Durante", createdAt: at("2026-11-10T14:01:01Z") }), [calendly("2026-11-10T14:00:00Z")])
    expect(r?.matchedOn).toBe("arrival_time")
  })
  it("the nearest booking wins; on an exact tie the marketing booking wins", () => {
    const far = calendly("2026-11-10T13:50:00Z", "Far")
    const near = calendly("2026-11-10T14:00:00Z", "Near")
    expect(findBooking(folder(), [far, near])?.booking.who).toBe("Near")
    const m = marketing("2026-11-10T14:00:00Z")
    expect(findBooking(folder(), [calendly("2026-11-10T14:00:00Z"), m])?.booking).toBe(m)
    expect(findBooking(folder(), [m, calendly("2026-11-10T14:00:00Z")])?.booking).toBe(m)
  })
  it("no booking → null", () => {
    expect(findBooking(folder(), [])).toBeNull()
    expect(findBooking(folder(), [calendly("2026-11-09T14:00:00Z")])).toBeNull()
  })
})

describe("deciding", () => {
  const now = at("2026-11-10T14:40:00Z")
  it("a folder that is not a call is left alone", () => {
    expect(decide(folder({ name: "Zoom Call from Marketing QA" }), now, [])).toEqual({ action: "skip", reason: "not_a_call_folder" })
  })
  it("an upload still running waits, however old the last change is", () => {
    expect(decide(folder({ uploadOpen: true, lastActivity: at("2026-11-10T10:00:00Z") }), now, [])).toEqual({ action: "wait", reason: "upload_running" })
  })
  it("a folder that changed less than 10 minutes ago waits", () => {
    expect(decide(folder({ lastActivity: at("2026-11-10T14:35:00Z") }), now, [])).toEqual({ action: "wait", reason: "still_changing" })
  })
  it("a Calendly call (the Luca case) is filed in TD Zoom Calls and says where it came from", () => {
    const d = decide(folder(), now, [calendly("2026-11-10T14:00:00Z")])
    expect(d).toMatchObject({ action: "file", destination: "td_zoom", origin: "calendly", matchedOn: "name_time" })
  })
  it("a call started straight from Zoom (no booking) is filed in TD Zoom Calls too", () => {
    const d = decide(folder({ name: "2026-11-02 09.06.31 Antonio Durante - Tony Durante LLC's Zoom Meeting" }), now, [])
    expect(d).toMatchObject({ action: "file", destination: "td_zoom", origin: "zoom_direct", booking: null })
  })
  it("a call inside a marketing booking goes to TD Marketing Calls", () => {
    const d = decide(folder(), now, [marketing("2026-11-10T14:00:00Z", "2026-11-10T14:30:00Z")])
    expect(d).toMatchObject({ action: "file", destination: "td_marketing", origin: "marketing" })
  })
})

describe("wording and order", () => {
  it("says where the call came from", () => {
    expect(originText("calendly", calendly("2026-11-10T14:00:00Z"))).toBe("Calendly booking 2026-11-10 14:00 UTC — Luca Comaggi")
    expect(originText("marketing", marketing("2026-11-12T15:00:00Z", null, null))).toBe("Marketing booking 2026-11-12 15:00 UTC")
    expect(originText("zoom_direct", null)).toBe("Started in Zoom (no booking found for this time)")
  })
  it("the folder that finished first is filed first", () => {
    const list = [{ id: "b", lastActivity: at("2026-11-10T15:00:00Z") }, { id: "a", lastActivity: at("2026-11-10T14:00:00Z") }]
    expect(orderForRun(list).map(x => x.id)).toEqual(["a", "b"])
    expect(list[0].id).toBe("b")   // the input is not changed
  })
})
