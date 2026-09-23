import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: { from: vi.fn() },
}))

const enqueueJobMock = vi.fn(async () => ({ id: "job-new" }))
vi.mock("@/lib/jobs/queue", () => ({
  enqueueJob: (...a: unknown[]) => enqueueJobMock(...a),
}))
vi.mock("@/lib/portal/i18n", () => ({
  getEnglishDictionary: () => ({ "nav.chat": "Chat" }),
  SUPPORTED_LOCALES: ["en", "it"],
}))
vi.mock("@/lib/portal/wizard-translatable-text", () => ({
  getWizardTranslatableText: () => ({ "First Name": "First Name" }),
}))
vi.mock("@/lib/portal/guide-translatable-text", () => ({
  getGuideTranslatableText: () => ({ "Portal Guide": "Portal Guide" }),
}))
vi.mock("@/lib/portal/language-codes", () => ({
  languageName: (code: string) => (code === "fr" ? "French" : code),
}))

import {
  generateTranslationsForLanguage,
  seedPendingTranslations,
  kickoffMissingTranslationWork,
  getEstablishedLanguageCodes,
  translationLooksValid,
} from "@/lib/portal/translation-generator"
import { supabaseAdmin } from "@/lib/supabase-admin"

const TEST_DICT = { "nav.chat": "Chat", "nav.profile": "Profile" }

/** One chainable mock per table call, so a single test can give each call
 * in the real sequence its own canned response:
 *  1. update/eq/eq/lt            — recoverStuckRows
 *  2. select('key,status')/eq    — existing-rows lookup
 *  3. upsert (brand-new keys)    — only issued when there ARE brand-new keys
 *  4. update/eq/eq/eq/select     — one race-safe conditional claim PER missing key
 *     (not a single `.in()` call — PostgREST's `.in()` list filter corrupts
 *     matching for the whole list when a value contains a literal double-quote,
 *     which real wizard-content keys do; claiming key-by-key avoids that class
 *     of bug entirely — see translation-generator.ts's BUG #2 comment)
 *  5. update/eq/eq (per key)     — write 'done' for each successfully translated key
 */
function makeChain(steps: Array<{ data: unknown; error?: unknown }>) {
  let i = 0
  const c: Record<string, unknown> = {
    select: vi.fn(() => c),
    update: vi.fn(() => c),
    upsert: vi.fn(() => c),
    eq: vi.fn(() => c),
    in: vi.fn(() => c),
    lt: vi.fn(() => c),
    order: vi.fn(() => c),
    range: vi.fn(() => c),
    limit: vi.fn(() => c),
    then: (resolve: (v: { data: unknown; error: unknown }) => unknown) => {
      const step = steps[Math.min(i, steps.length - 1)]
      i++
      return resolve({ data: step.data, error: step.error ?? null })
    },
  }
  return c
}

