import { describe, it, expect } from "vitest"
import { flagEmojiForLanguage } from "@/lib/portal/language-flags"
import { LANGUAGE_NAMES } from "@/lib/portal/language-codes"

describe("flagEmojiForLanguage", () => {
  it("returns the conventional flag for common languages", () => {
    expect(flagEmojiForLanguage("fr")).toBe("🇫🇷")
    expect(flagEmojiForLanguage("de")).toBe("🇩🇪")
    expect(flagEmojiForLanguage("ja")).toBe("🇯🇵")
    expect(flagEmojiForLanguage("it")).toBe("🇮🇹")
  })

  it("is case-insensitive, matching isValidLanguageCode's contract", () => {
    expect(flagEmojiForLanguage("FR")).toBe("🇫🇷")
    expect(flagEmojiForLanguage("Ja")).toBe("🇯🇵")
  })

  it("picks one representative flag for languages spoken officially in many countries", () => {
    expect(flagEmojiForLanguage("en")).toBe("🇬🇧")
    expect(flagEmojiForLanguage("es")).toBe("🇪🇸")
    expect(flagEmojiForLanguage("ar")).toBe("🇸🇦")
    expect(flagEmojiForLanguage("pt")).toBe("🇵🇹")
    expect(flagEmojiForLanguage("zh")).toBe("🇨🇳")
  })

  it("returns null for constructed languages with no country at all", () => {
    expect(flagEmojiForLanguage("eo")).toBeNull() // Esperanto
    expect(flagEmojiForLanguage("io")).toBeNull() // Ido
    expect(flagEmojiForLanguage("ia")).toBeNull() // Interlingua
    expect(flagEmojiForLanguage("ie")).toBeNull() // Interlingue
    expect(flagEmojiForLanguage("vo")).toBeNull() // Volapük
  })

  it("returns null for classical/liturgical languages with no living state", () => {
    expect(flagEmojiForLanguage("la")).toBeNull() // Latin
    expect(flagEmojiForLanguage("ae")).toBeNull() // Avestan
    expect(flagEmojiForLanguage("cu")).toBeNull() // Church Slavic
    expect(flagEmojiForLanguage("pi")).toBeNull() // Pali
    expect(flagEmojiForLanguage("sa")).toBeNull() // Sanskrit
  })

  it("returns null for an unknown code rather than throwing", () => {
    expect(flagEmojiForLanguage("xx")).toBeNull()
    expect(flagEmojiForLanguage("")).toBeNull()
  })

  it("every real language code resolves to either a 2-codepoint flag or null — no partial/malformed emoji", () => {
    for (const code of Object.keys(LANGUAGE_NAMES)) {
      const flag = flagEmojiForLanguage(code)
      if (flag !== null) {
        expect([...flag].length).toBe(2)
      }
    }
  })
})
