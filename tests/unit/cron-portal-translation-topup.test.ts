/**
 * /api/cron/portal-translation-topup (dev job 4fa1d8e5) — the daily trigger
 * that keeps already-established portal languages current automatically,
 * instead of only translating new text when a client happens to reselect
 * that language. All the real seed/enqueue logic lives in and is tested via
 * lib/portal/translation-generator.ts (tests/unit/translation-topup.test.ts)
 * — this file only covers what the CRON itself is responsible for: auth,
 * iterating every established language, and never letting one language's
 * failure stop the rest of the run.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/cron-log", () => ({ logCron: vi.fn() }))

let establishedLanguages: string[] = []
const kickoffMock = vi.fn(async (lang: string) => (lang === "es" ? { source: "dictionary", missing: 5 } : null))
vi.mock("@/lib/portal/translation-generator", () => ({
  getEstablishedLanguageCodes: () => Promise.resolve(establishedLanguages),
  kickoffMissingTranslationWork: (...a: unknown[]) => kickoffMock(...a),
}))

import { GET } from "@/app/api/cron/portal-translation-topup/route"
import { logCron } from "@/lib/cron-log"

function req(secret?: string) {
  return new Request("https://x/api/cron/portal-translation-topup", {
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  }) as unknown as import("next/server").NextRequest
}

beforeEach(() => {
  kickoffMock.mockClear()
  vi.mocked(logCron).mockClear()
  establishedLanguages = []
  process.env.CRON_SECRET = "test-secret"
})

describe("GET /api/cron/portal-translation-topup", () => {
  it("rejects a request without the correct cron secret", async () => {
    const res = await req("wrong-secret")
    const result = await GET(res)
    expect(result.status).toBe(401)
    expect(kickoffMock).not.toHaveBeenCalled()
  })

  it("checks every established language and reports what got queued", async () => {
    establishedLanguages = ["es", "de", "fr"]
    const res = await GET(req("test-secret"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(kickoffMock).toHaveBeenCalledTimes(3)
    expect(kickoffMock).toHaveBeenCalledWith("es", "portal-translation-topup-cron")
    expect(body.totalEstablished).toBe(3)
    expect(body.checked).toBe(3)
    expect(body.queued).toBe(1) // only "es" returns a non-null outcome from the mock
  })

  it("caps how many established languages it processes in one run, so one content push can't fan out into unbounded simultaneous paid AI chains", async () => {
    // MAX_LANGUAGES_PER_TOPUP_RUN is 10 (lib/portal/language-cap.ts) — 12 established languages should only process the first 10.
    establishedLanguages = Array.from({ length: 12 }, (_, i) => `lang${i}`)
    const res = await GET(req("test-secret"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(kickoffMock).toHaveBeenCalledTimes(10)
    expect(body.totalEstablished).toBe(12)
    expect(body.checked).toBe(10)
  })

  it("never lets one language's failure stop the rest of the run", async () => {
    establishedLanguages = ["es", "de", "fr"]
    kickoffMock.mockImplementationOnce(async () => { throw new Error("db hiccup") })
    const res = await GET(req("test-secret"))
    expect(res.status).toBe(200)
    expect(kickoffMock).toHaveBeenCalledTimes(3)
    const body = await res.json()
    expect(body.checked).toBe(3)
  })

  it("logs the run via logCron", async () => {
    establishedLanguages = ["es"]
    await GET(req("test-secret"))
    expect(logCron).toHaveBeenCalledTimes(1)
    expect(vi.mocked(logCron).mock.calls[0][0]).toMatchObject({ endpoint: "portal-translation-topup", status: "success" })
  })
})