describe("generateTranslationsForLanguage", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.ANTHROPIC_API_KEY = "test-key"
  })

  it("skips everything already done — no AI call, no claim attempt", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    const chains = [
      makeChain([{ data: [] }]), // recoverStuckRows
      makeChain([{ data: [{ key: "nav.chat", status: "done" }, { key: "nav.profile", status: "done" }] }]), // existing rows
    ]
    let call = 0
    vi.mocked(supabaseAdmin.from).mockImplementation(() => chains[call++] as never)

    const result = await generateTranslationsForLanguage("ja", "Japanese", TEST_DICT)

    expect(result).toEqual({
      languageCode: "ja",
      requested: 2,
      alreadyDone: 2,
      generated: 0,
      failed: 0,
      failedKeys: [],
      noCandidates: true,
      stoppedOnDeadline: false,
      batchesSent: 0,
      batchesFailed: 0,
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("generates brand-new missing keys via one AI batch call and writes 'done' rows", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [
          {
            type: "tool_use",
            name: "submit_translations",
            input: { translations: { "nav.chat": "チャット", "nav.profile": "プロフィール" } },
          },
        ],
      }),
    })
    vi.stubGlobal("fetch", fetchMock)

    const chains = [
      makeChain([{ data: [] }]), // recoverStuckRows
      makeChain([{ data: [] }]), // existing rows — nothing exists yet
      makeChain([{ data: null }]), // upsert brand-new pending rows
      makeChain([{ data: [{ key: "nav.chat" }] }]), // conditional claim — nav.chat won
      makeChain([{ data: [{ key: "nav.profile" }] }]), // conditional claim — nav.profile won
      makeChain([{ data: null }]), // update -> done, nav.chat
      makeChain([{ data: null }]), // update -> done, nav.profile
    ]
    let call = 0
    vi.mocked(supabaseAdmin.from).mockImplementation(() => chains[call++] as never)

    const result = await generateTranslationsForLanguage("ja", "Japanese", TEST_DICT)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.generated).toBe(2)
    expect(result.failed).toBe(0)
    expect(result.alreadyDone).toBe(0)
  })

  it("REGRESSION GUARD for the bug found running this at real scale: a key already sitting at 'pending' from a previous incomplete run is retried, not silently skipped forever", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [
          {
            type: "tool_use",
            name: "submit_translations",
            input: { translations: { "nav.chat": "チャット" } },
          },
        ],
      }),
    })
    vi.stubGlobal("fetch", fetchMock)

    const chains = [
      makeChain([{ data: [] }]), // recoverStuckRows
      // 'nav.chat' already has a row, stuck at 'pending' from a prior run
      // that never finished — the exact shape that used to be lost forever.
      makeChain([{ data: [{ key: "nav.chat", status: "pending" }] }]), // existing rows
      // NO upsert call: 'nav.chat' is not brand-new (it already has a row),
      // so the brand-new-keys insert step is skipped entirely for it.
      makeChain([{ data: [{ key: "nav.chat" }] }]), // conditional claim — picks it up because it's still 'pending'
      makeChain([{ data: null }]), // update -> done, nav.chat
    ]
    let call = 0
    vi.mocked(supabaseAdmin.from).mockImplementation(() => chains[call++] as never)

    const result = await generateTranslationsForLanguage("ja", "Japanese", { "nav.chat": "Chat" })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.generated).toBe(1)
    expect(result.failed).toBe(0)
    // Confirm no upsert call was made for the already-existing key.
    const upsertCalls = vi.mocked(chains[1].upsert as ReturnType<typeof vi.fn>).mock?.calls ?? []
    expect(upsertCalls.length).toBe(0)
  })

  it("REGRESSION GUARD for the bug found live on a real German batch: the AI call must instruct the model never to use literal quote marks in a translated value, so a source phrase with an embedded quoted phrase (e.g. `... as \"Pay Now\" buttons ...`) can never corrupt the whole batch's JSON — reproduced 4/4 times live before this instruction, 0/3 failures after", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [
          {
            type: "tool_use",
            name: "submit_translations",
            input: { translations: { "nav.chat": "Chat", "nav.profile": "Profil" } },
          },
        ],
      }),
    })
    vi.stubGlobal("fetch", fetchMock)

    const chains = [
      makeChain([{ data: [] }]), // recoverStuckRows
      makeChain([{ data: [] }]), // existing rows — nothing exists yet
      makeChain([{ data: null }]), // upsert brand-new pending rows
      makeChain([{ data: [{ key: "nav.chat" }] }]),
      makeChain([{ data: [{ key: "nav.profile" }] }]),
      makeChain([{ data: null }]),
      makeChain([{ data: null }]),
    ]
    let call = 0
    vi.mocked(supabaseAdmin.from).mockImplementation(() => chains[call++] as never)

    await generateTranslationsForLanguage("fr", "French", TEST_DICT)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(requestBody.system).toMatch(/never use literal quotation mark characters/i)
  })

  it("REGRESSION GUARD for the bug found live on a real German guide batch: max_tokens must have real headroom above a full 150-key prose batch's worst measured need (German 8513, Finnish 8962 output tokens) — 8192 truncated the response mid-generation (stop_reason: \"max_tokens\") before the tool_use block completed, failing the whole batch", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [
          {
            type: "tool_use",
            name: "submit_translations",
            input: { translations: { "nav.chat": "Chat", "nav.profile": "Profil" } },
          },
        ],
      }),
    })
    vi.stubGlobal("fetch", fetchMock)

    const chains = [
      makeChain([{ data: [] }]), // recoverStuckRows
      makeChain([{ data: [] }]), // existing rows — nothing exists yet
      makeChain([{ data: null }]), // upsert brand-new pending rows
      makeChain([{ data: [{ key: "nav.chat" }] }]),
      makeChain([{ data: [{ key: "nav.profile" }] }]),
      makeChain([{ data: null }]),
      makeChain([{ data: null }]),
    ]
    let call = 0
    vi.mocked(supabaseAdmin.from).mockImplementation(() => chains[call++] as never)

    await generateTranslationsForLanguage("de", "German", TEST_DICT)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(requestBody.max_tokens).toBeGreaterThanOrEqual(16000)
  })

  it("REGRESSION GUARD for the bug found live on a 150-key Hungarian batch: the model can return `translations` as a JSON-encoded STRING instead of a native object — the code must parse it, not silently fail every key in the batch", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [
          {
            type: "tool_use",
            name: "submit_translations",
            // The exact malformed shape observed live: `translations` is a
            // string containing valid JSON, not a native object.
            input: { translations: JSON.stringify({ "nav.chat": "Csevegés", "nav.profile": "Profil" }) },
          },
        ],
      }),
    })
    vi.stubGlobal("fetch", fetchMock)

    const chains = [
      makeChain([{ data: [] }]), // recoverStuckRows
      makeChain([{ data: [] }]), // existing rows — nothing exists yet
      makeChain([{ data: null }]), // upsert brand-new pending rows
      makeChain([{ data: [{ key: "nav.chat" }] }]), // conditional claim — nav.chat won
      makeChain([{ data: [{ key: "nav.profile" }] }]), // conditional claim — nav.profile won
      makeChain([{ data: null }]), // update -> done, nav.chat
      makeChain([{ data: null }]), // update -> done, nav.profile
    ]
    let call = 0
    vi.mocked(supabaseAdmin.from).mockImplementation(() => chains[call++] as never)

    const result = await generateTranslationsForLanguage("hu", "Hungarian", TEST_DICT)

    expect(result.generated).toBe(2)
    expect(result.failed).toBe(0)
  })

  it("REGRESSION GUARD for the bug found running the wizard content source: claims by key one at a time (.eq), never with an .in() list — a value containing a literal double-quote (real UI copy: `\"back-filing\"`) corrupts PostgREST's .in() list matching for the WHOLE list, not just itself", async () => {
    const quotedKey = 'A missing prior-year return can be filed late ("back-filing") to clean up the position.'
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [
          {
            type: "tool_use",
            name: "submit_translations",
            input: { translations: { [quotedKey]: "先月分の申告書が未提出の場合は、後から遅れて提出（バックファイリング）することで状況を整理できます。" } },
          },
        ],
      }),
    })
    vi.stubGlobal("fetch", fetchMock)

    const chains = [
      makeChain([{ data: [] }]), // recoverStuckRows
      makeChain([{ data: [] }]), // existing rows — nothing exists yet
      makeChain([{ data: null }]), // upsert brand-new pending row
      makeChain([{ data: [{ key: quotedKey }] }]), // conditional claim for THIS key, via .eq — won
      makeChain([{ data: null }]), // update -> done
    ]
    let call = 0
    vi.mocked(supabaseAdmin.from).mockImplementation(() => chains[call++] as never)

    const result = await generateTranslationsForLanguage("ja", "Japanese", { [quotedKey]: quotedKey })

    expect(result.generated).toBe(1)
    expect(result.failed).toBe(0)
    // The claim chain (index 3) must never call .in() — only .eq() — since
    // .in() is exactly what silently dropped keys like this one in production.
    const claimChain = chains[3]
    expect(vi.mocked(claimChain.in as ReturnType<typeof vi.fn>).mock?.calls?.length ?? 0).toBe(0)
    const eqCalls = vi.mocked(claimChain.eq as ReturnType<typeof vi.fn>).mock.calls
    expect(eqCalls.some(args => args[0] === "key" && args[1] === quotedKey)).toBe(true)
  })

  it("records a failure per key when the model's response is missing an entry, without throwing", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [
          {
            type: "tool_use",
            name: "submit_translations",
            // 'nav.profile' missing from the response entirely
            input: { translations: { "nav.chat": "チャット" } },
          },
        ],
      }),
    })
    vi.stubGlobal("fetch", fetchMock)

    const chains = [
      makeChain([{ data: [] }]),
      makeChain([{ data: [] }]),
      makeChain([{ data: null }]),
      makeChain([{ data: [{ key: "nav.chat" }] }]),
      makeChain([{ data: [{ key: "nav.profile" }] }]),
      makeChain([{ data: null }]), // update -> done, nav.chat (nav.profile fails before any DB write)
    ]
    let call = 0
    vi.mocked(supabaseAdmin.from).mockImplementation(() => chains[call++] as never)

    const result = await generateTranslationsForLanguage("ja", "Japanese", TEST_DICT)

    expect(result.generated).toBe(1)
    expect(result.failed).toBe(1)
    expect(result.failedKeys).toEqual(["nav.profile"])
  })

  it("marks the whole batch failed (not thrown) when the AI call itself errors — a dead API must not crash the caller", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"))
    vi.stubGlobal("fetch", fetchMock)

    const chains = [
      makeChain([{ data: [] }]),
      makeChain([{ data: [] }]),
      makeChain([{ data: null }]),
      makeChain([{ data: [{ key: "nav.chat" }] }]),
      makeChain([{ data: [{ key: "nav.profile" }] }]),
    ]
    let call = 0
    vi.mocked(supabaseAdmin.from).mockImplementation(() => chains[call++] as never)

    const result = await generateTranslationsForLanguage("ja", "Japanese", TEST_DICT)

    expect(result.generated).toBe(0)
    expect(result.failed).toBe(2)
    expect(result.failedKeys.sort()).toEqual(["nav.chat", "nav.profile"])
  })

  it("REGRESSION GUARD (2026-08-22 incident): the existing-rows lookup reads past PostgREST's 1000-row page cap instead of silently re-treating already-'done' keys as missing forever", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    // 1,001 already-'done' keys — one past the old single-page cutoff. The
    // real incident: a language with more done rows than one page (e.g. the
    // central dictionary plus the wizard content, 979 + 433 = 1412) had its
    // most-recently-added 'done' rows fall outside the unbounded .select(),
    // so this function kept computing them as "missing", kept silently
    // no-op'ing the upsert (the row already exists), and kept reporting
    // generated:0 forever — confirmed live against the real database, not a
    // hypothetical.
    const doneRows = Array.from({ length: 1001 }, (_, i) => ({ key: `k${i}`, status: "done" }))
    const dict: Record<string, string> = {}
    for (const row of doneRows) dict[row.key] = row.key

    // fetchAllPaged's own page size (BANK_TX_PAGE_SIZE) drives how many
    // separate .from() calls happen — one per page (each page runs its own
    // fresh query chain), until a short page ends the loop.
    const { BANK_TX_PAGE_SIZE } = await import("@/lib/bank-transactions-fetch")
    const pageChains = []
    for (let from = 0; from < doneRows.length; from += BANK_TX_PAGE_SIZE) {
      pageChains.push(makeChain([{ data: doneRows.slice(from, from + BANK_TX_PAGE_SIZE) }]))
    }

    const chains = [
      makeChain([{ data: [] }]), // recoverStuckRows
      ...pageChains, // existing rows — paged past 1000, one .from() call per page
    ]
    let call = 0
    vi.mocked(supabaseAdmin.from).mockImplementation(() => chains[call++] as never)

    const result = await generateTranslationsForLanguage("ja", "Japanese", dict)

    expect(result.requested).toBe(1001)
    // The regression: this used to come back far short of 1001 because the
    // 1001st row (and any past the first page) was invisible to the query.
    expect(result.alreadyDone).toBe(1001)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("returns early with nothing generated when another caller already claimed every missing key (the race-safety guard actually doing its job)", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    const chains = [
      makeChain([{ data: [] }]), // recoverStuckRows
      makeChain([{ data: [] }]), // existing rows — nothing exists yet
      makeChain([{ data: null }]), // upsert brand-new pending rows
      makeChain([{ data: [] }]), // conditional claim — nav.chat lost the race
      makeChain([{ data: [] }]), // conditional claim — nav.profile lost the race
    ]
    let call = 0
    vi.mocked(supabaseAdmin.from).mockImplementation(() => chains[call++] as never)

    const result = await generateTranslationsForLanguage("ja", "Japanese", TEST_DICT)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.generated).toBe(0)
    expect(result.failed).toBe(0)
    // REGRESSION GUARD (found running the real chained continuation for the
    // first time): "nothing claimable right now" must be reported the same
    // way as a deadline stop, not as "no progress" — otherwise a chained
    // continuation immediately halts the whole chain for good the moment it
    // finds its OWN prior chunk's claimed-but-not-yet-translated rows still
    // sitting at 'generating' (they haven't hit recoverStuckRows' window
    // yet), when it should just try again shortly instead of giving up.
    expect(result.stoppedOnDeadline).toBe(true)
  })

  it("stops before starting a new batch once the deadline is too close to fit one, without losing already-generated progress", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [
          {
            type: "tool_use",
            name: "submit_translations",
            input: { translations: { "nav.chat": "チャット" } },
          },
        ],
      }),
    })
    vi.stubGlobal("fetch", fetchMock)

    const chains = [
      makeChain([{ data: [] }]), // recoverStuckRows
      makeChain([{ data: [] }]), // existing rows — nothing exists yet
      makeChain([{ data: null }]), // upsert brand-new pending rows
      makeChain([{ data: [{ key: "nav.chat" }] }]), // conditional claim — nav.chat won
      makeChain([{ data: [{ key: "nav.profile" }] }]), // conditional claim — nav.profile won
      makeChain([{ data: null }]), // update -> done, nav.chat (first batch only)
    ]
    let call = 0
    vi.mocked(supabaseAdmin.from).mockImplementation(() => chains[call++] as never)

    // Deadline already passed — even the FIRST batch shouldn't start, since a
    // batch needs up to AI_TIMEOUT_MS of headroom to safely finish.
    const result = await generateTranslationsForLanguage("ja", "Japanese", TEST_DICT, { deadlineAt: Date.now() - 1 })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.stoppedOnDeadline).toBe(true)
    expect(result.batchesSent).toBe(0)
    expect(result.generated).toBe(0)
    expect(result.noCandidates).toBe(false)
  })
})

