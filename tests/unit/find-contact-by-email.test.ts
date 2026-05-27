import { describe, it, expect } from "vitest"
import { normalizeEmailForMatch } from "@/lib/contacts/find-contact-by-email"

describe("normalizeEmailForMatch", () => {
  it("trims and lowercases", () => {
    expect(normalizeEmailForMatch("  Andrea@Example.COM ")).toBe("andrea@example.com")
  })
  it("returns null for empty/whitespace/null/undefined", () => {
    expect(normalizeEmailForMatch("")).toBeNull()
    expect(normalizeEmailForMatch("   ")).toBeNull()
    expect(normalizeEmailForMatch(null)).toBeNull()
    expect(normalizeEmailForMatch(undefined)).toBeNull()
  })
  it("leaves an already-normal email unchanged", () => {
    expect(normalizeEmailForMatch("info@economicamente.net")).toBe("info@economicamente.net")
  })
})
