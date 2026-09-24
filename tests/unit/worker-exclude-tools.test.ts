import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const state = vi.hoisted(() => ({
  requests: [] as Array<{ system: Array<{ text: string }>; tools: Array<{ name: string }> }>,
  threadSetupThrows: false,
}))

vi.mock("@/lib/supabase-admin", () => {
  const b: Record<string, unknown> = {}
  for (const m of ["from", "select", "eq", "is", "in", "or", "order", "limit", "not", "neq", "update", "insert"]) b[m] = () => b
  b.maybeSingle = async () => ({ data: null })
  b.single = async () => ({ data: null, error: null })
  b.then = (resolve: (v: unknown) => void) => Promise.resolve({ data: [], error: null }).then(resolve)
  return { supabaseAdmin: b }
})
vi.mock("@/lib/mcp/action-log", () => ({ logAction: async () => {} }))
vi.mock("@/lib/ai-agent/decision-memory", () => ({
  recallDecisionMemory: async () => [],
  recallClientDecisionMemory: async () => [],
}))
vi.mock("@/lib/ai-agent/thread-summaries", () => ({
  getThreadSummary: async () => {
    if (state.threadSetupThrows) throw new Error("thread setup exploded")
    return { thread_type: "investigation" }
  },
  createThreadSummary: async () => {},
  resolveThread: async () => {},
}))
vi.mock("@/lib/ai-agent/thread-context", () => ({
  buildThreadContext: async () => ({ text: "" }),
  buildReplayTurns: async () => [],
}))
vi.mock("@/lib/ai-agent/thread-recall", () => ({
  buildRelatedThreadsSuffix: async () => "",
  embedThreadSummary: async () => {},
}))

import { callWorker } from "@/lib/ai-agent/worker-tools"

const realFetch = globalThis.fetch

beforeEach(() => {
  state.requests = []
  state.threadSetupThrows = false
  process.env.ANTHROPIC_API_KEY = "test-key"
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    if (String(url).includes("api.anthropic.com")) {
      state.requests.push(JSON.parse(String(init?.body)))
      return new Response(
        JSON.stringify({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: {} }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }
    return new Response("{}", { status: 500 })
  }) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
})

const names = () => state.requests[0].tools.map((t) => t.name)

describe("callWorker excludeTools", () => {
  it("leaves the base tool list unchanged when the option is not used (every other surface)", async () => {
    await callWorker("hello", { model: "test-model" })
    expect(names()).toContain("memory_save")
    expect(names()).toContain("codebase_read")
    expect(names()).toContain("codebase_search")
  })

  it("removes exactly the excluded tools and keeps the read tools", async () => {
    await callWorker("hello", { model: "test-model", excludeTools: ["memory_save", "codebase_read", "codebase_search"] })
    expect(names()).not.toContain("memory_save")
    expect(names()).not.toContain("codebase_read")
    expect(names()).not.toContain("codebase_search")
    expect(names()).toContain("search_leads")
    expect(names()).toContain("get_client_360")
  })

  it("removes an excluded tool even when an enable* flag would have added it", async () => {
    await callWorker("hello", { model: "test-model", enableCrmNotes: true, enableDbRead: true, excludeTools: ["run_sql_query"] })
    expect(names()).not.toContain("run_sql_query")
    expect(names()).toContain("search_leads")
  })
})

describe("callWorker thread-setup failure", () => {
  it("keeps the surface's own system prompt instead of falling back to the generic one", async () => {
    state.threadSetupThrows = true
    await callWorker("hello", {
      model: "test-model",
      threadId: "11111111-1111-4111-8111-111111111111",
      systemPromptOverride: "WHATSAPP-SURFACE-PROMPT-MARKER",
      excludeTools: ["memory_save"],
    })
    expect(state.requests[0].system[0].text).toContain("WHATSAPP-SURFACE-PROMPT-MARKER")
    expect(names()).not.toContain("memory_save")
  })
})
