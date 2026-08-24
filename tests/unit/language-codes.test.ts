import { describe, it, expect } from "vitest"
import { isValidLanguageCode, languageName } from "@/lib/portal/language-codes"

describe("isValidLanguageCode", () => {
  it("accepts real ISO 639-1 codes, case-insensitively", () => {
    expect(isValidLanguageCode("en")).toBe(true)
    expect(isValidLanguageCode("it")).toBe(true)
    expect(isValidLanguageCode("ja")).toBe(true)
    expect(isValidLanguageCode("hu")).toBe(true)
    expect(isValidLanguageCode("JA")).toBe(true)
    expect(isValidLanguageCode("Hu")).toBe(true)
  })

  it("rejects made-up codes — the cost-abuse guard this exists for", () => {
    expect(isValidLanguageCode("xx")).toBe(false)
    expect(isValidLanguageCode("xx1")).toBe(false)
    expect(isValidLanguageCode("zz")).toBe(false)
    expect(isValidLanguageCode("")).toBe(false)
    expect(isValidLanguageCode("english")).toBe(false)
  })

  it("rejects non-string input without throwing", () => {
    // @ts-expect-error deliberately wrong type, matching a malformed request body
    expect(isValidLanguageCode(null)).toBe(false)
    // @ts-expect-error deliberately wrong type
    expect(isValidLanguageCode(undefined)).toBe(false)
    // @ts-expect-error deliberately wrong type
    expect(isValidLanguageCode(123)).toBe(false)
  })
})

describe("languageName", () => {
  it("returns the display name for a known code", () => {
    expect(languageName("ja")).toBe("Japanese")
    expect(languageName("hu")).toBe("Hungarian")
    expect(languageName("EN")).toBe("English")
  })

  it("returns undefined for an unknown code", () => {
    expect(languageName("xx")).toBeUndefined()
  })
})
