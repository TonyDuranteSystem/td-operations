import { describe, it, expect } from "vitest"
import { cleanQuery, clampLimit, limitFor, parseParams, toQueryString, withFilterChange, withMore } from "@/lib/open-services/params"
import { MAX_LIMIT, MAX_QUERY_LENGTH, PAGE_SIZE } from "@/lib/open-services/types"

/** N1a C3 — everything in the web address is hostile input. */

describe("parseParams", () => {
  it("defaults", () => {
    expect(parseParams({})).toEqual({ view: "who", who: [], late: false, q: "", more: [] })
  })

  it("repeated parameters collapse to the first value (no array reaches string code)", () => {
    const p = parseParams({ q: ["abc", "def"], view: ["service", "who"], late: ["1", "0"], who: ["us", "client"] })
    expect(p.q).toBe("abc")
    expect(p.view).toBe("service")
    expect(p.late).toBe(true)
    expect(p.who).toEqual(["us"])
  })

  it("who keeps only real states, once each", () => {
    expect(parseParams({ who: "us, CLIENT,us,banana,,none,unset" }).who).toEqual(["us", "client", "none", "unset"])
  })

  it("search text is cleaned and capped, never executed", () => {
    expect(cleanQuery("  O’Brien   & Sons  ")).toBe("O'Brien & Sons")
    expect(parseParams({ q: "x".repeat(500) }).q).toHaveLength(MAX_QUERY_LENGTH)
    expect(parseParams({ q: "(%_,&)" }).q).toBe("(%_,&)")
  })

  it("'more' is clamped, bad values dropped, free-text keys with ':' ',' '~' survive", () => {
    const p = parseParams({ more: ["Banking Fintech~50", "weird:key,x~y~75", "none~abc", "~5", "k~-10", "big~99999", "k2~NaN"] })
    expect(p.more).toEqual([
      ["Banking Fintech", 50],
      ["weird:key,x~y", 75],
      ["k", PAGE_SIZE],
      ["big", MAX_LIMIT],
    ])
  })

  it("'more' is bounded in count and never builds objects keyed by user text", () => {
    const many = Array.from({ length: 200 }, (_, i) => `k${i}~30`)
    expect(parseParams({ more: many }).more.length).toBeLessThanOrEqual(50)
    expect(parseParams({ more: ["__proto__~40", "constructor~40"] }).more).toEqual([["__proto__", 40], ["constructor", 40]])
  })
})

describe("clampLimit / limitFor", () => {
  it("clamps into [PAGE_SIZE, MAX_LIMIT] and defaults non-numbers", () => {
    expect(clampLimit(Number.NaN)).toBe(PAGE_SIZE)
    expect(clampLimit(-5)).toBe(PAGE_SIZE)
    expect(clampLimit(0)).toBe(PAGE_SIZE)
    expect(clampLimit(26.9)).toBe(26)
    expect(clampLimit(10_000)).toBe(MAX_LIMIT)
  })

  it("limitFor falls back to the page size", () => {
    const p = parseParams({ more: ["A~60"] })
    expect(limitFor(p, "A")).toBe(60)
    expect(limitFor(p, "B")).toBe(PAGE_SIZE)
  })
})

describe("toQueryString / changes", () => {
  it("round-trips through parseParams, including awkward group names", () => {
    const base = parseParams({})
    const p = withMore(withFilterChange(base, { view: "service", who: ["us", "outside"], late: true, q: "o'brien & co" }), "A:b,c~d", 60)
    const qs = toQueryString(p)
    const raw: Record<string, string | string[]> = {}
    new URLSearchParams(qs.slice(1)).forEach((v, k) => {
      raw[k] = k in raw ? ([] as string[]).concat(raw[k], v) : v
    })
    expect(parseParams(raw)).toEqual(p)
  })

  it("is empty when everything is default", () => {
    expect(toQueryString(parseParams({}))).toBe("")
  })

  it("a filter change resets 'Show more'; 'Show more' keeps the filters", () => {
    const p = withMore(parseParams({ q: "abc" }), "G", 50)
    expect(withFilterChange(p, { late: true }).more).toEqual([])
    expect(withMore(p, "H", 75).q).toBe("abc")
    expect(withMore(p, "G", 75).more).toEqual([["G", 75]])
  })
})
