import { describe, it, expect, vi, beforeEach } from "vitest"
import type { Job } from "@/lib/jobs/queue"

const generateMock = vi.fn(async (..._a: unknown[]) => ({
  languageCode: "cy",
  requested: 100,
  alreadyDone: 0,
  generated: 100,
  failed: 0,
  failedKeys: [],
  noCandidates: false,
  stoppedOnDeadline: false,
  batchesSent: 1,
  batchesFailed: 0,
}))
vi.mock("@/lib/portal/translation-generator", () => ({
  generateTranslationsForLanguage: (...a: unknown[]) => generateMock(...a),
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
const triggerWorkerMock = vi.fn(async () => {})
vi.mock("@/lib/jobs/queue", () => ({
  triggerWorker: () => triggerWorkerMock(),
}))

function makeSupabaseChain(liveJobs: unknown[] = []) {
  const insertedRows: Array<Record<string, unknown>> = []
  const c: Record<string, unknown> = {
    from: vi.fn(() => c),
    select: vi.fn(() => c),
    eq: vi.fn(() => c),
    in: vi.fn(() => c),
    neq: vi.fn(() => c),
    limit: vi.fn(() => Promise.resolve({ data: liveJobs, error: null })),
    insert: vi.fn((rowOrRows: Record<string, unknown> | Array<Record<string, unknown>>) => {
      insertedRows.push(...(Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows]))
      return Promise.resolve({ data: null, error: null })
    }),
  }
  return { chain: c, insertedRows }
}

let supabaseState: ReturnType<typeof makeSupabaseChain>
vi.mock("@/lib/supabase-admin", () => ({
  get supabaseAdmin() {
    return supabaseState.chain
  },
}))

import { handleTranslateLanguage } from "@/lib/jobs/handlers/translate-language"

const job = (payload: Record<string, unknown>): Job => ({ id: "job-1", payload } as unknown as Job)

beforeEach(() => {
  generateMock.mockClear()
  triggerWorkerMock.mockClear()
  supabaseState = makeSupabaseChain([])
})

describe("handleTranslateLanguage", () => {
  it("rejects an invalid payload without calling the generator", async () => {
    const r = await handleTranslateLanguage(job({ language_code: "" }))
    expect(generateMock).not.toHaveBeenCalled()
    expect(r.ok).toBe(false)
  })

  it("translates the dictionary source and chains into the wizard source once done", async () => {
    const r = await handleTranslateLanguage(job({ language_code: "cy", language_name: "Welsh", source: "dictionary" }))
    expect(generateMock).toHaveBeenCalledTimes(1)
    expect(generateMock.mock.calls[0][0]).toBe("cy")
    expect(generateMock.mock.calls[0][1]).toBe("Welsh")
    expect(r.ok).not.toBe(false)
    // Chained a continuation job for the wizard source, not another dictionary chunk.
    expect(supabaseState.insertedRows).toHaveLength(1)
    expect(supabaseState.insertedRows[0]).toMatchObject({
      job_type: "translate_language",
      payload: { language_code: "cy", source: "wizard", chunk_index: 0, auto_retry: 0 },
    })
    // REGRESSION GUARD (2026-08-23): the insert alone never kicked anything —
    // a raw job_queue insert, unlike enqueueJob(), doesn't self-trigger. A
    // real client's language pick sat on an un-picked-up chunk for minutes
    // with nothing visibly happening until the 5-minute safety cron caught
    // it. Every continuation insert must also call triggerWorker().
    expect(triggerWorkerMock).toHaveBeenCalledTimes(1)
  })

  it("does not enqueue a duplicate wizard-source job when one is already live (same gap as the dictionary continuation guard, found in review)", async () => {
    supabaseState = makeSupabaseChain([{ id: "already-live-wizard" }])
    const r = await handleTranslateLanguage(job({ language_code: "cy", language_name: "Welsh", source: "dictionary" }))
    expect(r.ok).not.toBe(false)
    expect(supabaseState.insertedRows).toHaveLength(0)
    expect(r.steps.some(s => s.name === "chain_next_source" && s.status === "skipped")).toBe(true)
    expect(triggerWorkerMock).not.toHaveBeenCalled()
  })

  it("re-enqueues the SAME source as a continuation when the batch loop stopped on the deadline", async () => {
    generateMock.mockResolvedValueOnce({
      languageCode: "cy", requested: 1000, alreadyDone: 0, generated: 150, failed: 0, failedKeys: [],
      noCandidates: false, stoppedOnDeadline: true, batchesSent: 1, batchesFailed: 0,
    })
    const r = await handleTranslateLanguage(
      job({ language_code: "cy", language_name: "Welsh", source: "dictionary", chunk_index: 0 }),
      { deadlineAt: Date.now() + 10_000 },
    )
    expect(r.ok).not.toBe(false)
    expect(supabaseState.insertedRows).toHaveLength(1)
    expect(supabaseState.insertedRows[0]).toMatchObject({
      job_type: "translate_language",
      payload: { language_code: "cy", source: "dictionary", chunk_index: 1, auto_retry: 0 },
    })
    expect(triggerWorkerMock).toHaveBeenCalledTimes(1)
  })

  it("does not enqueue a duplicate continuation when another chain job for the same language+source is already live", async () => {
    generateMock.mockResolvedValueOnce({
      languageCode: "cy", requested: 1000, alreadyDone: 0, generated: 150, failed: 0, failedKeys: [],
      noCandidates: false, stoppedOnDeadline: true, batchesSent: 1, batchesFailed: 0,
    })
    supabaseState = makeSupabaseChain([{ id: "already-live" }])
    const r = await handleTranslateLanguage(
      job({ language_code: "cy", language_name: "Welsh", source: "dictionary", chunk_index: 0 }),
      { deadlineAt: Date.now() + 10_000 },
    )
    expect(r.ok).not.toBe(false)
    expect(supabaseState.insertedRows).toHaveLength(0)
    expect(r.steps.some(s => s.name === "chain_continuation" && s.status === "skipped")).toBe(true)
    expect(triggerWorkerMock).not.toHaveBeenCalled()
  })

  it("defers the runner on a zero-batch late-claim stop, without marking the job failed", async () => {
    generateMock.mockResolvedValueOnce({
      languageCode: "cy", requested: 1000, alreadyDone: 0, generated: 0, failed: 0, failedKeys: [],
      noCandidates: false, stoppedOnDeadline: true, batchesSent: 0, batchesFailed: 0,
    })
    const r = await handleTranslateLanguage(
      job({ language_code: "cy", language_name: "Welsh", source: "dictionary", chunk_index: 3 }),
      { deadlineAt: Date.now() + 10_000 },
    )
    expect(r.ok).not.toBe(false)
    expect(r.deferRunner).toBe(true)
  })

  it("halts without chaining when nothing progressed and it wasn't a late-claim deadline stop", async () => {
    generateMock.mockResolvedValueOnce({
      languageCode: "cy", requested: 1000, alreadyDone: 0, generated: 0, failed: 5, failedKeys: ["a", "b"],
      noCandidates: false, stoppedOnDeadline: false, batchesSent: 1, batchesFailed: 1,
    })
    const r = await handleTranslateLanguage(job({ language_code: "cy", language_name: "Welsh", source: "dictionary" }))
    expect(r.ok).toBe(false)
    expect(supabaseState.insertedRows).toHaveLength(0)
  })

  it("translates the wizard source and chains into the guide source once done (three-source chain, not two)", async () => {
    const r = await handleTranslateLanguage(job({ language_code: "cy", language_name: "Welsh", source: "wizard" }))
    expect(r.ok).not.toBe(false)
    expect(supabaseState.insertedRows).toHaveLength(1)
    expect(supabaseState.insertedRows[0]).toMatchObject({
      job_type: "translate_language",
      payload: { language_code: "cy", source: "guide", chunk_index: 0, auto_retry: 0 },
    })
    expect(triggerWorkerMock).toHaveBeenCalledTimes(1)
  })

  it("finishes cleanly with no continuation when the guide source is done (end of the whole chain)", async () => {
    const r = await handleTranslateLanguage(job({ language_code: "cy", language_name: "Welsh", source: "guide" }))
    expect(r.ok).not.toBe(false)
    expect(supabaseState.insertedRows).toHaveLength(0)
  })

  it("does not enqueue a duplicate guide-source job when one is already live", async () => {
    supabaseState = makeSupabaseChain([{ id: "already-live-guide" }])
    const r = await handleTranslateLanguage(job({ language_code: "cy", language_name: "Welsh", source: "wizard" }))
    expect(r.ok).not.toBe(false)
    expect(supabaseState.insertedRows).toHaveLength(0)
    expect(r.steps.some(s => s.name === "chain_next_source" && s.status === "skipped")).toBe(true)
    expect(triggerWorkerMock).not.toHaveBeenCalled()
  })

  it("finishes with nothing to do when the source has no missing keys at all", async () => {
    generateMock.mockResolvedValueOnce({
      languageCode: "cy", requested: 100, alreadyDone: 100, generated: 0, failed: 0, failedKeys: [],
      noCandidates: true, stoppedOnDeadline: false, batchesSent: 0, batchesFailed: 0,
    })
    const r = await handleTranslateLanguage(job({ language_code: "cy", language_name: "Welsh", source: "guide" }))
    expect(r.ok).not.toBe(false)
    expect(supabaseState.insertedRows).toHaveLength(0)
  })
})
