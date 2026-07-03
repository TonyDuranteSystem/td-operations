import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { parseSuggestions, aiSuggestCategories, type AiCategorizableTx } from "@/lib/tax/ai-categorizer"

const CTX = { companyName: "QA Test LLC", memberNames: ["Mario Rossi"], bankNames: ["Wise", "Mercury"] }

function tx(id: string, amount = -10): AiCategorizableTx {
  return { id, transaction_date: "2025-03-01", description: `desc ${id}`, counterparty: "", amount, currency: "USD", bank_name: "Wise" }
}

function fakeFetchReturning(suggestions: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({
      content: [{ type: "tool_use", name: "suggest_categories", input: { suggestions } }],
    }), { status: 200 })) as unknown as typeof fetch
}

describe("parseSuggestions", () => {
  const ids = new Set(["a", "b"])

  it("accepts valid suggestions and preserves confidence", () => {
    const out = parseSuggestions({ suggestions: [
      { id: "a", category: "expense", subcategory: "software", confidence: "high" },
      { id: "b", category: "income", subcategory: "revenue", confidence: "medium" },
    ] }, ids)
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({ id: "a", category: "expense", subcategory: "software", confidence: "high" })
    expect(out[1].confidence).toBe("medium")
  })

  it("captures advisory lean + bucket, validating bucket against the catalog (#2)", () => {
    const buckets = new Set(["fuel_auto", "software_saas"])
    const out = parseSuggestions({ suggestions: [
      { id: "a", category: "distribution", confidence: "low", lean: "personal", bucket: "fuel_auto" },
      { id: "b", category: "expense", confidence: "high", lean: "business", bucket: "software_saas" },
    ] }, ids, buckets)
    expect(out[0]).toMatchObject({ id: "a", lean: "personal", bucket: "fuel_auto" })
    expect(out[1]).toMatchObject({ id: "b", lean: "business", bucket: "software_saas" })
  })

  it("keeps 'other' but drops a bucket that is not in the catalog; tolerates a bad lean", () => {
    const buckets = new Set(["fuel_auto"])
    const out = parseSuggestions({ suggestions: [
      { id: "a", category: "expense", confidence: "low", lean: "maybe", bucket: "made_up_bucket" },
      { id: "b", category: "expense", confidence: "low", lean: "unsure", bucket: "other" },
    ] }, ids, buckets)
    // a: bad lean dropped, unknown bucket dropped — still a valid suggestion, just no hints
    expect(out[0]).toEqual({ id: "a", category: "expense", subcategory: "", confidence: "low" })
    // b: 'other' is always allowed
    expect(out[1]).toMatchObject({ id: "b", lean: "unsure", bucket: "other" })
  })

  it("drops hallucinated ids, invalid categories, 'uncategorized', and bad confidence", () => {
    const out = parseSuggestions({ suggestions: [
      { id: "ghost", category: "expense", confidence: "high" },          // id not in batch
      { id: "a", category: "salary", confidence: "high" },                // invalid category
      { id: "a", category: "uncategorized", confidence: "high" },         // AI may not assign uncategorized
      { id: "a", category: "expense", confidence: "certain" },            // invalid confidence
      { id: "b", category: "fee", confidence: "high" },                   // valid
    ] }, ids)
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe("b")
  })

  it("survives garbage input shapes", () => {
    expect(parseSuggestions(null, ids)).toEqual([])
    expect(parseSuggestions("nope", ids)).toEqual([])
    expect(parseSuggestions({ suggestions: "nope" }, ids)).toEqual([])
    expect(parseSuggestions({ suggestions: [null, 42, {}] }, ids)).toEqual([])
  })

  it("truncates oversized subcategories and defaults missing ones to empty", () => {
    const out = parseSuggestions({ suggestions: [
      { id: "a", category: "expense", subcategory: "x".repeat(200), confidence: "high" },
      { id: "b", category: "fee", confidence: "low" },
    ] }, ids)
    expect(out[0].subcategory).toHaveLength(60)
    expect(out[1].subcategory).toBe("")
  })
})

