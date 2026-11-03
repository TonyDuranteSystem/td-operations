import { describe, it, expect } from "vitest"
import { explainZoomError, runZoomHostTest } from "@/lib/marketing/zoom-test"
import type { ZoomApi } from "@/lib/zoom"

function fake(over: Partial<ZoomApi> = {}, log: string[] = []): ZoomApi {
  return {
    createMeeting: async () => { log.push("create"); return { id: "42", joinUrl: "https://zoom.us/j/42" } },
    updateMeeting: async () => {},
    deleteMeeting: async id => { log.push(`delete ${id}`) },
    checkRecordings: async () => { log.push("recordings") },
    ...over,
  }
}

describe("explainZoomError", () => {
  it("puts Zoom's refusals in plain words", () => {
    expect(explainZoomError("Zoom refused the login (400).")).toContain("did not accept the app's keys")
    expect(explainZoomError("Zoom answered 404: {\"code\":1001,\"message\":\"User does not exist\"}")).toContain("no user with this email")
    expect(explainZoomError("Zoom answered 400: {\"code\":4711,\"message\":\"Invalid access token, does not contain scopes\"}")).toContain("missing a permission")
    expect(explainZoomError("")).toBe("Zoom did not answer.")
  })
})

describe("runZoomHostTest", () => {
  it("makes the meeting, deletes it, and checks the recordings", async () => {
    const log: string[] = []
    const r = await runZoomHostTest("rocco@example.test", () => fake({}, log), new Date("2026-11-03T12:00:00Z"))
    expect(r.ok).toBe(true)
    expect(r.checks.map(c => c.ok)).toEqual([true, true, true])
    expect(log).toEqual(["create", "delete 42", "recordings"])
  })
  it("a refused host is a plain failure, nothing to delete, recordings still asked", async () => {
    const log: string[] = []
    const r = await runZoomHostTest("nobody@example.test", () => fake({ createMeeting: async () => { throw new Error("Zoom answered 404: User does not exist") } }, log))
    expect(r.ok).toBe(false)
    expect(r.checks[0]).toMatchObject({ ok: false })
    expect(r.checks[0].detail).toContain("no user with this email")
    expect(log).toEqual(["recordings"])
  })
  it("missing recordings permission fails only that check", async () => {
    const r = await runZoomHostTest("rocco@example.test", () => fake({ checkRecordings: async () => { throw new Error("Zoom answered 400: code 4711 does not contain scopes") } }))
    expect(r.ok).toBe(false)
    expect(r.checks.map(c => c.ok)).toEqual([true, true, false])
    expect(r.checks[2].detail).toContain("missing a permission")
  })
  it("a test meeting that cannot be deleted is flagged with its id", async () => {
    const r = await runZoomHostTest("rocco@example.test", () => fake({ deleteMeeting: async () => { throw new Error("Zoom answered 500") } }))
    expect(r.ok).toBe(false)
    expect(r.checks[1].detail).toContain("meeting 42")
  })
  it("refuses something that is not an email without calling Zoom", async () => {
    const log: string[] = []
    const r = await runZoomHostTest("not an email", () => fake({}, log))
    expect(r.ok).toBe(false)
    expect(log).toEqual([])
  })
})
