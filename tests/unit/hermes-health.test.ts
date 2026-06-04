/**
 * Hermes instance health — staleness helper tests (Phase A).
 * Pairs with lib/ai-agent/hermes-health.ts and app/api/cron/hermes-health.
 */

import { describe, it, expect } from "vitest"
import {
  STALE_HEARTBEAT_MS,
  isInstanceStale,
  selectStaleOnline,
  type HermesInstanceRow,
} from "@/lib/ai-agent/hermes-health"

const NOW = new Date("2026-06-04T20:00:00Z").getTime()

describe("isInstanceStale", () => {
  it("null heartbeat → stale (cannot confirm alive)", () => {
    expect(isInstanceStale(null, NOW)).toBe(true)
  })

  it("unparseable heartbeat → stale", () => {
    expect(isInstanceStale("not-a-date", NOW)).toBe(true)
  })

  it("fresh heartbeat (1 min ago) → not stale", () => {
    const ts = new Date(NOW - 60_000).toISOString()
    expect(isInstanceStale(ts, NOW)).toBe(false)
  })

  it("heartbeat just under the threshold → not stale", () => {
    const ts = new Date(NOW - (STALE_HEARTBEAT_MS - 1000)).toISOString()
    expect(isInstanceStale(ts, NOW)).toBe(false)
  })

  it("heartbeat just over the threshold → stale", () => {
    const ts = new Date(NOW - (STALE_HEARTBEAT_MS + 1000)).toISOString()
    expect(isInstanceStale(ts, NOW)).toBe(true)
  })

  it("respects a custom threshold", () => {
    const ts = new Date(NOW - 6 * 60_000).toISOString() // 6 min ago
    expect(isInstanceStale(ts, NOW, 5 * 60_000)).toBe(true)
    expect(isInstanceStale(ts, NOW, 10 * 60_000)).toBe(false)
  })
})

describe("selectStaleOnline", () => {
  const fresh = new Date(NOW - 60_000).toISOString()
  const old = new Date(NOW - (STALE_HEARTBEAT_MS + 60_000)).toISOString()

  const rows: HermesInstanceRow[] = [
    { instance_id: "a", last_heartbeat: fresh, status: "online" }, // healthy → skip
    { instance_id: "b", last_heartbeat: old, status: "online" }, // stale online → select
    { instance_id: "c", last_heartbeat: old, status: "offline" }, // already offline → skip
    { instance_id: "d", last_heartbeat: null, status: "online" }, // never beat → select
  ]

  it("returns only stale, not-already-offline instances", () => {
    const out = selectStaleOnline(rows, NOW).map((r) => r.instance_id)
    expect(out).toEqual(["b", "d"])
  })

  it("returns empty when all instances are fresh", () => {
    const allFresh: HermesInstanceRow[] = [
      { instance_id: "x", last_heartbeat: fresh, status: "online" },
    ]
    expect(selectStaleOnline(allFresh, NOW)).toHaveLength(0)
  })

  it("never re-selects an already-offline instance even if stale", () => {
    const out = selectStaleOnline(
      [{ instance_id: "z", last_heartbeat: old, status: "offline" }],
      NOW,
    )
    expect(out).toHaveLength(0)
  })
})