describe("aiSuggestCategories", () => {
  const KEY = "ANTHROPIC_API_KEY"
  let savedKey: string | undefined

  beforeEach(() => { savedKey = process.env[KEY]; process.env[KEY] = "test-key" })
  afterEach(() => {
    if (savedKey === undefined) delete process.env[KEY]
    else process.env[KEY] = savedKey
  })

  it("returns empty + a clear error when the key is missing (fail-open)", async () => {
    delete process.env[KEY]
    const res = await aiSuggestCategories([tx("a")], CTX)
    expect(res.suggestions).toEqual([])
    expect(res.errors[0]).toContain("ANTHROPIC_API_KEY")
  })

  it("batches transactions and only accepts ids from each batch", async () => {
    const calls: string[] = []
    const fetchImpl = (async (_url: unknown, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? "{}")
      calls.push(body.messages[0].content)
      // echo back the first id of the batch + a hallucinated one
      const firstId = (body.messages[0].content as string).match(/tx-\d+/)?.[0]
      return new Response(JSON.stringify({
        content: [{ type: "tool_use", name: "suggest_categories", input: { suggestions: [
          { id: firstId, category: "expense", subcategory: "software", confidence: "high" },
          { id: "tx-9999", category: "expense", confidence: "high" },
        ] } }],
      }), { status: 200 })
    }) as unknown as typeof fetch

    const txs = Array.from({ length: 85 }, (_, i) => tx(`tx-${i}`)) // 3 batches of 40/40/5
    const res = await aiSuggestCategories(txs, CTX, { fetchImpl })
    expect(calls).toHaveLength(3)
    // tx-9999 hallucinated in batches where it isn't a member → only counted once (batch 3 contains tx-80..84, so never)
    const ids = res.suggestions.map(s => s.id)
    expect(ids).toContain("tx-0")
    expect(ids).toContain("tx-40")
    expect(ids).toContain("tx-80")
    expect(ids).not.toContain("tx-9999")
  })

  it("caps the number of batches and says so", async () => {
    const txs = Array.from({ length: 120 }, (_, i) => tx(`tx-${i}`))
    const res = await aiSuggestCategories(txs, CTX, { fetchImpl: fakeFetchReturning([]), maxBatches: 2 })
    expect(res.errors.some(e => e.includes("Capped at 2 batches"))).toBe(true)
  })

  it("an API error fails open: no suggestions, error recorded, other batches still run", async () => {
    let call = 0
    const fetchImpl = (async () => {
      call++
      if (call === 1) return new Response("overloaded", { status: 529 })
      return new Response(JSON.stringify({
        content: [{ type: "tool_use", name: "suggest_categories", input: { suggestions: [
          { id: "tx-40", category: "fee", confidence: "high" },
        ] } }],
      }), { status: 200 })
    }) as unknown as typeof fetch

    const txs = Array.from({ length: 80 }, (_, i) => tx(`tx-${i}`))
    const res = await aiSuggestCategories(txs, CTX, { fetchImpl })
    expect(res.errors.some(e => e.includes("529"))).toBe(true)
    expect(res.suggestions.map(s => s.id)).toEqual(["tx-40"])
  })

  it("network exceptions are caught per batch, never thrown", async () => {
    const fetchImpl = (async () => { throw new Error("ECONNRESET") }) as unknown as typeof fetch
    const res = await aiSuggestCategories([tx("a")], CTX, { fetchImpl })
    expect(res.suggestions).toEqual([])
    expect(res.errors[0]).toContain("ECONNRESET")
  })
})

// ── Phase 0 (2026-07-03): truncation surfacing, per-batch hook, kill switch ──

describe("aiSuggestCategories — Phase 0 foundations", () => {
  const KEY = "ANTHROPIC_API_KEY"
  let savedKey: string | undefined
  beforeEach(() => { savedKey = process.env[KEY]; process.env[KEY] = "test-key" })
  afterEach(() => {
    if (savedKey === undefined) delete process.env[KEY]
    else process.env[KEY] = savedKey
  })

  it("surfaces a max_tokens truncation as a counted error (was silent)", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({
        stop_reason: "max_tokens",
        content: [{ type: "tool_use", name: "suggest_categories", input: { suggestions: [] } }],
      }), { status: 200 })) as unknown as typeof fetch
    const res = await aiSuggestCategories([tx("a")], CTX, { fetchImpl })
    expect(res.stats.truncatedBatches).toBe(1)
    expect(res.errors.some(e => e.includes("TRUNCATED at max_tokens"))).toBe(true)
  })

  it("calls onBatch after each batch with that batch's suggestions (per-batch persistence)", async () => {
    // 41 txs → 2 batches of 40 + 1
    const txs = Array.from({ length: 41 }, (_, i) => tx(`t${i}`))
    const fetchImpl = (async (_url: unknown, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? "{}") as { messages: Array<{ content: string }> }
      const ids = Array.from(body.messages[0].content.matchAll(/^(t\d+) \|/gm), m => m[1])
      return new Response(JSON.stringify({
        content: [{ type: "tool_use", name: "suggest_categories", input: {
          suggestions: ids.map(id => ({ id, category: "expense", subcategory: "software", confidence: "high" })),
        } }],
      }), { status: 200 })
    }) as unknown as typeof fetch
    const batches: number[] = []
    const res = await aiSuggestCategories(txs, CTX, {
      fetchImpl,
      onBatch: async (sugg, meta) => { batches.push(sugg.length); expect(meta.batchIndex).toBe(batches.length - 1) },
    })
    expect(batches).toEqual([40, 1])
    expect(res.suggestions).toHaveLength(41) // final return still complete (back-compat)
    expect(res.stats.batchesSent).toBe(2)
  })

  it("a throwing onBatch is recorded as a batch error; the run continues and returns all suggestions", async () => {
    const txs = Array.from({ length: 41 }, (_, i) => tx(`t${i}`))
    const fetchImpl = fakeFetchReturning([{ id: "t0", category: "expense", subcategory: "s", confidence: "high" }])
    let calls = 0
    const res = await aiSuggestCategories(txs, CTX, {
      fetchImpl,
      onBatch: async () => { calls++; if (calls === 1) throw new Error("db write failed") },
    })
    expect(res.errors.some(e => e.includes("db write failed"))).toBe(true)
    expect(res.stats.batchesSent).toBe(2) // second batch still ran
  })

  it("kill switch: AI_CATEGORIZATION_DISABLED=1 skips everything with an explicit reason", async () => {
    process.env.AI_CATEGORIZATION_DISABLED = "1"
    try {
      let fetched = false
      const fetchImpl = (async () => { fetched = true; return new Response("{}") }) as unknown as typeof fetch
      const res = await aiSuggestCategories([tx("a")], CTX, { fetchImpl })
      expect(fetched).toBe(false)
      expect(res.suggestions).toHaveLength(0)
      expect(res.errors[0]).toContain("kill switch")
    } finally {
      delete process.env.AI_CATEGORIZATION_DISABLED
    }
  })
})

