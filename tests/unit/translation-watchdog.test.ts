import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/portal/i18n", () => ({
  getEnglishDictionary: () => ({ "nav.chat": "Chat", "nav.profile": "Profile" }),
}))
vi.mock("@/lib/portal/wizard-translatable-text", () => ({
  getWizardTranslatableText: () => ({ "First Name": "First Name" }),
}))
vi.mock("@/lib/portal/guide-translatable-text", () => ({
  getGuideTranslatableText: () => ({ "Portal Guide": "Portal Guide" }),
}))

const gmailPostMock = vi.fn(async () => ({}))
vi.mock("@/lib/gmail", () => ({ gmailPost: (...a: unknown[]) => gmailPostMock(...a) }))

interface FakeState {
  jobQueueRows: Array<{ id: string; status: string; completed_at: string | null; payload: Record<string, unknown> }>
  translationRows: Array<{ key: string; status: string }>
  existingAlert: unknown[]
  inserted: Array<Record<string, unknown>>
  deletedIds: string[]
  /** live-count returned by the post-insert verify SELECT, after our own insert */
  postInsertLiveCount: number
}

function makeState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    jobQueueRows: [],
    translationRows: [],
    existingAlert: [],
    inserted: [],
    deletedIds: [],
    postInsertLiveCount: 1,
    ...overrides,
  }
}

let state: FakeState

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "job_queue") {
        const chain: Record<string, unknown> = {}
        let mode: "scope" | "verify" = "scope"
        chain.select = (cols: string) => {
          mode = cols === "id" ? "verify" : "scope"
          return chain
        }
        chain.eq = () => chain
        chain.in = () => chain
        chain.gte = () => chain
        chain.order = () => chain
        chain.limit = () => Promise.resolve(mode === "verify"
          ? { data: Array.from({ length: state.postInsertLiveCount }, (_, i) => ({ id: `live-${i}` })), error: null }
          : { data: state.jobQueueRows, error: null })
        // The verify query (select→in→eq→eq→eq) has no terminal .limit() in
        // the real source, matching the already-proven chain-watchdog.ts
        // pattern — the real supabase-js chain is itself thenable. Mirror
        // that here so a bare `await` on the chain resolves correctly.
        chain.then = (resolve: (v: { data: unknown; error: null }) => unknown) =>
          resolve(mode === "verify"
            ? { data: Array.from({ length: state.postInsertLiveCount }, (_, i) => ({ id: `live-${i}` })), error: null }
            : { data: state.jobQueueRows, error: null })
        chain.insert = (row: Record<string, unknown>) => {
          state.inserted.push(row)
          return { select: () => ({ single: () => Promise.resolve({ data: { id: "new-job-id" }, error: null }) }) }
        }
        chain.delete = () => ({
          eq: (_col: string, id: string) => { state.deletedIds.push(id); return Promise.resolve({ data: null, error: null }) },
        })
        return chain
      }
      if (table === "portal_translations") {
        const chain: Record<string, unknown> = {}
        chain.select = () => chain
        chain.eq = () => chain
        chain.range = (from: number) => Promise.resolve({ data: from === 0 ? state.translationRows : [], error: null })
        return chain
      }
      if (table === "action_log") {
        const chain: Record<string, unknown> = {}
        chain.select = () => chain
        chain.eq = () => chain
        chain.limit = () => Promise.resolve({ data: state.existingAlert, error: null })
        chain.insert = (row: Record<string, unknown>) => { state.inserted.push({ __table: "action_log", ...row }); return Promise.resolve({ data: null, error: null }) }
        return chain
      }
      throw new Error(`unexpected table in test: ${table}`)
    },
  },
}))

import { runTranslationWatchdog } from "@/lib/jobs/translation-watchdog"

beforeEach(() => {
  gmailPostMock.mockClear()
  state = makeState()
})

const DONE_ROW = { key: "nav.chat", status: "done" }
const PENDING_ROW = { key: "nav.profile", status: "pending" }

