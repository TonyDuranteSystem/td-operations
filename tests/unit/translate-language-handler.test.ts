import { describe, it, expect, vi, beforeEach } from "vitest"
import type { Job } from "@/lib/jobs/queue"
import type { GenerateResult } from "@/lib/portal/translation-generator"

const generateMock = vi.fn<(..._a: unknown[]) => Promise<GenerateResult>>(async () => ({
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
// Default: nextSource always has missing work, so the chain-hop branch's
// cheap "anything to do?" check doesn't skip in tests that don't care about
// it. Override per-test with mockResolvedValueOnce for the "already fully
// translated" skip-branch test.
const seedMock = vi.fn(async (..._a: unknown[]) => ({ requested: 10, alreadyDone: 0, missing: 10 }))
vi.mock("@/lib/portal/translation-generator", () => ({
  generateTranslationsForLanguage: (...a: unknown[]) => generateMock(...a),
  seedPendingTranslations: (...a: unknown[]) => seedMock(...a),
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

/**
 * liveBefore: rows returned by the pre-insert dedup check (`.limit(1)`).
 * liveAfter: rows returned by the post-insert race-verify check (no
 * `.limit()` — the real supabase-js builder is itself thenable, so the mock
 * chain needs its own `then` to resolve that query without an explicit
 * terminal call, same as translation-watchdog.ts's own equivalent check).
 */
function makeSupabaseChain(opts: { liveBefore?: unknown[]; liveAfter?: unknown[] } = {}) {
  const { liveBefore = [], liveAfter = [{ id: "new-job-id" }] } = opts
  const insertedRows: Array<Record<string, unknown>> = []
  const deleteMock = vi.fn(() => c)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c: any = {
    from: vi.fn(() => c),
    select: vi.fn(() => c),
    eq: vi.fn(() => c),
    in: vi.fn(() => c),
    neq: vi.fn(() => c),
    delete: deleteMock,
    limit: vi.fn(() => Promise.resolve({ data: liveBefore, error: null })),
    single: vi.fn(() => Promise.resolve({ data: { id: "new-job-id" }, error: null })),
    insert: vi.fn((rowOrRows: Record<string, unknown> | Array<Record<string, unknown>>) => {
      insertedRows.push(...(Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows]))
      return c // chainable: insert(...).select("id").single()
    }),
    // Makes a bare `await db.from(...).select(...).in(...).eq(...).eq(...)`
    // (no explicit terminal call) resolve, matching real supabase-js.
    then: (resolve: (v: { data: unknown; error: null }) => void) => resolve({ data: liveAfter, error: null }),
  }
  return { chain: c, insertedRows, deleteMock }
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
  seedMock.mockClear()
  triggerWorkerMock.mockClear()
  supabaseState = makeSupabaseChain()
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
    supabaseState = makeSupabaseChain({ liveBefore: [{ id: "already-live-wizard" }] })
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
    supabaseState = makeSupabaseChain({ liveBefore: [{ id: "already-live" }] })
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

  it("halts this source AND chains into the next source when nothing progressed (2026-08-24: a stuck source no longer blocks its siblings — German dictionary incident)", async () => {
    generateMock.mockResolvedValueOnce({
      languageCode: "cy", requested: 1000, alreadyDone: 0, generated: 0, failed: 5, failedKeys: ["a", "b"],
      noCandidates: false, stoppedOnDeadline: false, batchesSent: 1, batchesFailed: 1,
      lastBatchError: "Model did not return submit_translations with a translations object",
    })
    const r = await handleTranslateLanguage(job({ language_code: "cy", language_name: "Welsh", source: "dictionary" }))
    // The dictionary chunk itself is still reported as halted/failed — the
    // watchdog needs this to keep retrying it on its own backoff ladder.
    expect(r.ok).toBe(false)
    expect(r.summary).toContain("Model did not return submit_translations")
    // But wizard got its own chain job started in the same call, instead of
    // waiting for dictionary to succeed or exhaust its retries first.
    expect(supabaseState.insertedRows).toHaveLength(1)
    expect(supabaseState.insertedRows[0]).toMatchObject({
      job_type: "translate_language",
      payload: { language_code: "cy", source: "wizard", chunk_index: 0, auto_retry: 0 },
    })
    expect(triggerWorkerMock).toHaveBeenCalledTimes(1)
  })

  it("skips chaining into a next source that's already fully translated, without inserting a job (avoids re-triggering an already-finished sibling on every watchdog retry of a stuck source)", async () => {
    seedMock.mockResolvedValueOnce({ requested: 10, alreadyDone: 10, missing: 0 })
    generateMock.mockResolvedValueOnce({
      languageCode: "cy", requested: 1000, alreadyDone: 0, generated: 0, failed: 5, failedKeys: ["a"],
      noCandidates: false, stoppedOnDeadline: false, batchesSent: 1, batchesFailed: 1,
    })
    const r = await handleTranslateLanguage(job({ language_code: "cy", language_name: "Welsh", source: "dictionary" }))
    expect(r.ok).toBe(false) // dictionary itself still halted
    expect(supabaseState.insertedRows).toHaveLength(0) // wizard already done — nothing to insert
    expect(r.steps.some(s => s.name === "chain_next_source" && s.status === "skipped" && s.detail?.includes("already fully translated"))).toBe(true)
    expect(triggerWorkerMock).not.toHaveBeenCalled()
  })

  it("deletes its own next-source insert if a concurrent job for the same scope also appeared (post-insert race guard, senior-engineer review finding 2026-08-24)", async () => {
    supabaseState = makeSupabaseChain({ liveBefore: [], liveAfter: [{ id: "new-job-id" }, { id: "concurrent-job" }] })
    const r = await handleTranslateLanguage(job({ language_code: "cy", language_name: "Welsh", source: "dictionary" }))
    expect(r.ok).not.toBe(false)
    // We DID insert (couldn't have known about the race beforehand)...
    expect(supabaseState.insertedRows).toHaveLength(1)
    // ...but then deleted it once the post-insert check saw two live jobs.
    expect(supabaseState.deleteMock).toHaveBeenCalledTimes(1)
    expect(r.steps.some(s => s.name === "chain_next_source" && s.status === "skipped" && s.detail?.includes("race"))).toBe(true)
    expect(triggerWorkerMock).not.toHaveBeenCalled()
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
    supabaseState = makeSupabaseChain({ liveBefore: [{ id: "already-live-guide" }] })
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
