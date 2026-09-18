/**
 * /api/portal/language — saves the preference and kicks off translation work
 * for a locale outside the two hand-written ones. The actual seed+enqueue
 * dedup logic lives in lib/portal/translation-generator.ts::kickoffMissingTranslationWork
 * (dev job 4fa1d8e5, shared with the daily top-up cron) and has its own
 * dedicated coverage in tests/unit/translation-topup.test.ts — this file only
 * covers what the ROUTE itself is responsible for: saving the preference,
 * respecting the daily new-language cap, and calling the shared kickoff with
 * the right language and caller tag.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: () => Promise.resolve({ data: { user: { id: "user-1", user_metadata: {} } } }) },
  }),
}))

vi.mock("@/lib/portal/rate-limit", () => ({
  checkRateLimit: () => ({ allowed: true }),
  getRateLimitKey: () => "rl-key",
}))

const isBrandNewLanguageMock = vi.fn(async () => false)
const distinctLanguagesTranslatedTodayMock = vi.fn(async () => 0)
vi.mock("@/lib/portal/language-cap", () => ({
  isBrandNewLanguage: (...a: unknown[]) => isBrandNewLanguageMock(...a),
  distinctLanguagesTranslatedToday: (...a: unknown[]) => distinctLanguagesTranslatedTodayMock(...a),
  MAX_NEW_LANGUAGES_PER_DAY: 8,
}))

const kickoffMock = vi.fn(async () => ({ source: "dictionary", missing: 100 }))
vi.mock("@/lib/portal/translation-generator", () => ({
  kickoffMissingTranslationWork: (...a: unknown[]) => kickoffMock(...a),
}))

let updateUserByIdError: unknown = null
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    auth: { admin: { updateUserById: () => Promise.resolve({ error: updateUserByIdError }) } },
  },
}))

import { POST } from "@/app/api/portal/language/route"

function req(language: string) {
  return new Request("https://x/api/portal/language", {
    method: "POST",
    body: JSON.stringify({ language }),
    headers: { "content-type": "application/json" },
  }) as unknown as import("next/server").NextRequest
}

beforeEach(() => {
  kickoffMock.mockClear()
  isBrandNewLanguageMock.mockClear().mockResolvedValue(false)
  distinctLanguagesTranslatedTodayMock.mockClear().mockResolvedValue(0)
  updateUserByIdError = null
})

describe("POST /api/portal/language", () => {
  it("rejects a string that isn't a recognized ISO language code", async () => {
    const res = await POST(req("not-a-real-language"))
    expect(res.status).toBe(400)
    expect(kickoffMock).not.toHaveBeenCalled()
  })

  it("saves en/it without kicking off any translation work — they're the hand-written dictionaries, not AI-generated", async () => {
    const res = await POST(req("it"))
    expect(res.status).toBe(200)
    expect(kickoffMock).not.toHaveBeenCalled()
  })

  it("kicks off the shared translation work for a non-hand-written locale, tagged as the language picker", async () => {
    const res = await POST(req("fr"))
    expect(res.status).toBe(200)
    expect(kickoffMock).toHaveBeenCalledTimes(1)
    expect(kickoffMock).toHaveBeenCalledWith("fr", "portal-language-picker")
  })

  it("skips the kickoff (but still saves the preference) when the daily brand-new-language cap is reached", async () => {
    isBrandNewLanguageMock.mockResolvedValueOnce(true)
    distinctLanguagesTranslatedTodayMock.mockResolvedValueOnce(8)
    const res = await POST(req("fr"))
    expect(res.status).toBe(200)
    expect(kickoffMock).not.toHaveBeenCalled()
  })

  it("still saves the preference even when the translation kickoff throws", async () => {
    kickoffMock.mockRejectedValueOnce(new Error("boom"))
    const res = await POST(req("fr"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
  })

  it("returns 500 when saving the preference itself fails", async () => {
    updateUserByIdError = new Error("db down")
    const res = await POST(req("fr"))
    expect(res.status).toBe(500)
    expect(kickoffMock).not.toHaveBeenCalled()
  })
})
