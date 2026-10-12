import { describe, it, expect } from "vitest"
import { moveRunIsStale, STALE_MOVE_MINUTES } from "@/lib/crm-store/switched-drive-guard"

const NOW = new Date("2026-10-12T12:00:00Z")
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString()

describe("moveRunIsStale — a stuck move must not refuse saves silently forever", () => {
  it("a run that showed life recently is fine", () => {
    expect(moveRunIsStale(minutesAgo(1), NOW)).toBe(false)
    expect(moveRunIsStale(minutesAgo(STALE_MOVE_MINUTES - 1), NOW)).toBe(false)
  })

  it("a run with no sign of life past the limit is stale", () => {
    expect(moveRunIsStale(minutesAgo(STALE_MOVE_MINUTES + 1), NOW)).toBe(true)
    expect(moveRunIsStale(minutesAgo(600), NOW)).toBe(true)
  })

  it("a missing or unreadable timestamp is treated as stale (raise the alarm rather than hide it)", () => {
    expect(moveRunIsStale(null, NOW)).toBe(true)
    expect(moveRunIsStale(undefined, NOW)).toBe(true)
    expect(moveRunIsStale("not a date", NOW)).toBe(true)
  })
})
