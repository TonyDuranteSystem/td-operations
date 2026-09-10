import { describe, it, expect } from "vitest"
import { shouldSkipBeforeCutover } from "@/lib/plaid-sync"

describe("shouldSkipBeforeCutover", () => {
  it("no cutover set — nothing is skipped, even a very old date", () => {
    expect(shouldSkipBeforeCutover("2020-01-01", null)).toBe(false)
  })

  it("a transaction dated exactly on the cutover is skipped (boundary is inclusive)", () => {
    // The cutover date is Antonio's own last hand-entered day — that day's activity is already
    // in the books by hand, so the boundary itself must be excluded, not just strictly-before.
    expect(shouldSkipBeforeCutover("2026-09-10", "2026-09-10")).toBe(true)
  })

  it("a transaction dated before the cutover is skipped", () => {
    expect(shouldSkipBeforeCutover("2026-09-01", "2026-09-10")).toBe(true)
  })

  it("a transaction dated after the cutover is kept", () => {
    expect(shouldSkipBeforeCutover("2026-09-11", "2026-09-10")).toBe(false)
  })

  it("compares as plain strings — no timezone drift across a year boundary", () => {
    expect(shouldSkipBeforeCutover("2025-12-31", "2026-01-01")).toBe(true)
    expect(shouldSkipBeforeCutover("2026-01-02", "2026-01-01")).toBe(false)
  })
})
