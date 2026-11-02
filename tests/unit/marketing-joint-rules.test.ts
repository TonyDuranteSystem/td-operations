import { describe, it, expect } from "vitest"
import { buildJointMail, buildJointMime, isOverlapViolation, linkState, lockRange, pickJointLang } from "@/lib/marketing/joint-rules"

const NOW = Date.UTC(2026, 10, 2)
const row = (o: Partial<Parameters<typeof linkState>[0] & object> = {}) => ({ status: "open" as const, expires_at: new Date(NOW + 86_400_000).toISOString(), revoked_at: null, starts_at: null, ...o })

describe("pickJointLang", () => {
  it("is Italian for an Italian number or country and English for everybody else", () => {
    expect(pickJointLang({ phone: "+39 333 123 4567" })).toBe("it")
    expect(pickJointLang({ phone: "0039333123456" })).toBe("it")
    expect(pickJointLang({ country: "Italy" })).toBe("it")
    expect(pickJointLang({ country: "IT" })).toBe("it")
    expect(pickJointLang({ phone: "+1 212 555 0100", country: "US" })).toBe("en")
    expect(pickJointLang({})).toBe("en")
  })
})

describe("linkState", () => {
  it("open while not expired, revoked or used", () => {
    expect(linkState(row(), NOW)).toBe("open")
    expect(linkState(row({ expires_at: new Date(NOW - 1).toISOString() }), NOW)).toBe("unusable")
    expect(linkState(row({ revoked_at: new Date(NOW).toISOString() }), NOW)).toBe("unusable")
    expect(linkState(null, NOW)).toBe("unusable")
  })
  it("a failed booking leaves the link open", () => { expect(linkState(row({ status: "failed" }), NOW)).toBe("open") })
  it("booked only while the call is still ahead; a booking in progress is not usable", () => {
    expect(linkState(row({ status: "booked", starts_at: new Date(NOW + 3_600_000).toISOString() }), NOW)).toBe("booked")
    expect(linkState(row({ status: "booked", starts_at: new Date(NOW - 3_600_000).toISOString() }), NOW)).toBe("unusable")
    expect(linkState(row({ status: "booking" }), NOW)).toBe("unusable")
    expect(linkState(row({ status: "cancelled" }), NOW)).toBe("cancelled")
  })
})

describe("lockRange", () => {
  it("holds the call and the gap kept around it", () => {
    expect(lockRange(1_000_000, 30, 15)).toEqual({ startMs: 1_000_000, endMs: 1_000_000 + 1_800_000, fromMs: 1_000_000 - 900_000, toMs: 1_000_000 + 1_800_000 + 900_000 })
  })
})

describe("isOverlapViolation", () => {
  it("knows the exclusion constraint's answer", () => {
    expect(isOverlapViolation({ code: "23P01" })).toBe(true)
    expect(isOverlapViolation({ message: 'conflicting key value violates exclusion constraint "marketing_joint_links_no_overlap"' })).toBe(true)
    expect(isOverlapViolation({ code: "23505" })).toBe(false)
    expect(isOverlapViolation(null)).toBe(false)
  })
})

describe("the client's emails", () => {
  const base = { name: "Marco Rossi", whenText: "martedì 3 novembre, 14:00 – 14:30", zoneText: "Europe/Rome", joinUrl: "https://zoom.us/j/1", manageUrl: "https://app.example.test/marketing/book/abc" }
  it("confirms in Italian with the time, the Zoom link and the page to cancel or move", () => {
    const m = buildJointMail({ kind: "booked", lang: "it", ...base })
    expect(m.subject).toBe("Chiamata confermata con Antonio Durante")
    expect(m.text).toContain("Ciao Marco,")
    expect(m.text).toContain("https://zoom.us/j/1")
    expect(m.text).toContain("https://app.example.test/marketing/book/abc")
    expect(m.html).toContain("Entra su Zoom")
  })
  it("says moved and cancelled, in English, and a cancellation carries no Zoom link", () => {
    expect(buildJointMail({ kind: "moved", lang: "en", ...base }).subject).toBe("Call moved")
    const c = buildJointMail({ kind: "cancelled", lang: "en", ...base, joinUrl: null })
    expect(c.subject).toBe("Call cancelled")
    expect(c.text).not.toContain("zoom.us")
  })
  it("escapes what the client typed", () => {
    expect(buildJointMail({ kind: "booked", lang: "en", ...base, name: "<b>Eve</b> Mallory" }).html).not.toContain("<b>Eve")
  })
  it("encodes the subject as RFC 2047 and refuses an address with a line break", () => {
    const mime = buildJointMime("marco@example.com", buildJointMail({ kind: "booked", lang: "it", ...base }))
    expect(mime).toMatch(/Subject: =\?utf-8\?B\?[A-Za-z0-9+/=]+\?=/)
    expect(() => buildJointMime("a@b.co\r\nBcc: x@y.co", buildJointMail({ kind: "booked", lang: "it", ...base }))).toThrow()
  })
})
