import { describe, it, expect } from "vitest"
import { localeFromLanguage, isItalian } from "@/lib/locale"

// Values below are the ACTUAL distinct contacts.language values found on
// production (2026-07-02): "Italian" (210), "English" (192), null (47),
// "Italian - englis", "Italiano - Ingle", "Italian / Englis",
// "English or Italian", "Italiano".
describe("localeFromLanguage", () => {
  it("maps every Italian-looking production value to 'it'", () => {
    expect(localeFromLanguage("Italian")).toBe("it")
    expect(localeFromLanguage("Italiano")).toBe("it")
    expect(localeFromLanguage("italian")).toBe("it")
    expect(localeFromLanguage("it")).toBe("it")
    expect(localeFromLanguage("IT")).toBe("it")
    expect(localeFromLanguage("Italian - englis")).toBe("it")
    expect(localeFromLanguage("Italiano - Ingle")).toBe("it")
    expect(localeFromLanguage("Italian / Englis")).toBe("it")
    expect(localeFromLanguage("  Italian  ")).toBe("it")
  })

  it("maps English and everything unknown to 'en'", () => {
    expect(localeFromLanguage("English")).toBe("en")
    expect(localeFromLanguage("en")).toBe("en")
    // Starts with "English" → the client reads English; en is correct.
    expect(localeFromLanguage("English or Italian")).toBe("en")
    expect(localeFromLanguage("Spanish")).toBe("en")
    expect(localeFromLanguage("")).toBe("en")
    expect(localeFromLanguage("   ")).toBe("en")
    expect(localeFromLanguage(null)).toBe("en")
    expect(localeFromLanguage(undefined)).toBe("en")
  })
})

describe("isItalian", () => {
  it("mirrors localeFromLanguage", () => {
    expect(isItalian("Italian")).toBe(true)
    expect(isItalian("it")).toBe(true)
    expect(isItalian("English")).toBe(false)
    expect(isItalian(null)).toBe(false)
  })
})