describe("seedPendingTranslations", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("inserts a pending row for every brand-new key and reports the missing count, with no claim or AI call", async () => {
    const chains = [
      makeChain([{ data: [{ key: "nav.chat", status: "done" }] }]), // existing rows — one already done
      makeChain([{ data: null }]), // upsert brand-new pending row for nav.profile
    ]
    let call = 0
    vi.mocked(supabaseAdmin.from).mockImplementation(() => chains[call++] as never)

    const result = await seedPendingTranslations("ja", TEST_DICT)

    expect(result).toEqual({ requested: 2, alreadyDone: 1, missing: 1 })
    // Exactly the seed + upsert calls — nothing else (no claim, no AI batch).
    expect(vi.mocked(supabaseAdmin.from).mock.calls.length).toBe(2)
    const upsertCalls = vi.mocked(chains[1].upsert as ReturnType<typeof vi.fn>).mock.calls
    expect(upsertCalls.length).toBe(1)
    expect(upsertCalls[0][0]).toEqual([
      expect.objectContaining({ language_code: "ja", key: "nav.profile", status: "pending" }),
    ])
  })

  it("reports missing:0 and skips the upsert entirely when everything is already done", async () => {
    const chains = [
      makeChain([{ data: [{ key: "nav.chat", status: "done" }, { key: "nav.profile", status: "done" }] }]),
    ]
    let call = 0
    vi.mocked(supabaseAdmin.from).mockImplementation(() => chains[call++] as never)

    const result = await seedPendingTranslations("ja", TEST_DICT)

    expect(result).toEqual({ requested: 2, alreadyDone: 2, missing: 0 })
    const upsertCalls = vi.mocked(chains[0].upsert as ReturnType<typeof vi.fn>).mock?.calls ?? []
    expect(upsertCalls.length).toBe(0)
  })
})

