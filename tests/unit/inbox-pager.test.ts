import { describe, it, expect } from "vitest"
import { buildPageNumbers } from "@/lib/inbox/pager"

describe("buildPageNumbers", () => {
  it("returns nothing when there is one page or fewer", () => {
    expect(buildPageNumbers(1, 1)).toEqual([])
    expect(buildPageNumbers(1, 0)).toEqual([])
  })

  it("lists every page when they all fit", () => {
    expect(buildPageNumbers(1, 5)).toEqual([1, 2, 3, 4, 5])
  })

  it("collapses the middle with ellipsis on a long list", () => {
    // page 50 of 107 → 1 … 48 49 50 51 52 … 107
    expect(buildPageNumbers(50, 107)).toEqual([1, null, 48, 49, 50, 51, 52, null, 107])
  })

  it("keeps first and last page always visible", () => {
    const p = buildPageNumbers(60, 107)
    expect(p[0]).toBe(1)
    expect(p[p.length - 1]).toBe(107)
  })

  it("has no gap marker when pages are contiguous at the edges", () => {
    expect(buildPageNumbers(2, 6)).toEqual([1, 2, 3, 4, 5, 6])
    expect(buildPageNumbers(107, 107)).toEqual([1, null, 105, 106, 107])
  })

  it("clamps an out-of-range page instead of producing junk", () => {
    expect(buildPageNumbers(999, 5)).toEqual([1, 2, 3, 4, 5])
    expect(buildPageNumbers(0, 5)).toEqual([1, 2, 3, 4, 5])
    // clamping also holds on a long list: page 999 of 107 windows around 107
    expect(buildPageNumbers(999, 107)).toEqual([1, null, 105, 106, 107])
  })

  it("never repeats a page number", () => {
    const p = buildPageNumbers(3, 107).filter((n): n is number => n !== null)
    expect(new Set(p).size).toBe(p.length)
  })

  it("stays ascending", () => {
    const p = buildPageNumbers(40, 107).filter((n): n is number => n !== null)
    expect([...p].sort((a, b) => a - b)).toEqual(p)
  })
})
