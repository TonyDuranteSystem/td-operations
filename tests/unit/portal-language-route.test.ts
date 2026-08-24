/**
 * /api/portal/language — dedup regression guard (found in review, 2026-08-23).
 *
 * The job handler's own chain-continuation dedup only protects chunk-to-chunk
 * WITHIN an already-running chain. This route's own enqueue (the very first
 * chunk-0 job for a language) had no equivalent guard — two picks of the same
 * never-before-seen language in quick succession could each start their own
 * job. These tests cover only that guard; the rest of the route's behavior
 * (auth, rate limit, cap) is exercised elsewhere / is straightforward enough
 * not to need its own harness here.
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

vi.mock("@/lib/portal/language-cap", () => ({
  isBrandNewLanguage: () => Promise.resolve(false),
  distinctLanguagesTranslatedToday: () => Promise.resolve(0),
  MAX_NEW_LANGUAGES_PER_DAY: 8,
}))

const seedPendingTranslationsMock = vi.fn(async () => ({ requested: 100, alreadyDone: 0, missing: 100 }))
vi.mock("@/lib/portal/translation-generator", () => ({
  seedPendingTranslations: (...a: unknown[]) => seedPendingTranslationsMock(...a),
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
    auth: { admin: { updateUserById: () => Promise.resolve({ error: null }) } },
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

import { POST } from "@/app/api/portal/language/route"

function req(language: string) {
  return new Request("https://x/api/portal/language", {
    method: "POST",
    body: JSON.stringify({ language }),
    headers: { "content-type": "application/json" },
  }) as unknown as import("next/server").NextRequest
}

beforeEach(() => {
  seedPendingTranslationsMock.mockClear()
  enqueueJobMock.mockClear()
  liveJobs = []
})

describe("POST /api/portal/language — dictionary enqueue dedup", () => {
  it("enqueues a translate job for a brand-new pick with nothing already live", async () => {
    const res = await POST(req("fr"))
    expect(res.status).toBe(200)
    expect(enqueueJobMock).toHaveBeenCalledTimes(1)
    expect(enqueueJobMock.mock.calls[0][0]).toMatchObject({
      job_type: "translate_language",
      payload: { language_code: "fr", source: "dictionary", chunk_index: 0, auto_retry: 0 },
    })
  })

  it("does NOT enqueue a duplicate job when a dictionary-source job for this language is already live", async () => {
    liveJobs = [{ id: "already-live" }]
    const res = await POST(req("fr"))
    expect(res.status).toBe(200)
    expect(enqueueJobMock).not.toHaveBeenCalled()
    // The preference itself is still saved regardless — never block the pick.
  })

  it("does NOT enqueue a duplicate wizard-source job when one is already live and the dictionary is already fully seeded", async () => {
    seedPendingTranslationsMock.mockResolvedValueOnce({ requested: 100, alreadyDone: 100, missing: 0 })
    liveJobs = [{ id: "already-live-wizard" }]
    const res = await POST(req("fr"))
    expect(res.status).toBe(200)
    expect(enqueueJobMock).not.toHaveBeenCalled()
  })

  it("falls through to the guide source when both dictionary and wizard are already fully seeded (a returning language whose help-article content still lags)", async () => {
    seedPendingTranslationsMock
      .mockResolvedValueOnce({ requested: 100, alreadyDone: 100, missing: 0 }) // dictionary: done
      .mockResolvedValueOnce({ requested: 50, alreadyDone: 50, missing: 0 })   // wizard: done
      .mockResolvedValueOnce({ requested: 200, alreadyDone: 0, missing: 200 }) // guide: still missing
    const res = await POST(req("fr"))
    expect(res.status).toBe(200)
    expect(seedPendingTranslationsMock).toHaveBeenCalledTimes(3)
    expect(enqueueJobMock).toHaveBeenCalledTimes(1)
    expect(enqueueJobMock.mock.calls[0][0]).toMatchObject({
      job_type: "translate_language",
      payload: { language_code: "fr", source: "guide", chunk_index: 0, auto_retry: 0 },
    })
  })
})