// ── kickoffMissingTranslationWork / getEstablishedLanguageCodes ─────────────
// (dev job 4fa1d8e5) — the shared "find what's missing, queue it" step now
// used by both the language-picker route and the daily top-up cron.

describe("kickoffMissingTranslationWork", () => {
  beforeEach(() => {
    enqueueJobMock.mockClear()
  })

  it("enqueues a translate job for the dictionary source when nothing is already live and not exhausted", async () => {
    const chains = [
      makeChain([{ data: [] }]), // dictionary: loadExistingStatus — nothing exists yet
      makeChain([{ data: null }]), // dictionary: upsert brand-new pending row
      makeChain([{ data: [] }]), // hasLiveTranslateJob — nothing live
      makeChain([{ data: [] }]), // hasUnresolvedExhaustion — no exhaustion logged
      makeChain([{ data: [{ id: "job-new" }] }]), // post-insert verify — just our own row
    ]
    let call = 0
    vi.mocked(supabaseAdmin.from).mockImplementation(() => chains[call++] as never)

    const result = await kickoffMissingTranslationWork("fr", "test-caller")

    expect(result).toEqual({ source: "dictionary", missing: 1 })
    expect(enqueueJobMock).toHaveBeenCalledTimes(1)
    expect(enqueueJobMock.mock.calls[0][0]).toMatchObject({
      job_type: "translate_language",
      payload: { language_code: "fr", language_name: "French", source: "dictionary", chunk_index: 0, auto_retry: 0 },
      created_by: "test-caller",
    })
  })

  it("does NOT enqueue a duplicate job when a dictionary-source job for this language is already live", async () => {
    const chains = [
      makeChain([{ data: [] }]), // dictionary: loadExistingStatus
      makeChain([{ data: null }]), // dictionary: upsert
      makeChain([{ data: [{ id: "already-live" }] }]), // hasLiveTranslateJob — already live
    ]
    let call = 0
    vi.mocked(supabaseAdmin.from).mockImplementation(() => chains[call++] as never)

    const result = await kickoffMissingTranslationWork("fr", "test-caller")

    expect(result).toEqual({ source: "dictionary", missing: 1 })
    expect(enqueueJobMock).not.toHaveBeenCalled()
  })

  it("does NOT enqueue a fresh job when the watchdog already logged this language/source as exhausted — closes the 'daily incident generator' bug a council review caught", async () => {
    const chains = [
      makeChain([{ data: [] }]), // dictionary: loadExistingStatus
      makeChain([{ data: null }]), // dictionary: upsert
      makeChain([{ data: [] }]), // hasLiveTranslateJob — nothing live
      makeChain([{ data: [{ id: "exhaustion-alert-1" }] }]), // hasUnresolvedExhaustion — already exhausted
    ]
    let call = 0
    vi.mocked(supabaseAdmin.from).mockImplementation(() => chains[call++] as never)

    const result = await kickoffMissingTranslationWork("de", "test-caller")

    expect(result).toEqual({ source: "dictionary", missing: 1 })
    expect(enqueueJobMock).not.toHaveBeenCalled()
  })

  it("deletes its own just-inserted row when a post-insert check finds a concurrent caller also enqueued a live job for the same language+source", async () => {
    const deleteChain = makeChain([{ data: null }]) as Record<string, unknown>
    deleteChain.delete = vi.fn(() => deleteChain)
    const chains = [
      makeChain([{ data: [] }]), // dictionary: loadExistingStatus
      makeChain([{ data: null }]), // dictionary: upsert
      makeChain([{ data: [] }]), // hasLiveTranslateJob — nothing live yet
      makeChain([{ data: [] }]), // hasUnresolvedExhaustion — not exhausted
      makeChain([{ data: [{ id: "job-new" }, { id: "concurrent-job" }] }]), // post-insert verify — TWO live jobs now
      deleteChain, // the delete-our-own-row call
    ]
    let call = 0
    vi.mocked(supabaseAdmin.from).mockImplementation(() => chains[call++] as never)

    await kickoffMissingTranslationWork("fr", "test-caller")

    expect(deleteChain.delete).toHaveBeenCalledTimes(1)
  })

  it("falls through to the guide source when dictionary and wizard are already fully seeded", async () => {
    const chains = [
      makeChain([{ data: [{ key: "nav.chat", status: "done" }] }]), // dictionary: done
      makeChain([{ data: [{ key: "First Name", status: "done" }] }]), // wizard: done
      makeChain([{ data: [] }]), // guide: loadExistingStatus — missing
      makeChain([{ data: null }]), // guide: upsert
      makeChain([{ data: [] }]), // hasLiveTranslateJob for guide — nothing live
      makeChain([{ data: [] }]), // hasUnresolvedExhaustion for guide — not exhausted
      makeChain([{ data: [{ id: "job-new" }] }]), // post-insert verify
    ]
    let call = 0
    vi.mocked(supabaseAdmin.from).mockImplementation(() => chains[call++] as never)

    const result = await kickoffMissingTranslationWork("fr", "test-caller")

    expect(result).toEqual({ source: "guide", missing: 1 })
    expect(enqueueJobMock).toHaveBeenCalledTimes(1)
    expect(enqueueJobMock.mock.calls[0][0]).toMatchObject({ payload: { source: "guide" } })
  })

  it("returns null when every source is already fully translated", async () => {
    const chains = [
      makeChain([{ data: [{ key: "nav.chat", status: "done" }] }]), // dictionary: done
      makeChain([{ data: [{ key: "First Name", status: "done" }] }]), // wizard: done
      makeChain([{ data: [{ key: "Portal Guide", status: "done" }] }]), // guide: done
    ]
    let call = 0
    vi.mocked(supabaseAdmin.from).mockImplementation(() => chains[call++] as never)

    const result = await kickoffMissingTranslationWork("it", "test-caller")

    expect(result).toBeNull()
    expect(enqueueJobMock).not.toHaveBeenCalled()
  })
})

