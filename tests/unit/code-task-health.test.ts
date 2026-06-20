import { describe, it, expect } from "vitest"
import { runnerHealth, isTaskStuck } from "@/lib/code-tasks/health"

const NOW = Date.parse("2026-06-20T12:00:00Z")
const ago = (sec: number) => new Date(NOW - sec * 1000).toISOString()

describe("runnerHealth", () => {
  it("online for a recent heartbeat", () => {
    const h = runnerHealth(ago(10), NOW)
    expect(h.online).toBe(true)
    expect(h.seconds_ago).toBe(10)
  })
  it("offline once the heartbeat is older than the window", () => {
    expect(runnerHealth(ago(120), NOW).online).toBe(false)
    expect(runnerHealth(ago(61), NOW).online).toBe(false)
  })
  it("at the boundary (==window) is still online", () => {
    expect(runnerHealth(ago(60), NOW).online).toBe(true)
  })
  it("offline + null seconds_ago when there is no heartbeat", () => {
    expect(runnerHealth(null, NOW)).toEqual({ online: false, seconds_ago: null, last_heartbeat: null })
  })
  it("handles an unparseable timestamp safely", () => {
    expect(runnerHealth("not-a-date", NOW).online).toBe(false)
  })
})

describe("isTaskStuck", () => {
  it("pending is stuck only after the pending threshold", () => {
    expect(isTaskStuck({ status: "pending", created_at: ago(30) }, NOW)).toBe(false)
    expect(isTaskStuck({ status: "pending", created_at: ago(300) }, NOW)).toBe(true)
  })
  it("processing is stuck only past the kill threshold", () => {
    expect(isTaskStuck({ status: "processing", updated_at: ago(600) }, NOW)).toBe(false)
    expect(isTaskStuck({ status: "processing", updated_at: ago(40 * 60) }, NOW)).toBe(true)
  })
  it("finished states are never stuck", () => {
    expect(isTaskStuck({ status: "done", updated_at: ago(99999) }, NOW)).toBe(false)
    expect(isTaskStuck({ status: "failed", created_at: ago(99999) }, NOW)).toBe(false)
    expect(isTaskStuck({ status: "cancelled", created_at: ago(99999) }, NOW)).toBe(false)
  })
})
