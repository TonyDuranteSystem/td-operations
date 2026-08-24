import { describe, it, expect } from "vitest"
import { t, getLocale, type Locale } from "@/lib/portal/i18n"

// Locale stays the narrow 'en'|'it' union (see i18n.ts's own comment on
// why) — these casts stand in for the ONE place that legitimately produces
// a wider value at runtime, getLocale()'s own documented `as Locale`, so
// the test can exercise the fallback path it feeds without the whole file
// pretending Locale is wide.
const ja = "ja" as Locale

describe("t", () => {
  it("resolves a known key for 'en' and 'it' unchanged from before the language-picker work", () => {
    expect(t("nav.chat", "en")).toBe("Chat")
    expect(t("nav.signOut", "it")).not.toBe("nav.signOut")
  })

  it("falls back to English for a locale with no static dictionary entry (a real, non-en/it language)", () => {
    // 'ja' has no static dictionary block — must fall through to English,
    // never throw, never return undefined, matching the documented chain.
    expect(t("nav.chat", ja)).toBe("Chat")
  })

  it("falls back to the raw key when nothing matches, for any locale", () => {
    expect(t("nav.totallyMadeUpKey", "en")).toBe("nav.totallyMadeUpKey")
    expect(t("nav.totallyMadeUpKey", ja)).toBe("nav.totallyMadeUpKey")
  })

  it("defaults to English when no locale is passed", () => {
    expect(t("nav.chat")).toBe("Chat")
  })
})

describe("getLocale", () => {
  it("reads a valid, already-supported locale from user metadata", () => {
    expect(getLocale({ user_metadata: { portal_language: "it" } })).toBe("it")
    expect(getLocale({ user_metadata: { portal_language: "en" } })).toBe("en")
  })

  it("now accepts a real language beyond en/it, via its own documented cast — the actual point of this milestone", () => {
    // getLocale()'s return type stays the narrow Locale ('en'|'it') on
    // purpose (see i18n.ts) — cast the result to string here to assert on
    // the real runtime value its own `as Locale` cast can produce.
    expect(getLocale({ user_metadata: { portal_language: "ja" } }) as string).toBe("ja")
    expect(getLocale({ user_metadata: { portal_language: "HU" } }) as string).toBe("hu")
  })

  it("still defaults to English for a made-up or missing value", () => {
    expect(getLocale({ user_metadata: { portal_language: "xx" } })).toBe("en")
    expect(getLocale({ user_metadata: {} })).toBe("en")
    expect(getLocale({})).toBe("en")
    expect(getLocale(null)).toBe("en")
  })
})
