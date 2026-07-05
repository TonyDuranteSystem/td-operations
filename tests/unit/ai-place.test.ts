import { describe, it, expect } from "vitest"
import { decidePlaceStamp, currencyCoversCountry, AI_PLACE_MIN_GROUP_ROWS } from "@/lib/tax/ai-place"
import { parseSuggestions } from "@/lib/tax/ai-categorizer"

const det = (...codes: string[]) => new Set(codes)

describe("currencyCoversCountry", () => {
  it("maps single-country currencies", () => {
    expect(currencyCoversCountry("USD", "US")).toBe(true)
    expect(currencyCoversCountry("AED", "AE")).toBe(true)
    expect(currencyCoversCountry("USD", "ES")).toBe(false)
  })
  it("EUR covers any eurozone country, nothing else", () => {
    expect(currencyCoversCountry("EUR", "ES")).toBe(true)
    expect(currencyCoversCountry("EUR", "PT")).toBe(true)
    expect(currencyCoversCountry("EUR", "GB")).toBe(false)
    expect(currencyCoversCountry("EUR", "AE")).toBe(false)
  })
  it("unknown/missing currency contributes nothing", () => {
    expect(currencyCoversCountry("XXX", "US")).toBe(false)
    expect(currencyCoversCountry(null, "US")).toBe(false)
  })
})

describe("decidePlaceStamp", () => {
  it("stamps when the workspace has deterministic evidence for the country", () => {
    // Chase USD card used in Spain: currency doesn't cover ES, but the
    // deterministic layer already proved the client transacts in ES.
    expect(decidePlaceStamp({ place: "ES", groupSize: 5, currency: "USD", deterministicCountries: det("ES", "US") })).toBe(true)
  })
  it("stamps when the group's currency zone covers the country", () => {
    expect(decidePlaceStamp({ place: "PT", groupSize: 3, currency: "EUR", deterministicCountries: det() })).toBe(true)
    expect(decidePlaceStamp({ place: "US", groupSize: 3, currency: "USD", deterministicCountries: det() })).toBe(true)
  })
  it("skips a country the AI alone claims (no independent evidence)", () => {
    expect(decidePlaceStamp({ place: "MX", groupSize: 10, currency: "USD", deterministicCountries: det("ES") })).toBe(false)
  })
  it("never stamps groups below the minimum size", () => {
    expect(decidePlaceStamp({ place: "ES", groupSize: AI_PLACE_MIN_GROUP_ROWS - 1, currency: "EUR", deterministicCountries: det("ES") })).toBe(false)
  })
  it("rejects malformed codes defensively", () => {
    expect(decidePlaceStamp({ place: "Spain" as string, groupSize: 5, currency: "EUR", deterministicCountries: det("ES") })).toBe(false)
  })
})

describe("parseSuggestions place field", () => {
  const ids = new Set(["a"])
  const base = { id: "a", category: "expense", subcategory: "travel", confidence: "medium" }
  it("accepts a clean alpha-2 code, normalizing case", () => {
    const [s] = parseSuggestions({ suggestions: [{ ...base, place: "es" }] }, ids)
    expect(s.place).toBe("ES")
  })
  it("drops garbage places without dropping the suggestion", () => {
    for (const bad of ["Spain", "EUR", "", 7, null, "E"]) {
      const [s] = parseSuggestions({ suggestions: [{ ...base, place: bad }] }, ids)
      expect(s).toBeDefined()
      expect(s.place).toBeUndefined()
    }
  })
})
