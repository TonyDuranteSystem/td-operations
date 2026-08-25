/**
 * lib/portal/language-catchup.ts — the shared seed/enqueue loop extracted
 * from the language-picker route (dev job 12cab351, 2026-08-25) so the
 * periodic catch-up sweep (app/api/cron/portal-translation-catchup) doesn't
 * hand-roll a second copy. Covers the three outcomes catchUpLanguage can
 * report (fully translated / caught up / already running) plus the
 * dedup guard hasLiveTranslateJob backs.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const seedPendingTranslationsMock = vi.fn()
vi.mock("@/lib/portal/translation-generator", () => ({
  seedPendingTranslations: (...a: unknown[]) => seedPendingTranslationsMock(...a),
}))
vi.mock("@/lib/portal/i18n", () => ({
  getEnglishDictionary: () => ({ "nav.chat": "Chat" }),
}))
vi.mock("@/lib/portal/wizard-translatable-text", () => ({
  getWizardTranslatableText: () => ({ "First Name": "First Name" }),
}))
vi.mock("@/lib/portal/guide-translatable-text", () => ({
  getGuideTranslatableText: () => ({ "Portal Guide": "Portal Guide" }),
}))

const enqueueJobMock = vi.fn(async () => ({ id: "job-new" }))
vi.mock("@/lib/jobs/queue", () => ({
  enqueueJob: (...a: unknown[]) => enqueueJobMock(...a),
}))

let liveJobs: unknown[] = []
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: () => {
      const chain: Record<string, unknown> = {}
      const noop = () => chain
      chain.select = noop
      chain.eq = noop
      chain.in = noop
      chain.limit = () => Promise.resolve({ data: liveJobs, error: null })
      return chain
    },
  },
}))

import { catchUpLanguage, hasLiveTranslateJob } from "@/lib/portal/language-catchup"

beforeEach(() => {
  seedPendingTranslationsMock.mockReset()
  enqueueJobMock.mockClear()
  liveJobs = []
})

describe("catchUpLanguage", () => {
  it("reports fully translated (no enqueue) when every source has zero missing work", async () => {
    seedPendingTranslationsMock.mockResolvedValue({ requested: 10, alreadyDone: 10, missing: 0 })
    const result = await catchUpLanguage("es", "Spanish")
    expect(seedPendingTranslationsMock).toHaveBeenCalledTimes(3) // dictionary, wizard, guide all checked
    expect(enqueueJobMock).not.toHaveBeenCalled()
    expect(result).toEqual({ enqueued: false })
  })

  it("enqueues the FIRST source with missing work and stops checking further sources", async () => {
    seedPendingTranslationsMock
      .mockResolvedValueOnce({ requested: 10, alreadyDone: 10, missing: 0 }) // dictionary: done
      .mockResolvedValueOnce({ requested: 5, alreadyDone: 0, missing: 5 })   // wizard: missing — stop here
    const result = await catchUpLanguage("es", "Spanish")
    expect(seedPendingTranslationsMock).toHaveBeenCalledTimes(2) // never reaches guide
    expect(enqueueJobMock).toHaveBeenCalledTimes(1)
    expect(enqueueJobMock.mock.calls[0][0]).toMatchObject({
      job_type: "translate_language",
      payload: { language_code: "es", language_name: "Spanish", source: "wizard", chunk_index: 0, auto_retry: 0 },
    })
    expect(result).toEqual({ enqueued: true, source: "wizard" })
  })

  it("reports already-running (no duplicate enqueue) when a job for the missing source is already live", async () => {
    seedPendingTranslationsMock.mockResolvedValueOnce({ requested: 10, alreadyDone: 0, missing: 10 })
    liveJobs = [{ id: "already-live" }]
    const result = await catchUpLanguage("fr", "French")
    expect(enqueueJobMock).not.toHaveBeenCalled()
    expect(result).toEqual({ enqueued: false, source: "dictionary", alreadyRunning: true })
  })

  it("REGRESSION GUARD: a language missing only the LAST source (guide) still gets caught up — the exact Spanish/French real-world shape (dictionary+wizard already done, guide added later)", async () => {
    seedPendingTranslationsMock
      .mockResolvedValueOnce({ requested: 10, alreadyDone: 10, missing: 0 }) // dictionary: done
      .mockResolvedValueOnce({ requested: 5, alreadyDone: 5, missing: 0 })   // wizard: done
      .mockResolvedValueOnce({ requested: 200, alreadyDone: 0, missing: 200 }) // guide: missing
    const result = await catchUpLanguage("fr", "French")
    expect(seedPendingTranslationsMock).toHaveBeenCalledTimes(3)
    expect(enqueueJobMock.mock.calls[0][0]).toMatchObject({
      payload: { language_code: "fr", source: "guide" },
    })
    expect(result).toEqual({ enqueued: true, source: "guide" })
  })
})

describe("hasLiveTranslateJob", () => {
  it("returns false when nothing is live", async () => {
    liveJobs = []
    expect(await hasLiveTranslateJob("de", "wizard")).toBe(false)
  })

  it("returns true when a live job exists", async () => {
    liveJobs = [{ id: "x" }]
    expect(await hasLiveTranslateJob("de", "wizard")).toBe(true)
  })
})
