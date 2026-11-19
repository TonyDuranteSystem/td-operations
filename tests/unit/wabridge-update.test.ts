import { describe, expect, it } from "vitest"
import { parseUpdateReport, updateNotice, UPDATE_REPORT_STALE_MS } from "@/lib/messaging/wabridge-update"

const now = new Date("2026-11-19T20:00:00Z")
const ok = { event: "bridge.update.status", ts: now.getTime(), state: "rolled_back", message: "x", current: "v9.10.0", latest: "v9.11.0" }

describe("parseUpdateReport", () => {
  it("accepts a fresh, well-formed report", () => {
    const r = parseUpdateReport(ok, now)
    expect(r).toMatchObject({ ok: true, report: { state: "rolled_back", current: "v9.10.0", latest: "v9.11.0" } })
  })
  it("ignores other events", () => expect(parseUpdateReport({ ...ok, event: "bridge.heartbeat" }, now)).toBeNull())
  it("rejects a stale timestamp (replay)", () => {
    expect(parseUpdateReport({ ...ok, ts: now.getTime() - 5 * 60_000 }, now)).toMatchObject({ ok: false })
  })
  it("rejects an unknown state", () => expect(parseUpdateReport({ ...ok, state: "weird" }, now)).toMatchObject({ ok: false }))
  it("cleans and shortens text", () => {
    const r = parseUpdateReport({ ...ok, message: "a\u0000b" + "z".repeat(900) }, now)
    expect(r && r.ok && r.report.message.length).toBeLessThanOrEqual(400)
    expect(r && r.ok && r.report.message.includes("\u0000")).toBe(false)
  })
  it("rejects a non-object", () => expect(parseUpdateReport("x", now)).toBeNull())
})

describe("updateNotice", () => {
  const row = (state: string, ageMs = 1000, extra = {}) => ({ update_status: { state, message: "m", latest: "v9.11.0", ...extra }, update_status_at: new Date(now.getTime() - ageMs).toISOString() })
  it("shows nothing when the updater never reported", () => {
    expect(updateNotice(null, now)).toBeNull()
    expect(updateNotice({ update_status: null, update_status_at: null }, now)).toBeNull()
  })
  it("shows nothing when up to date, updated, available or a single failed check", () => {
    for (const s of ["up_to_date", "updated", "update_available", "check_failed"]) expect(updateNotice(row(s), now)).toBeNull()
  })
  it("broken is red", () => expect(updateNotice(row("broken"), now)?.level).toBe("problem"))
  it("rolled back, failed and needs review are amber", () => {
    for (const s of ["rolled_back", "update_failed", "needs_review"]) expect(updateNotice(row(s), now)?.level).toBe("warning")
  })
  it("a report older than 3 days means the updater stopped: amber, even if the last state was fine", () => {
    const n = updateNotice(row("up_to_date", UPDATE_REPORT_STALE_MS + 60_000), now)
    expect(n?.level).toBe("warning")
    expect(n?.text).toMatch(/3 days/)
  })
  it("names the new version for needs_review", () => expect(updateNotice(row("needs_review"), now)?.text).toContain("v9.11.0"))
  it("ignores a malformed stored status", () => expect(updateNotice({ update_status: "oops", update_status_at: now.toISOString() }, now)).toBeNull())
})
