/**
 * /api/cron/portal-translation-catchup — the periodic sweep that re-checks
 * every language a real client currently has selected against the current
 * translation content sources (dev job 12cab351, 2026-08-25). Covers: auth
 * gate, scoping to only currently-active non-en/it languages (not every
 * language that ever got a portal_translations row), dedup across users
 * sharing a language, and per-language fault isolation.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest"

vi.mock("@/lib/cron-log", () => ({ logCron: vi.fn() }))

const listAllAuthUsersMock = vi.fn()
vi.mock("@/lib/auth-admin-helpers", () => ({
  listAllAuthUsers: (...a: unknown[]) => listAllAuthUsersMock(...a),
}))

const catchUpLanguageMock = vi.fn()
vi.mock("@/lib/portal/language-catchup", () => ({
  catchUpLanguage: (...a: unknown[]) => catchUpLanguageMock(...a),
}))

import { GET } from "@/app/api/cron/portal-translation-catchup/route"

function req() {
  return new Request("https://x/api/cron/portal-translation-catchup", {
    headers: { authorization: "Bearer test-secret" },
  }) as unknown as import("next/server").NextRequest
}

const originalSecret = process.env.CRON_SECRET

beforeEach(() => {
  process.env.CRON_SECRET = "test-secret"
  listAllAuthUsersMock.mockReset()
  catchUpLanguageMock.mockReset()
})

afterAll(() => {
  if (originalSecret !== undefined) process.env.CRON_SECRET = originalSecret
  else delete process.env.CRON_SECRET
})

describe("GET /api/cron/portal-translation-catchup", () => {
  it("rejects a request without the correct cron secret", async () => {
    listAllAuthUsersMock.mockResolvedValue([])
    const badReq = new Request("https://x/api/cron/portal-translation-catchup", {
      headers: { authorization: "Bearer wrong" },
    }) as unknown as import("next/server").NextRequest
    const res = await GET(badReq)
    expect(res.status).toBe(401)
    expect(catchUpLanguageMock).not.toHaveBeenCalled()
  })

  it("only sweeps languages OUTSIDE the hand-written en/it set, deduped across users", async () => {
    listAllAuthUsersMock.mockResolvedValue([
      { user_metadata: { portal_language: "es" } },
      { user_metadata: { portal_language: "en" } }, // hand-written — never swept
      { user_metadata: { portal_language: "it" } }, // hand-written — never swept
      { user_metadata: { portal_language: "es" } }, // second Spanish user — deduped, not a second call
      { user_metadata: {} }, // no preference set — ignored
      { user_metadata: { portal_language: "fr" } },
    ])
    catchUpLanguageMock.mockResolvedValue({ enqueued: false })
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(catchUpLanguageMock).toHaveBeenCalledTimes(2) // es, fr — once each, not per-user
    const calledLangs = catchUpLanguageMock.mock.calls.map((c) => c[0]).sort()
    expect(calledLangs).toEqual(["es", "fr"])
  })

  it("REGRESSION GUARD: a language nobody currently has selected (e.g. a stale admin test pick) is never swept — only auth.users' CURRENT preference counts, not every language that ever got a portal_translations row", async () => {
    listAllAuthUsersMock.mockResolvedValue([{ user_metadata: { portal_language: "hu" } }])
    catchUpLanguageMock.mockResolvedValue({ enqueued: false })
    await GET(req())
    expect(catchUpLanguageMock).toHaveBeenCalledTimes(1)
    expect(catchUpLanguageMock).toHaveBeenCalledWith("hu", expect.any(String))
  })

  it("reports per-language outcomes and isolates one language's failure from the rest", async () => {
    listAllAuthUsersMock.mockResolvedValue([
      { user_metadata: { portal_language: "es" } },
      { user_metadata: { portal_language: "fr" } },
    ])
    catchUpLanguageMock.mockImplementation(async (lang: string) => {
      if (lang === "es") throw new Error("AI call failed")
      return { enqueued: true, source: "guide" }
    })
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.checked).toBe(2)
    expect(body.caughtUp).toBe(1)
    expect(body.errored).toBe(1)
    const esResult = body.results.find((r: { language: string }) => r.language === "es")
    expect(esResult.outcome).toMatch(/^error: AI call failed/)
    const frResult = body.results.find((r: { language: string }) => r.language === "fr")
    expect(frResult.outcome).toBe("caught up (guide)")
  })
})