describe("aiSuggestCategories — Phase 3R chained chunks", () => {
  const KEY = "ANTHROPIC_API_KEY"
  let savedKey: string | undefined
  beforeEach(() => { savedKey = process.env[KEY]; process.env[KEY] = "test-key" })
  afterEach(() => {
    if (savedKey === undefined) delete process.env[KEY]
    else process.env[KEY] = savedKey
  })

  it("stops CLEANLY before the deadline (never mid-batch) and flags stoppedOnDeadline", async () => {
    // Injected clock: each batch "takes" 50s. Deadline allows ~2 batches
    // (guard: now + 100s allowance must fit).
    let t = 0
    const fetchImpl = (async () => {
      t += 50_000
      return new Response(JSON.stringify({
        content: [{ type: "tool_use", name: "suggest_categories", input: { suggestions: [] } }],
      }), { status: 200 })
    }) as unknown as typeof fetch
    const txs = Array.from({ length: 200 }, (_, i) => tx(`tx-${i}`)) // 5 batches
    const res = await aiSuggestCategories(txs, CTX, {
      fetchImpl,
      deadlineAt: 190_000, // guard passes at t=0 and t=50k; refuses at t=100k (100k+100k > 190k)
      now: () => t,
    })
    expect(res.stats.stoppedOnDeadline).toBe(true)
    expect(res.stats.batchesSent).toBe(2)
  })

  it("no deadline → runs to completion, flag unset (single-shot behavior unchanged)", async () => {
    const txs = Array.from({ length: 85 }, (_, i) => tx(`tx-${i}`))
    const res = await aiSuggestCategories(txs, CTX, { fetchImpl: fakeFetchReturning([]) })
    expect(res.stats.stoppedOnDeadline).toBeUndefined()
    expect(res.stats.batchesSent).toBe(3)
  })

  it("batch partition is invariant under chunking: chunked runs see the SAME batches single-shot would (eval-invariance cond. 10)", async () => {
    const record = (bucket: string[][]) => (async (_url: unknown, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? "{}")
      const ids = ((body.messages[0].content as string).match(/tx-\d+/g) ?? [])
      bucket.push(Array.from(new Set(ids)))
      return new Response(JSON.stringify({
        content: [{ type: "tool_use", name: "suggest_categories", input: { suggestions: [] } }],
      }), { status: 200 })
    }) as unknown as typeof fetch

    const txs = Array.from({ length: 100 }, (_, i) => tx(`tx-${i}`)) // 3 batches: 40/40/20
    const single: string[][] = []
    await aiSuggestCategories(txs, CTX, { fetchImpl: record(single) })

    // Chunked: chunk 1 does one batch (tight deadline), chunk 2 gets the REST
    // of the candidate list (rows the first chunk processed are gone).
    const chunked: string[][] = []
    let t = 0
    const timedRecord = (async (url: unknown, init?: { body?: string }) => {
      t += 60_000
      return (record(chunked) as unknown as (u: unknown, i?: { body?: string }) => Promise<Response>)(url, init)
    }) as unknown as typeof fetch
    await aiSuggestCategories(txs.slice(0, 100), CTX, { fetchImpl: timedRecord, deadlineAt: 100_000, now: () => t })
    const processedFirst = chunked.flat()
    const rest = txs.filter(x => !processedFirst.includes(x.id))
    await aiSuggestCategories(rest, CTX, { fetchImpl: record(chunked) })

    expect(chunked).toEqual(single)
  })
})
