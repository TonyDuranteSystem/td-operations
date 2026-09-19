/**
 * Tests for lib/messaging/search-match.ts — matchesWhatsAppSearch.
 *
 * Covers: empty query matches everything, case-insensitive name substring
 * match, phone-digit match against a name that IS a raw phone number (the
 * common case for a conversation with no linked contact), formatting-agnostic
 * digit matching, a too-short numeric query never matching by digits alone,
 * and a null/empty name never crashing or false-matching.
 */

import { describe, it, expect } from "vitest"
import { matchesWhatsAppSearch } from "@/lib/messaging/search-match"

describe("matchesWhatsAppSearch", () => {
  it("matches everything when the query is empty or whitespace", () => {
    expect(matchesWhatsAppSearch("Marinela Marku", "")).toBe(true)
    expect(matchesWhatsAppSearch("Marinela Marku", "   ")).toBe(true)
  })

  it("matches a name case-insensitively by substring", () => {
    expect(matchesWhatsAppSearch("Marinela Marku", "marinela")).toBe(true)
    expect(matchesWhatsAppSearch("Marinela Marku", "MARKU")).toBe(true)
    expect(matchesWhatsAppSearch("Marinela Marku", "riccardo")).toBe(false)
  })

  it("matches a phone-number name by digits, ignoring formatting differences", () => {
    expect(matchesWhatsAppSearch("+1 (609) 885-3596", "6098853596")).toBe(true)
    expect(matchesWhatsAppSearch("+1 (609) 885-3596", "609 885 3596")).toBe(true)
    expect(matchesWhatsAppSearch("+39 333 290 3858", "3332903858")).toBe(true)
  })

  it("does not digit-match on a too-short numeric query", () => {
    // "98" is a real (non-contiguous-in-source) substring of the digits
    // (…9-8…) but neither appears as literal raw text nor is long enough to
    // trust as a phone match — guards a 1-2 digit query from matching nearly
    // every phone number.
    expect(matchesWhatsAppSearch("+1 (609) 885-3596", "98")).toBe(false)
  })

  it("does not crash or false-match on a null/empty name", () => {
    expect(matchesWhatsAppSearch(null, "anything")).toBe(false)
    expect(matchesWhatsAppSearch(undefined, "anything")).toBe(false)
    expect(matchesWhatsAppSearch("", "anything")).toBe(false)
    expect(matchesWhatsAppSearch(null, "")).toBe(true)
  })
})
