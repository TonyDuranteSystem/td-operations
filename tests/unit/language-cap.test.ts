import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: { from: vi.fn() },
}))

import { distinctLanguagesTranslatedToday, isBrandNewLanguage, MAX_NEW_LANGUAGES_PER_DAY } from "@/lib/portal/language-cap"
import { supabaseAdmin } from "@/lib/supabase-admin"

function makeSelectChain(result: { data?: unknown; count?: number; error?: unknown }) {
  const c: Record<string, unknown> = {
    select: vi.fn(() => c),
    eq: vi.fn(() => c),
    gte: vi.fn(() => c),
    limit: vi.fn(() => c),
    then: (resolve: (v: unknown) => unknown) => resolve({ data: result.data ?? null, count: result.count ?? null, error: result.error ?? null }),
  }
  return c
}

describe("distinctLanguagesTranslatedToday", () => {
  beforeEach(() => vi.clearAllMocks())

  it("counts each language code once even with many rows", async () => {
    vi.mocked(supabaseAdmin.from).mockReturnValue(makeSelectChain({
      data: [
        { language_code: "ja" }, { language_code: "ja" }, { language_code: "ja" },
        { language_code: "fr" },
        { language_code: "de" },
      ],
    }) as never)

    const count = await distinctLanguagesTranslatedToday()
    expect(count).toBe(3)
  })

  it("returns 0 when nothing was translated in the window", async () => {
    vi.mocked(supabaseAdmin.from).mockReturnValue(makeSelectChain({ data: [] }) as never)
    const count = await distinctLanguagesTranslatedToday()
    expect(count).toBe(0)
  })
})

describe("isBrandNewLanguage", () => {
  beforeEach(() => vi.clearAllMocks())

  it("is true when the language has zero existing rows", async () => {
    vi.mocked(supabaseAdmin.from).mockReturnValue(makeSelectChain({ count: 0 }) as never)
    expect(await isBrandNewLanguage("sw")).toBe(true)
  })

  it("is false once the language has at least one row", async () => {
    vi.mocked(supabaseAdmin.from).mockReturnValue(makeSelectChain({ count: 42 }) as never)
    expect(await isBrandNewLanguage("ja")).toBe(false)
  })
})

describe("MAX_NEW_LANGUAGES_PER_DAY", () => {
  it("is a positive, sane bound", () => {
    expect(MAX_NEW_LANGUAGES_PER_DAY).toBeGreaterThan(0)
    expect(MAX_NEW_LANGUAGES_PER_DAY).toBeLessThan(180)
  })
})
