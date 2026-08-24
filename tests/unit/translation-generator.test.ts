import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: { from: vi.fn() },
}))

import { generateTranslationsForLanguage, seedPendingTranslations } from "@/lib/portal/translation-generator"
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
            input: { translations: { [quotedKey]: "翻訳済み" } },
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
