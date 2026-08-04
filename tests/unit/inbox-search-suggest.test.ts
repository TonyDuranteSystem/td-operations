import { describe, it, expect } from "vitest"
import { buildPrefixTsQuery, shouldSuggest, SUGGEST_MIN_CHARS } from "@/lib/inbox/search-suggest"

describe("buildPrefixTsQuery", () => {
  it("makes a single word match as a prefix — the whole point", () => {
    // Verified on production 2026-08-04: whole-word 'anto' matched 0 rows.
    expect(buildPrefixTsQuery("anto")).toBe("anto:*")
  })

  it("keeps completed words exact and only prefixes the one being typed", () => {
    expect(buildPrefixTsQuery("marco ros")).toBe("marco & ros:*")
    expect(buildPrefixTsQuery("worldpay jacob wood")).toBe("worldpay & jacob & wood:*")
  })

  it("strips characters that would make to_tsquery throw", () => {
    // An apostrophe or & reaching to_tsquery turns a search into a 500.
    expect(buildPrefixTsQuery("o'brien")).toBe("obrien:*")
    expect(buildPrefixTsQuery("a & b")).toBe("a & b:*")
    expect(buildPrefixTsQuery("re: invoice!")).toBe("re & invoice:*")
  })

  it("keeps accents — the index does not fold them, so stripping breaks real names", () => {
    expect(buildPrefixTsQuery("józef")).toBe("józef:*")
    expect(buildPrefixTsQuery("münch")).toBe("münch:*")
  })

  it("searches an email address as its parts", () => {
    expect(buildPrefixTsQuery("jacob.woodaz@worldpay.com")).toBe("jacobwoodazworldpaycom:*")
  })

  it("returns nothing searchable rather than a query that matches everything", () => {
    expect(buildPrefixTsQuery("")).toBeNull()
    expect(buildPrefixTsQuery("   ")).toBeNull()
    expect(buildPrefixTsQuery("!!!")).toBeNull()
    expect(buildPrefixTsQuery(null)).toBeNull()
    expect(buildPrefixTsQuery(undefined)).toBeNull()
  })

  it("ignores extra whitespace", () => {
    expect(buildPrefixTsQuery("  marco   ros  ")).toBe("marco & ros:*")
  })
})

describe("shouldSuggest", () => {
  it("waits until there is enough to search on", () => {
    expect(shouldSuggest("a")).toBe(false)
    expect(shouldSuggest("an")).toBe(true)
    expect("an".length).toBe(SUGGEST_MIN_CHARS)
  })

  it("stays out of the way of operator searches (those go to live Gmail on Enter)", () => {
    expect(shouldSuggest("from:jacob")).toBe(false)
    expect(shouldSuggest("has:attachment")).toBe(false)
    expect(shouldSuggest("subject:invoice")).toBe(false)
  })

  it("does not fire on punctuation alone", () => {
    expect(shouldSuggest("!!!")).toBe(false)
    expect(shouldSuggest("   ")).toBe(false)
  })

  it("fires on ordinary text", () => {
    expect(shouldSuggest("worldpay")).toBe(true)
    expect(shouldSuggest("marco ros")).toBe(true)
  })
})
