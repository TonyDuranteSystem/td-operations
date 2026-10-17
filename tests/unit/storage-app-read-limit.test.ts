import { describe, it, expect } from "vitest"
import { readLimitBytes, withinReadLimit, readCost, MIN_READ_COST_BYTES, DEFAULT_READ_LIMIT_MB } from "@/lib/storage-app/read-limit"

describe("how much one Mac (and one person) may download per hour", () => {
  it("defaults to 500 MB and reads a sensible override; junk falls back to the default", () => {
    expect(readLimitBytes(undefined)).toBe(DEFAULT_READ_LIMIT_MB * 1024 * 1024)
    expect(readLimitBytes("1")).toBe(1024 * 1024)
    expect(readLimitBytes("2.5")).toBe(2.5 * 1024 * 1024)
    for (const bad of ["", "abc", "0", "-5", "NaN"]) expect(readLimitBytes(bad)).toBe(DEFAULT_READ_LIMIT_MB * 1024 * 1024)
  })
  it("a file with no recorded size (or a tiny one) costs at least 1 MB — never zero", () => {
    expect(readCost(null)).toBe(MIN_READ_COST_BYTES)
    expect(readCost(undefined)).toBe(MIN_READ_COST_BYTES)
    expect(readCost(0)).toBe(MIN_READ_COST_BYTES)
    expect(readCost(-5)).toBe(MIN_READ_COST_BYTES)
    expect(readCost(10)).toBe(MIN_READ_COST_BYTES)
    expect(readCost(50 * 1024 * 1024)).toBe(50 * 1024 * 1024)
  })
  it("allows a download that fits and refuses one that does not (exactly at the limit still fits)", () => {
    expect(withinReadLimit(0, 100, 1000)).toBe(true)
    expect(withinReadLimit(900, 100, 1000)).toBe(true)
    expect(withinReadLimit(901, 100, 1000)).toBe(false)
    expect(withinReadLimit(0, 1001, 1000)).toBe(false)
  })
})
