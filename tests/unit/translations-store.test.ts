import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: { from: vi.fn() },
}))

import { loadTranslationsForLocale } from "@/lib/portal/translations-store"
import { supabaseAdmin } from "@/lib/supabase-admin"

/** Fixed-result chain: every `.range()` call resolves to the same result. */
function chain(result: { data: unknown[] | null; error: unknown }) {
  const c: Record<string, unknown> = {
    select: vi.fn(() => c),
    eq: vi.fn(() => c),
    order: vi.fn(() => c),
    range: vi.fn(() => c),
    then: (resolve: (v: typeof result) => unknown) => resolve(result),
  }
  return c
}

/**
 * Range-aware chain: resolves per-page from an in-memory row list, exactly
 * like PostgREST's real .range(from, to) pagination — used to prove
 * fetchAllPaged actually walks past a single page instead of truncating.
 */
function pagedChain(allRows: { key: string; translated_text: string }[]) {
  const c: Record<string, unknown> = {
    select: vi.fn(() => c),
    eq: vi.fn(() => c),
    order: vi.fn(() => c),
    range: vi.fn((from: number, to: number) => ({
      then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
        resolve({ data: allRows.slice(from, to + 1), error: null }),
    })),
  }
  return c
}

describe("loadTranslationsForLocale", () => {
  beforeEach(() => vi.clearAllMocks())

  it("short-circuits to {} for a SUPPORTED_LOCALES language without querying the database", async () => {
    const result = await loadTranslationsForLocale("en")
    expect(result).toEqual({})
    expect(supabaseAdmin.from).not.toHaveBeenCalled()

    const resultIt = await loadTranslationsForLocale("it")
    expect(resultIt).toEqual({})
    expect(supabaseAdmin.from).not.toHaveBeenCalled()
  })

  it("builds a flat key -> translated_text map for a generated language", async () => {
    vi.mocked(supabaseAdmin.from).mockReturnValue(
      chain({
        data: [
          { key: "nav.myCompany", translated_text: "私の会社" },
          { key: "nav.chat", translated_text: "チャット" },
        ],
        error: null,
      }) as never,
    )

    const result = await loadTranslationsForLocale("ja")
    expect(result).toEqual({
      "nav.myCompany": "私の会社",
      "nav.chat": "チャット",
    })
  })

  it("returns {} on a query error instead of throwing — a lookup failure must fall back to English, never break the page", async () => {
    vi.mocked(supabaseAdmin.from).mockReturnValue(
      chain({ data: null, error: { message: "boom" } }) as never,
    )

    const result = await loadTranslationsForLocale("ja")
    expect(result).toEqual({})
  })

  it("returns {} for a language with no generated rows yet (nothing pending/done)", async () => {
    vi.mocked(supabaseAdmin.from).mockReturnValue(
      chain({ data: [], error: null }) as never,
    )

    const result = await loadTranslationsForLocale("hu")
    expect(result).toEqual({})
  })

  it("reads past PostgREST's 1000-row page cap instead of silently truncating (2026-08-22 incident)", async () => {
    // 1,095 rows — the exact real count that first exposed this: an
    // unpaginated query returned only the first 1000, so any key whose row
    // landed past that cutoff silently fell back to English with no error.
    const allRows = Array.from({ length: 1095 }, (_, i) => ({
      key: `key.${i}`,
      translated_text: `訳${i}`,
    }))
    vi.mocked(supabaseAdmin.from).mockReturnValue(pagedChain(allRows) as never)

    const result = await loadTranslationsForLocale("ja")

    expect(Object.keys(result)).toHaveLength(1095)
    // Specifically prove a key past the old 1000-row cutoff is present.
    expect(result["key.1094"]).toBe("訳1094")
    expect(result["key.0"]).toBe("訳0")
  })
})
