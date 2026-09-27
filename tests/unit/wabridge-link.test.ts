import { describe, it, expect } from "vitest"
import { LINK_CODE_MAX_AGE_MS, parseLinkCode, visibleLinkCode } from "@/lib/messaging/wabridge-link"
import { describeBridgeProblem } from "@/lib/messaging/wabridge-health"

const now = new Date("2026-09-25T16:00:00Z")
const ev = (over: Record<string, unknown> = {}) => ({ event: "bridge.linkcode", ts: now.getTime(), code: "AB12-CD34", ...over })

describe("parseLinkCode", () => {
  it("accepts a fresh, well-formed code and normalises it to the hyphenated upper-case form", () => {
    expect(parseLinkCode(ev(), now)).toEqual({ ok: true, code: "AB12-CD34" })
    expect(parseLinkCode(ev({ code: "ab12cd34" }), now)).toEqual({ ok: true, code: "AB12-CD34" })
    expect(parseLinkCode(ev({ code: " ab12-cd34 " }), now)).toEqual({ ok: true, code: "AB12-CD34" })
  })
  it("is not a linkcode event → null (the receiver treats it as something else)", () => {
    expect(parseLinkCode(null, now)).toBeNull()
    expect(parseLinkCode("x", now)).toBeNull()
    expect(parseLinkCode({ event: "bridge.heartbeat" }, now)).toBeNull()
  })
  it("rejects a stale or missing timestamp (a captured message cannot be replayed)", () => {
    expect(parseLinkCode(ev({ ts: now.getTime() - 3 * 60_000 }), now)).toEqual({ ok: false, reason: "stale or missing timestamp" })
    expect(parseLinkCode(ev({ ts: undefined }), now)).toEqual({ ok: false, reason: "stale or missing timestamp" })
    expect(parseLinkCode(ev({ ts: "now" }), now)).toEqual({ ok: false, reason: "stale or missing timestamp" })
  })
  it("rejects a missing or malformed code, and never echoes the code in the reason", () => {
    for (const code of ["", "ABC", "AB12-CD3", "AB12-CD345", "AB!2-CD34", "AB12 CD34", "<script>"]) {
      const r = parseLinkCode(ev({ code }), now)
      expect(r).toEqual({ ok: false, reason: "malformed code" })
    }
    expect(parseLinkCode(ev({ code: 12345678 }), now)).toEqual({ ok: false, reason: "missing code" })
    expect(parseLinkCode(ev({ code: undefined }), now)).toEqual({ ok: false, reason: "missing code" })
  })
})

describe("visibleLinkCode — only the owner, only while unlinked, only while fresh", () => {
  const base = { isOwner: true, health: "unlinked" as const, code: "AB12-CD34", codeAt: new Date(now.getTime() - 30_000).toISOString() }
  it("shows the code with its age", () => {
    expect(visibleLinkCode(base, now)).toEqual({ code: "AB12-CD34", ageSeconds: 30 })
  })
  it("hides it from anyone who is not the owner", () => {
    expect(visibleLinkCode({ ...base, isOwner: false }, now)).toEqual({ code: null, ageSeconds: null })
  })
  it("hides it unless the bridge is currently unlinked (a stale code is never shown after re-pairing)", () => {
    for (const health of ["ok", "offline", "process_down", "disconnected", "unmonitored", "none"] as const) {
      expect(visibleLinkCode({ ...base, health }, now).code).toBeNull()
    }
  })
  it("hides an expired code, a future-dated code, and missing/garbled fields", () => {
    expect(visibleLinkCode({ ...base, codeAt: new Date(now.getTime() - LINK_CODE_MAX_AGE_MS - 1).toISOString() }, now).code).toBeNull()
    expect(visibleLinkCode({ ...base, codeAt: new Date(now.getTime() - LINK_CODE_MAX_AGE_MS).toISOString() }, now).code).toBe("AB12-CD34")
    expect(visibleLinkCode({ ...base, codeAt: new Date(now.getTime() + 60_000).toISOString() }, now).code).toBeNull()
    expect(visibleLinkCode({ ...base, code: null }, now).code).toBeNull()
    expect(visibleLinkCode({ ...base, codeAt: null }, now).code).toBeNull()
    expect(visibleLinkCode({ ...base, codeAt: "garbage" }, now).code).toBeNull()
  })
})

describe("describeBridgeProblem", () => {
  it("gives the unlinked state wording that points at the CRM page, and every problem has text", () => {
    expect(describeBridgeProblem("unlinked").hint).toMatch(/Inbox/)
    expect(describeBridgeProblem("unlinked").hint).toMatch(/Linked devices/)
    for (const p of ["offline", "process_down", "unlinked", "disconnected"] as const) {
      const t = describeBridgeProblem(p)
      expect(t.reason.length).toBeGreaterThan(10)
      expect(t.hint.length).toBeGreaterThan(10)
    }
  })
})