describe("runTranslationWatchdog", () => {
  it("does nothing for a scope that's still running (a live job exists)", async () => {
    state = makeState({
      jobQueueRows: [{ id: "j1", status: "pending", completed_at: null, payload: { language_code: "fr", language_name: "French", source: "dictionary" } }],
    })
    const r = await runTranslationWatchdog(Date.now())
    expect(r.scopes).toBe(1)
    expect(r.reEnqueued).toHaveLength(0)
    expect(state.inserted).toHaveLength(0)
  })

  it("does nothing for a scope that never ran (no terminal job)", async () => {
    const r = await runTranslationWatchdog(Date.now())
    expect(r.scopes).toBe(0)
  })

  it("does NOT retry yet when the backoff window hasn't elapsed", async () => {
    const now = Date.now()
    state = makeState({
      jobQueueRows: [{
        id: "j1", status: "failed", completed_at: new Date(now - 60_000).toISOString(), // 1 min ago
        payload: { language_code: "fr", language_name: "French", source: "dictionary", auto_retry: 0 },
      }],
      translationRows: [DONE_ROW, PENDING_ROW], // 1 candidate remaining
    })
    const r = await runTranslationWatchdog(now)
    expect(r.reEnqueued).toHaveLength(0)
    expect(state.inserted).toHaveLength(0)
  })

  it("re-enqueues on the backoff ladder once the window elapses, incrementing auto_retry", async () => {
    const now = Date.now()
    state = makeState({
      jobQueueRows: [{
        id: "j1", status: "failed", completed_at: new Date(now - 20 * 60_000).toISOString(), // 20 min ago, past the 15-min first rung
        payload: { language_code: "fr", language_name: "French", source: "dictionary", auto_retry: 0 },
      }],
      translationRows: [DONE_ROW, PENDING_ROW],
      postInsertLiveCount: 1, // only our own insert is live — no compensating delete
    })
    const r = await runTranslationWatchdog(now)
    expect(r.reEnqueued).toEqual(["translate:fr:dictionary"])
    expect(state.inserted).toHaveLength(1)
    expect(state.inserted[0]).toMatchObject({
      job_type: "translate_language",
      payload: { language_code: "fr", language_name: "French", source: "dictionary", chunk_index: 0, auto_retry: 1 },
      created_by: "translation-watchdog",
    })
    expect(state.deletedIds).toHaveLength(0)
  })

  it("compensating-deletes its own insert when a concurrent job is already live for the same scope (F3 guard)", async () => {
    const now = Date.now()
    state = makeState({
      jobQueueRows: [{
        id: "j1", status: "failed", completed_at: new Date(now - 20 * 60_000).toISOString(),
        payload: { language_code: "fr", language_name: "French", source: "dictionary", auto_retry: 0 },
      }],
      translationRows: [DONE_ROW, PENDING_ROW],
      postInsertLiveCount: 2, // a concurrent runner also inserted a live job
    })
    const r = await runTranslationWatchdog(now)
    expect(r.reEnqueued).toHaveLength(0)
    expect(state.inserted).toHaveLength(1) // we still attempted the insert
    expect(state.deletedIds).toEqual(["new-job-id"]) // ...then deleted it
  })

  it("does nothing once every entry for this language+source is already done (idle, not exhausted)", async () => {
    const now = Date.now()
    state = makeState({
      jobQueueRows: [{
        id: "j1", status: "failed", completed_at: new Date(now - 20 * 60_000).toISOString(),
        payload: { language_code: "fr", language_name: "French", source: "dictionary", auto_retry: 0 },
      }],
      translationRows: [DONE_ROW], // nav.profile row missing entirely from the table too — but even so, 0 remaining among what exists
    })
    const r = await runTranslationWatchdog(now)
    expect(r.reEnqueued).toHaveLength(0)
    expect(state.inserted).toHaveLength(0)
  })

  it("alerts staff exactly once when the backoff ladder is exhausted", async () => {
    const now = Date.now()
    state = makeState({
      jobQueueRows: [{
        id: "j1", status: "failed", completed_at: new Date(now - 20 * 60_000).toISOString(),
        payload: { language_code: "fr", language_name: "French", source: "dictionary", auto_retry: 5 }, // ladder has 5 rungs — exhausted
      }],
      translationRows: [DONE_ROW, PENDING_ROW],
    })
    const r = await runTranslationWatchdog(now)
    expect(r.exhaustedAlerts).toEqual(["translate:fr:dictionary"])
    expect(state.inserted.some(i => i.__table === "action_log")).toBe(true)
    expect(gmailPostMock).toHaveBeenCalledTimes(1)
  })

  it("does not re-alert when an exhaustion alert for this job was already logged (throttle)", async () => {
    const now = Date.now()
    state = makeState({
      jobQueueRows: [{
        id: "j1", status: "failed", completed_at: new Date(now - 20 * 60_000).toISOString(),
        payload: { language_code: "fr", language_name: "French", source: "dictionary", auto_retry: 5 },
      }],
      translationRows: [DONE_ROW, PENDING_ROW],
      existingAlert: [{ id: "already-alerted" }],
    })
    const r = await runTranslationWatchdog(now)
    expect(r.exhaustedAlerts).toHaveLength(0)
    expect(gmailPostMock).not.toHaveBeenCalled()
  })

  it("keeps dictionary, wizard, and guide as three separate scopes for the same language", async () => {
    const now = Date.now()
    state = makeState({
      jobQueueRows: [
        { id: "j1", status: "failed", completed_at: new Date(now - 20 * 60_000).toISOString(), payload: { language_code: "fr", language_name: "French", source: "dictionary", auto_retry: 0 } },
        { id: "j2", status: "failed", completed_at: new Date(now - 20 * 60_000).toISOString(), payload: { language_code: "fr", language_name: "French", source: "wizard", auto_retry: 0 } },
        { id: "j3", status: "failed", completed_at: new Date(now - 20 * 60_000).toISOString(), payload: { language_code: "fr", language_name: "French", source: "guide", auto_retry: 0 } },
      ],
      translationRows: [PENDING_ROW, { key: "First Name", status: "pending" }, { key: "Portal Guide", status: "pending" }],
      postInsertLiveCount: 1,
    })
    const r = await runTranslationWatchdog(now)
    expect(r.scopes).toBe(3)
    expect(r.reEnqueued.sort()).toEqual(["translate:fr:dictionary", "translate:fr:guide", "translate:fr:wizard"])
  })
})
