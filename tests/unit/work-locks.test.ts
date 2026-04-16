/**
 * P2.1 — work_locks helpers.
 *
 * The supabase-touching tool handlers are integration-tested implicitly
 * by exercising the MCP server; here we cover the pure helpers per R086
 * (unit tests for every new function in lib/).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { defaultLockedBy, fmtAge } from "@/lib/mcp/tools/locks"

describe("defaultLockedBy", () => {
  const originalMachineId = process.env.MACHINE_ID

  beforeEach(() => {
    delete process.env.MACHINE_ID
  })

  afterEach(() => {
    if (originalMachineId === undefined) {
      delete process.env.MACHINE_ID
    } else {
      process.env.MACHINE_ID = originalMachineId
    }
  })

  it("prefers MACHINE_ID env var when set", () => {
    process.env.MACHINE_ID = "imac-antonio"
    expect(defaultLockedBy()).toBe("imac-antonio")
  })

  it("falls back to os.hostname() when MACHINE_ID is unset", () => {
    // os.hostname() is reliable on macOS/Linux — just assert it returns a
    // non-empty string rather than a specific value.
    const value = defaultLockedBy()
    expect(value).toBeTypeOf("string")
    expect(value.length).toBeGreaterThan(0)
    expect(value).not.toBe("unknown") // env is unset but hostname should exist
  })
})

describe("fmtAge", () => {
  it('returns "<1m" for timestamps less than a minute old', () => {
    const iso = new Date(Date.now() - 30_000).toISOString() // 30s ago
    expect(fmtAge(iso)).toBe("<1m")
  })

  it("returns minutes for ages under an hour", () => {
    const iso = new Date(Date.now() - 5 * 60_000).toISOString() // 5m ago
    expect(fmtAge(iso)).toBe("5m")

    const iso2 = new Date(Date.now() - 59 * 60_000).toISOString() // 59m ago
    expect(fmtAge(iso2)).toBe("59m")
  })

  it("returns hours and minutes for ages at or over one hour", () => {
    const iso = new Date(Date.now() - 65 * 60_000).toISOString() // 1h 5m ago
    expect(fmtAge(iso)).toBe("1h 5m")

    const iso2 = new Date(Date.now() - 2 * 3_600_000).toISOString() // 2h exact
    expect(fmtAge(iso2)).toBe("2h")
  })

  it("rounds down (floor semantics)", () => {
    // 2m59s ago — should report 2m, not 3m.
    const iso = new Date(Date.now() - (2 * 60_000 + 59_000)).toISOString()
    expect(fmtAge(iso)).toBe("2m")
  })
})