describe("getEstablishedLanguageCodes", () => {
  const listUsersMock = vi.fn()

  beforeEach(() => {
    listUsersMock.mockReset()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(supabaseAdmin as any).auth = { admin: { listUsers: listUsersMock } }
  })

  it("returns the distinct set of non-hand-written language codes real accounts currently have selected", async () => {
    listUsersMock.mockResolvedValueOnce({
      data: {
        users: [
          { user_metadata: { portal_language: "es" } },
          { user_metadata: { portal_language: "de" } },
          { user_metadata: { portal_language: "es" } },
          { user_metadata: { portal_language: "it" } }, // hand-written dictionary — excluded
          { user_metadata: { portal_language: "en" } }, // hand-written dictionary — excluded
          { user_metadata: {} }, // never picked a language — excluded
        ],
      },
      error: null,
    })

    const result = await getEstablishedLanguageCodes()
    expect(result.sort()).toEqual(["de", "es"])
    expect(listUsersMock).toHaveBeenCalledTimes(1)
  })

  it("returns an empty list when no account has ever picked a non-hand-written language", async () => {
    listUsersMock.mockResolvedValueOnce({ data: { users: [] }, error: null })
    const result = await getEstablishedLanguageCodes()
    expect(result).toEqual([])
  })

  it("pages through every user rather than stopping at the first page", async () => {
    const page1 = Array.from({ length: 200 }, (_, i) => ({ user_metadata: { portal_language: i === 0 ? "es" : "en" } }))
    listUsersMock
      .mockResolvedValueOnce({ data: { users: page1 }, error: null }) // full page — must fetch page 2
      .mockResolvedValueOnce({ data: { users: [{ user_metadata: { portal_language: "hu" } }] }, error: null }) // partial page — stop here

    const result = await getEstablishedLanguageCodes()
    expect(result.sort()).toEqual(["es", "hu"])
    expect(listUsersMock).toHaveBeenCalledTimes(2)
  })
})

