import { describe, it, expect } from "vitest"
import { normalizePolishClientLanguage, resolvePolishTargetLanguage } from "@/lib/portal/polish-language"

/**
 * AI Polish's target-language decision (dev job 9c251e65 — Luca: Polish silently
 * translated when he wanted the draft kept as written).
 */

describe("normalizePolishClientLanguage", () => {
  it("normalizes 'it' and 'Italian' to 'Italian'", () => {
    expect(normalizePolishClientLanguage("it")).toBe("Italian")
    expect(normalizePolishClientLanguage("Italian")).toBe("Italian")
  })
  it("normalizes 'en' and 'English' to 'English'", () => {
    expect(normalizePolishClientLanguage("en")).toBe("English")
    expect(normalizePolishClientLanguage("English")).toBe("English")
  })
  it("passes any other free-text value through unchanged", () => {
    expect(normalizePolishClientLanguage("Portuguese")).toBe("Portuguese")
    expect(normalizePolishClientLanguage("Spanish (Mexico)")).toBe("Spanish (Mexico)")
  })
  it("returns null for empty/missing values", () => {
    expect(normalizePolishClientLanguage(null)).toBeNull()
    expect(normalizePolishClientLanguage(undefined)).toBeNull()
    expect(normalizePolishClientLanguage("")).toBeNull()
  })
})

describe("resolvePolishTargetLanguage", () => {
  it("defaults to the client's language on file (unchanged behavior)", () => {
    expect(resolvePolishTargetLanguage("Italian", false)).toBe("Italian")
    expect(resolvePolishTargetLanguage("English", false)).toBe("English")
  })
  it("returns null (keep draft's own language) when no language is on file", () => {
    expect(resolvePolishTargetLanguage(null, false)).toBeNull()
    expect(resolvePolishTargetLanguage("", false)).toBeNull()
  })
  it("preserve_language=true ALWAYS wins, even with a real language on file", () => {
    expect(resolvePolishTargetLanguage("Italian", true)).toBeNull()
    expect(resolvePolishTargetLanguage("English", true)).toBeNull()
  })
  it("preserve_language=false is identical to the default (no behavior change for existing callers)", () => {
    expect(resolvePolishTargetLanguage("Italian", false)).toBe(normalizePolishClientLanguage("Italian"))
  })
})
