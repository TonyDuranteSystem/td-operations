/**
 * Tests for the Decision Memory utility (lib/ai-agent/decision-memory.ts).
 *
 * Covers embedding generation (OpenAI fetch), save, recall, confirm, and the
 * contradict → supersede flow. The Supabase client and global fetch are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// ─── Hoisted Supabase mock ───────────────────────────────────────

const { mockFrom, mockRpc } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockRpc: vi.fn(),
}))

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: mockFrom,
    rpc: mockRpc,
  },
}))

import {
  generateEmbedding,
  saveDecisionMemory,
  recallDecisionMemory,
  confirmMemory,
  contradictMemory,
  voidMemory,
  EMBEDDING_DIM,
} from "@/lib/ai-agent/decision-memory"

// ─── Helpers ─────────────────────────────────────────────────────

/** A chainable query-builder whose await/.single() resolves to `result`. */
function builder(result: { data?: unknown; error?: unknown }) {
  const b: Record<string, unknown> = {}
  for (const m of ["select", "insert", "update", "eq", "in"]) {
    b[m] = vi.fn(() => b)
  }
  b.single = vi.fn(() => Promise.resolve(result))
  // Make the builder itself awaitable (terminal .in()/.eq() are awaited directly).
  b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject)
  return b
}

const validEmbedding = () => Array.from({ length: EMBEDDING_DIM }, () => 0.01)

function mockFetchOnceEmbedding(embedding: number[]) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ data: [{ embedding }] }),
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

// ─── Setup ───────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  process.env.OPENAI_API_KEY = "sk-test"
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.OPENAI_API_KEY
})

// ─── generateEmbedding ───────────────────────────────────────────

describe("generateEmbedding", () => {
  it("returns the embedding array from OpenAI", async () => {
    const emb = validEmbedding()
    const fetchMock = mockFetchOnceEmbedding(emb)
    const out = await generateEmbedding("some situation")
    expect(out).toHaveLength(EMBEDDING_DIM)
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/embeddings",
      expect.objectContaining({ method: "POST" })
    )
  })

  it("throws when OPENAI_API_KEY is missing", async () => {
    delete process.env.OPENAI_API_KEY
    await expect(generateEmbedding("x")).rejects.toThrow(/OPENAI_API_KEY/)
  })

  it("throws on empty input", async () => {
    await expect(generateEmbedding("   ")).rejects.toThrow(/empty input/)
  })

  it("throws on wrong embedding dimension", async () => {
    mockFetchOnceEmbedding([0.1, 0.2, 0.3])
    await expect(generateEmbedding("x")).rejects.toThrow(/expected 1536 dims/)
  })

  it("throws on non-2xx OpenAI response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({ error: "rate" }) })
    )
    await expect(generateEmbedding("x")).rejects.toThrow(/OpenAI embeddings error 429/)
  })
})

// ─── saveDecisionMemory ──────────────────────────────────────────

describe("saveDecisionMemory", () => {
  it("inserts and returns the new id", async () => {
    mockFetchOnceEmbedding(validEmbedding())
    const insertBuilder = builder({ data: { id: "mem-1" }, error: null })
    mockFrom.mockReturnValue(insertBuilder)

    const id = await saveDecisionMemory({
      situation: "client asked to pay by wire",
      decision: "directed them to the portal Pay button",
      sourceType: "chat",
      domain: "billing",
      tags: ["payment"],
    })

    expect(id).toBe("mem-1")
    expect(mockFrom).toHaveBeenCalledWith("decision_memory")
    expect(insertBuilder.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        situation: "client asked to pay by wire",
        decision: "directed them to the portal Pay button",
        source_type: "chat",
        domain: "billing",
        tags: ["payment"],
      })
    )
  })

  it("rejects missing required fields without calling the DB", async () => {
    await expect(
      saveDecisionMemory({ situation: "", decision: "d", sourceType: "chat" })
    ).rejects.toThrow(/situation is required/)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it("surfaces insert errors", async () => {
    mockFetchOnceEmbedding(validEmbedding())
    mockFrom.mockReturnValue(builder({ data: null, error: { message: "boom" } }))
    await expect(
      saveDecisionMemory({ situation: "s", decision: "d", sourceType: "chat" })
    ).rejects.toThrow(/insert failed: boom/)
  })
})

// ─── recallDecisionMemory ────────────────────────────────────────