// ── 2026-09-23 incident: one wizard sentence looped ~576 paid jobs/day for
// weeks. The model returned its tool-call KEY with straight apostrophes where
// the source had curly ones, so the exact-key lookup missed, nothing was saved,
// and the failure was masked as a harmless "continue". Matching by opaque id,
// releasing unsaved rows, and validating answers close that path.
const CURLY_KEY =
  "Only have a PDF? Please still download the CSV from your bank — it’s the most reliable and fastest option. You’ll upload the files in the final step."

function stubFetchWithTranslations(translations: Record<string, string>) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      content: [{ type: "tool_use", name: "submit_translations", input: { translations } }],
    }),
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

describe("generateTranslationsForLanguage — id matching (2026-09-23 curly-apostrophe loop)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.ANTHROPIC_API_KEY = "test-key"
  })

  it("REGRESSION: a sentence with curly apostrophes is saved when the model answers by id, and the request never uses the sentence as a key", async () => {
    const fetchMock = stubFetchWithTranslations({
      k0: "Sie haben nur ein PDF? Laden Sie trotzdem bitte die CSV-Datei Ihrer Bank herunter, denn das ist die zuverlässigste und schnellste Option.",
    })
    const chains = [
      makeChain([{ data: [] }]), // recoverStuckRows
      makeChain([{ data: [] }]), // existing rows
      makeChain([{ data: null }]), // upsert
      makeChain([{ data: [{ key: CURLY_KEY }] }]), // claim won
      makeChain([{ data: null }]), // update -> done
    ]
    let call = 0
    vi.mocked(supabaseAdmin.from).mockImplementation(() => chains[call++] as never)

    const result = await generateTranslationsForLanguage("de", "German", { [CURLY_KEY]: CURLY_KEY })

    expect(result.generated).toBe(1)
    expect(result.failed).toBe(0)
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    const sent = JSON.parse(body.messages[0].content.split("\n\n").slice(1).join("\n\n"))
    expect(sent).toEqual([{ id: "k0", text: CURLY_KEY }])
    expect(body.tools[0].input_schema.properties.translations.description).toMatch(/ids/i)
  })

  it("passes the dictionary key along as context (not as the answer key) so short labels keep their meaning", async () => {
    const fetchMock = stubFetchWithTranslations({ k0: "Chat", k1: "Profil" })
    const chains = [
      makeChain([{ data: [] }]),
      makeChain([{ data: [] }]),
      makeChain([{ data: null }]),
      makeChain([{ data: [{ key: "nav.chat" }] }]),
      makeChain([{ data: [{ key: "nav.profile" }] }]),
      makeChain([{ data: null }]),
      makeChain([{ data: null }]),
    ]
    let call = 0
    vi.mocked(supabaseAdmin.from).mockImplementation(() => chains[call++] as never)

    await generateTranslationsForLanguage("de", "German", TEST_DICT)

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    const sent = JSON.parse(body.messages[0].content.split("\n\n").slice(1).join("\n\n"))
    expect(sent).toEqual([
      { id: "k0", context: "nav.chat", text: "Chat" },
      { id: "k1", context: "nav.profile", text: "Profile" },
    ])
  })

  it("maps reordered answers correctly and ignores ids it never asked for", async () => {
    stubFetchWithTranslations({ k1: "Profil-de", k9: "junk for nobody", k0: "Chat-de" })
    const chains = [
      makeChain([{ data: [] }]),
      makeChain([{ data: [] }]),
      makeChain([{ data: null }]),
      makeChain([{ data: [{ key: "nav.chat" }] }]),
      makeChain([{ data: [{ key: "nav.profile" }] }]),
      makeChain([{ data: null }]), // done, nav.chat
      makeChain([{ data: null }]), // done, nav.profile
    ]
    let call = 0
    vi.mocked(supabaseAdmin.from).mockImplementation(() => chains[call++] as never)

    const result = await generateTranslationsForLanguage("de", "German", TEST_DICT)

    expect(result.generated).toBe(2)
    expect(result.failed).toBe(0)
    const doneUpdate = (chain: unknown) => vi.mocked((chain as { update: ReturnType<typeof vi.fn> }).update).mock.calls[0][0]
    expect(doneUpdate(chains[5])).toMatchObject({ status: "done", translated_text: "Chat-de" })
    expect(doneUpdate(chains[6])).toMatchObject({ status: "done", translated_text: "Profil-de" })
    expect(call).toBe(7) // no extra DB call for the junk id
  })

  it("does NOT accept an answer keyed by a normalized version of the sentence (no fuzzy matching) — it fails the key and hands the row back to 'pending'", async () => {
    stubFetchWithTranslations({ [CURLY_KEY.replace(/’/g, "'")]: "irgendein Text der lang genug ist, damit er nicht am Längenvergleich scheitert." })
    const chains = [
      makeChain([{ data: [] }]),
      makeChain([{ data: [] }]),
      makeChain([{ data: null }]),
      makeChain([{ data: [{ key: CURLY_KEY }] }]),
      makeChain([{ data: null }]), // release -> pending
    ]
    let call = 0
    vi.mocked(supabaseAdmin.from).mockImplementation(() => chains[call++] as never)

    const result = await generateTranslationsForLanguage("de", "German", { [CURLY_KEY]: CURLY_KEY })

    expect(result.generated).toBe(0)
    expect(result.failedKeys).toEqual([CURLY_KEY])
  })
})

