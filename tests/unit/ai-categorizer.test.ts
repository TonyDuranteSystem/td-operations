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