describe("recallDecisionMemory", () => {
  it("embeds the query and returns RPC matches", async () => {
    mockFetchOnceEmbedding(validEmbedding())
    const matches = [
      { id: "m1", situation: "s", decision: "d", similarity: 0.9, tags: [], confidence: 0.8 },
    ]
    mockRpc.mockResolvedValue({ data: matches, error: null })

    const out = await recallDecisionMemory("how to handle wire payment", { trackRecall: false })

    expect(out).toEqual(matches)
    expect(mockRpc).toHaveBeenCalledWith(
      "match_decision_memory",
      expect.objectContaining({ match_threshold: 0.7, match_count: 10, filter_status: "active" })
    )
  })

  it("passes domain + threshold overrides through", async () => {
    mockFetchOnceEmbedding(validEmbedding())
    mockRpc.mockResolvedValue({ data: [], error: null })
    await recallDecisionMemory("q", { domain: "tax", matchThreshold: 0.85, matchCount: 3, trackRecall: false })
    expect(mockRpc).toHaveBeenCalledWith(
      "match_decision_memory",
      expect.objectContaining({ filter_domain: "tax", match_threshold: 0.85, match_count: 3 })
    )
  })

  it("surfaces RPC errors", async () => {
    mockFetchOnceEmbedding(validEmbedding())
    mockRpc.mockResolvedValue({ data: null, error: { message: "rpc-fail" } })
    await expect(recallDecisionMemory("q")).rejects.toThrow(/RPC failed: rpc-fail/)
  })

  it("bumps recall stats when trackRecall is not disabled (best-effort)", async () => {
    mockFetchOnceEmbedding(validEmbedding())
    const matches = [{ id: "m1", situation: "s", decision: "d", similarity: 0.9, tags: [], confidence: 0.8 }]
    mockRpc.mockResolvedValue({ data: matches, error: null })
    // First from() = select existing stats; subsequent from() = per-row update.
    const selectBuilder = builder({ data: [{ id: "m1", times_recalled: 2 }], error: null })
    const updateBuilder = builder({ data: null, error: null })
    mockFrom.mockReturnValueOnce(selectBuilder).mockReturnValue(updateBuilder)

    const out = await recallDecisionMemory("q")
    expect(out).toEqual(matches)
    expect(updateBuilder.update).toHaveBeenCalledWith(
      expect.objectContaining({ times_recalled: 3 })
    )
  })
})

// ─── confirmMemory ───────────────────────────────────────────────

describe("confirmMemory", () => {
  it("increments times_confirmed", async () => {
    const readBuilder = builder({ data: { times_confirmed: 4 }, error: null })
    const updateBuilder = builder({ data: null, error: null })
    mockFrom.mockReturnValueOnce(readBuilder).mockReturnValue(updateBuilder)

    await confirmMemory("mem-1")

    expect(updateBuilder.update).toHaveBeenCalledWith(
      expect.objectContaining({ times_confirmed: 5 })
    )
  })

  it("throws when id missing", async () => {
    await expect(confirmMemory("")).rejects.toThrow(/id is required/)
  })
})

// ─── contradictMemory ────────────────────────────────────────────

describe("contradictMemory", () => {
  it("creates a replacement memory and supersedes the old one", async () => {
    mockFetchOnceEmbedding(validEmbedding())
    const oldRow = {
      situation: "client asked to pay by wire",
      reasoning: "policy R092",
      tags: ["payment"],
      domain: "billing",
      actors: ["antonio"],
      source_type: "chat",
      source_ref: "msg-7",
      confidence: 0.8,
      times_contradicted: 1,
    }
    const readBuilder = builder({ data: oldRow, error: null })
    const insertBuilder = builder({ data: { id: "mem-new" }, error: null })
    const updateBuilder = builder({ data: null, error: null })
    // from() order: read old → insert new (inside saveDecisionMemory) → update old
    mockFrom
      .mockReturnValueOnce(readBuilder)
      .mockReturnValueOnce(insertBuilder)
      .mockReturnValue(updateBuilder)

    const newId = await contradictMemory("mem-old", "accept ACH instead")

    expect(newId).toBe("mem-new")
    // Replacement keeps the same situation.
    expect(insertBuilder.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        situation: "client asked to pay by wire",
        decision: "accept ACH instead",
      })
    )
    // Old row marked superseded + linked + contradicted bumped.
    expect(updateBuilder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "superseded",
        superseded_by: "mem-new",
        times_contradicted: 2,
      })
    )
  })

  it("throws when newDecision missing", async () => {
    await expect(contradictMemory("mem-old", "")).rejects.toThrow(/newDecision is required/)
  })

  it("PRESERVES client scope — a client-specific correction stays client-scoped (WS1.5)", async () => {
    mockFetchOnceEmbedding(validEmbedding())
    const oldRow = {
      situation: "how to bill THIS client",
      reasoning: null, tags: null, domain: null, actors: null,
      source_type: "chat", source_ref: "msg-9", confidence: 0.6, times_contradicted: 0,
      client_key: "account:acct-42", bot_said: "I said EUR",
    }
    const readBuilder = builder({ data: oldRow, error: null })
    const insertBuilder = builder({ data: { id: "mem-new" }, error: null })
    const updateBuilder = builder({ data: null, error: null })
    mockFrom
      .mockReturnValueOnce(readBuilder)
      .mockReturnValueOnce(insertBuilder)
      .mockReturnValue(updateBuilder)

    await contradictMemory("mem-old", "bill in USD for this client")

    // The replacement must carry the SAME client_key — not leak to global (null).
    expect(insertBuilder.insert).toHaveBeenCalledWith(
      expect.objectContaining({ client_key: "account:acct-42" })
    )
  })
})

// ─── voidMemory ──────────────────────────────────────────────────

describe("voidMemory", () => {
  it("flips status to 'voided' (removed from recall, no replacement)", async () => {
    const updateBuilder = builder({ data: null, error: null })
    mockFrom.mockReturnValue(updateBuilder)

    await voidMemory("mem-bad")

    expect(updateBuilder.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "voided" })
    )
    // No insert — a void must NOT create a new active row.
    expect(updateBuilder.insert).not.toHaveBeenCalled()
  })

  it("throws when id missing", async () => {
    await expect(voidMemory("")).rejects.toThrow(/id is required/)
  })
})
