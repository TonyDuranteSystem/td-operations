/**
 * search_conversations (lib/ai-agent/tools.ts), conv_search, and sop_search (both
 * lib/mcp/tools/operations.ts) all built their .or() filter by splicing the raw search
 * text straight into a PostgREST filter string. A comma or parenthesis in the search text
 * (e.g. "Achievers Group, LLC") broke the filter syntax and the query errored instead of
 * searching — the root cause behind a worker self-report on the Vanquish Group LLC thread.
 * get_client_history already carried the correct fix (lib/ai-agent/tools.ts:1380); this
 * applies the same one to all three siblings.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => ({
  orCalls: [] as string[],
}))

vi.mock("@/lib/supabase-admin", () => {
  const chain = {
    select: () => chain,
    order: () => chain,
    limit: () => chain,
    eq: () => chain,
    gte: () => chain,
    lte: () => chain,
    or: (filter: string) => {
      h.orCalls.push(filter)
      return chain
    },
    then: (resolve: (v: { data: unknown[]; error: null }) => void) => resolve({ data: [], error: null }),
  }
  return {
    supabaseAdmin: {
      from: () => chain,
    },
  }
})

beforeEach(() => {
  h.orCalls.length = 0
})

describe("search_conversations (lib/ai-agent/tools.ts)", () => {
  it("strips commas and parentheses from the search text before building the filter", async () => {
    const { executeTool } = await import("@/lib/ai-agent/tools")
    await executeTool("search_conversations", { query: "Achievers Group, LLC (2024)" })
    expect(h.orCalls).toHaveLength(1)
    const filter = h.orCalls[0]
    // The raw text must never reach the filter with its commas/parens intact —
    // each one breaks PostgREST's .or() syntax if left in.
    expect(filter).not.toContain(", LLC (2024)")
    expect(filter).toBe(
      "topic.ilike.%Achievers Group  LLC  2024 %,client_message.ilike.%Achievers Group  LLC  2024 %"
    )
  })

  it("leaves a plain query untouched", async () => {
    const { executeTool } = await import("@/lib/ai-agent/tools")
    await executeTool("search_conversations", { query: "banking form" })
    expect(h.orCalls[0]).toBe("topic.ilike.%banking form%,client_message.ilike.%banking form%")
  })
})

describe("conv_search (lib/mcp/tools/operations.ts)", () => {
  it("strips commas and parentheses from the search text before building the filter", async () => {
    const { registerOperationsTools } = await import("@/lib/mcp/tools/operations")
    const handlers: Record<string, (params: Record<string, unknown>) => Promise<unknown>> = {}
    const fakeServer = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tool: (name: string, ..._rest: any[]) => {
        handlers[name] = _rest[_rest.length - 1]
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    registerOperationsTools(fakeServer)

    await handlers["conv_search"]({ query: "Achievers Group, LLC (2024)" })
    expect(h.orCalls).toHaveLength(1)
    expect(h.orCalls[0]).toBe(
      "topic.ilike.%Achievers Group  LLC  2024 %,client_message.ilike.%Achievers Group  LLC  2024 %"
    )
  })
})

describe("sop_search (lib/mcp/tools/operations.ts)", () => {
  it("strips commas and parentheses from the search text before building the filter", async () => {
    const { registerOperationsTools } = await import("@/lib/mcp/tools/operations")
    const handlers: Record<string, (params: Record<string, unknown>) => Promise<unknown>> = {}
    const fakeServer = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tool: (name: string, ..._rest: any[]) => {
        handlers[name] = _rest[_rest.length - 1]
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    registerOperationsTools(fakeServer)

    await handlers["sop_search"]({ query: "Formation, LLC (Wyoming)" })
    expect(h.orCalls).toHaveLength(1)
    expect(h.orCalls[0]).toBe(
      "title.ilike.%Formation  LLC  Wyoming %,content.ilike.%Formation  LLC  Wyoming %"
    )
  })
})