describe("generateTranslationsForLanguage — unsaved keys are released, not left locked", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.ANTHROPIC_API_KEY = "test-key"
  })

  it("REGRESSION: a key the model answered badly goes straight back to 'pending' (one .eq update, only if still 'generating') instead of sitting 'generating' for 5 minutes", async () => {
    stubFetchWithTranslations({ k0: "Chat-de" }) // k1 missing entirely
    const chains = [
      makeChain([{ data: [] }]),
      makeChain([{ data: [] }]),
      makeChain([{ data: null }]),
      makeChain([{ data: [{ key: "nav.chat" }] }]),
      makeChain([{ data: [{ key: "nav.profile" }] }]),
      makeChain([{ data: null }]), // done, nav.chat
      makeChain([{ data: null }]), // release, nav.profile
    ]
    let call = 0
    vi.mocked(supabaseAdmin.from).mockImplementation(() => chains[call++] as never)

    const result = await generateTranslationsForLanguage("de", "German", TEST_DICT)

    expect(result.generated).toBe(1)
    expect(result.failedKeys).toEqual(["nav.profile"])
    const release = chains[6] as { update: ReturnType<typeof vi.fn>; eq: ReturnType<typeof vi.fn>; in: ReturnType<typeof vi.fn> }
    expect(release.update.mock.calls[0][0]).toEqual({ status: "pending", generating_started_at: null })
    const eqs = release.eq.mock.calls.map(a => `${a[0]}=${a[1]}`)
    expect(eqs).toContain("key=nav.profile")
    expect(eqs).toContain("status=generating")
    expect(release.in.mock.calls.length).toBe(0) // never an .in() list (BUG #2)
  })

  it("rejects an answer that dropped a {placeholder} and releases the row", async () => {
    stubFetchWithTranslations({ k0: "Bonjour, bienvenue dans le portail, nous sommes ravis de vous voir ici." })
    const chains = [
      makeChain([{ data: [] }]),
      makeChain([{ data: [] }]),
      makeChain([{ data: null }]),
      makeChain([{ data: [{ key: "greet" }] }]),
      makeChain([{ data: null }]), // release
    ]
    let call = 0
    vi.mocked(supabaseAdmin.from).mockImplementation(() => chains[call++] as never)

    const result = await generateTranslationsForLanguage("fr", "French", { greet: "Hello {name}, welcome to the portal, we are glad you are here." })

    expect(result.generated).toBe(0)
    expect(result.failed).toBe(1)
    const release = chains[4] as { update: ReturnType<typeof vi.fn> }
    expect(release.update.mock.calls[0][0]).toEqual({ status: "pending", generating_started_at: null })
  })

  it("leaves rows alone (no release) when the whole AI call throws — a dead API keeps the 5-minute natural backoff", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Claude API error 529: overloaded")))
    const chains = [
      makeChain([{ data: [] }]),
      makeChain([{ data: [] }]),
      makeChain([{ data: null }]),
      makeChain([{ data: [{ key: "nav.chat" }] }]),
      makeChain([{ data: [{ key: "nav.profile" }] }]),
    ]
    let call = 0
    vi.mocked(supabaseAdmin.from).mockImplementation(() => chains[call++] as never)

    const result = await generateTranslationsForLanguage("de", "German", TEST_DICT)

    expect(result.batchesFailed).toBe(1)
    expect(result.lastBatchError).toMatch(/529/)
    expect(call).toBe(5) // recover, existing, upsert, 2 claims — nothing after
  })
})

describe("translationLooksValid", () => {
  it("accepts an ordinary translation, including short labels", () => {
    expect(translationLooksValid("Chat", "Chat")).toBe(true)
    expect(translationLooksValid("OK", "D'accord")).toBe(true)
  })
  it("rejects empty or whitespace-only text", () => {
    expect(translationLooksValid("Hello there", "")).toBe(false)
    expect(translationLooksValid("Hello there", "   ")).toBe(false)
  })
  it("requires the same {placeholders}, in any order", () => {
    expect(translationLooksValid("Hi {name}, your {plan} plan", "Hallo {plan}, {name} — Ihr Plan")).toBe(true)
    expect(translationLooksValid("Hi {name}", "Hallo")).toBe(false)
    expect(translationLooksValid("Hi {name}", "Hallo {nom}")).toBe(false)
  })
  it("rejects an absurd length ratio only for longer sources", () => {
    const long = "This is a reasonably long sentence about the annual report that must be translated."
    expect(translationLooksValid(long, "Ja")).toBe(false)
    expect(translationLooksValid(long, "x".repeat(long.length * 9))).toBe(false)
    expect(translationLooksValid("Save", "Speichern und fortfahren mit dem Vorgang")).toBe(true)
  })
})
