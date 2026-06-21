/**
 * Client Threads — Slack worker tag/find tools (dev_task 54f89912).
 *
 * Pins: topic validation against the topic_templates catalog, the source_ref key,
 * race-safe upsert (insert → on 23505 update), confidence clamp, the noise gate
 * (no client → no write), the find filters, and the R108 safety invariants
 * (tools NOT in shared WORKER_TOOLS; executor availableNames gate).
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

// Mutable Slack context the tag tool reads via dynamic import of slack-claude.
const h = vi.hoisted(() => ({
  slackCtx: { channelId: "C0BA802S9LH", threadTs: "1781886351.552489" } as {
    channelId?: string
    threadTs?: string
  },
}))

// Reconfigurable supabase responses + capture of the written rows.
let insertResult: { data: { id: string } | null; error: { code?: string; message: string } | null }
let updateResult: { data: { id: string } | null; error: { message: string } | null }
let findResult: { data: unknown[] | null; error: { message: string } | null }
let lastInsert: Record<string, unknown> | null = null
let lastUpdate: Record<string, unknown> | null = null

function makeBuilder() {
  const state = { op: "" as "" | "insert" | "update" }
  const b: Record<string, unknown> = {
    from: () => b,
    select: () => b,
    order: () => b,
    limit: () => b,
    eq: () => b,
    or: () => b,
    gte: () => b,
    insert: (row: unknown) => {
      lastInsert = row as Record<string, unknown>
      state.op = "insert"
      return b
    },
    update: (obj: unknown) => {
      lastUpdate = obj as Record<string, unknown>
      state.op = "update"
      return b
    },
    single: async () => (state.op === "insert" ? insertResult : updateResult),
    // Thenable so `await q` (the find path, no .single()) resolves the find result.
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(findResult).then(res, rej),
  }
  return b
}

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: { from: () => makeBuilder() },
}))

vi.mock("@/lib/ai-agent/slack-claude", () => ({ _currentSlackCtx: h.slackCtx }))

vi.mock("@/lib/catalog/framework", () => ({
  listEntries: vi.fn(async () => [{ slug: "banking" }, { slug: "general" }, { slug: "tax" }]),
}))

const logAction = vi.fn()
vi.mock("@/lib/mcp/action-log", () => ({ logAction: (...a: unknown[]) => logAction(...a) }))

import {
  tagClientThreadFromWorker,
  findClientThreadsForWorker,
  executeWorkerTool,
  WORKER_TOOLS,
  TAG_CLIENT_THREAD_TOOL,
  FIND_CLIENT_THREADS_TOOL,
} from "@/lib/ai-agent/worker-tools"

beforeEach(() => {
  insertResult = { data: { id: "ct-1" }, error: null }
  updateResult = { data: { id: "ct-1" }, error: null }
  findResult = { data: [], error: null }
  lastInsert = null
  lastUpdate = null
  logAction.mockClear()
  h.slackCtx.channelId = "C0BA802S9LH"
  h.slackCtx.threadTs = "1781886351.552489"
})

describe("tagClientThreadFromWorker", () => {
  it("rejects when no client (account/contact/lead) is provided — the noise gate", async () => {
    const r = await tagClientThreadFromWorker({ topic: "banking" })
    expect(r).toContain("needs a client")
    expect(lastInsert).toBeNull()
  })

  it("rejects an empty topic", async () => {
    const r = await tagClientThreadFromWorker({ account_id: "acc-1", topic: "" })
    expect(r).toContain("topic slug")
    expect(lastInsert).toBeNull()
  })

  it("rejects a topic not in the topic_templates catalog (no free-text fragmentation)", async () => {
    const r = await tagClientThreadFromWorker({ account_id: "acc-1", topic: "not_a_topic" })
    expect(r).toContain("not a known topic")
    expect(r).toContain("banking")
    expect(lastInsert).toBeNull()
  })

  it("rejects when there's no Slack thread context", async () => {
    h.slackCtx.channelId = undefined
    const r = await tagClientThreadFromWorker({ account_id: "acc-1", topic: "banking" })
    expect(r).toContain("No Slack thread context")
    expect(lastInsert).toBeNull()
  })

  it("inserts an auto tag with source_ref = channelId:threadTs and default confidence 0.5", async () => {
    const r = await tagClientThreadFromWorker({ account_id: "acc-1", topic: "banking" })
    expect(r).toContain("📌 Tagged")
    expect(lastInsert).toMatchObject({
      account_id: "acc-1",
      contact_id: null,
      lead_id: null,
      topic_slug: "banking",
      source: "slack",
      source_ref: "C0BA802S9LH:1781886351.552489",
      source_kind: "auto",
      confidence: 0.5,
    })
    expect(logAction).toHaveBeenCalledOnce()
  })

  it("clamps an out-of-range confidence to [0,1]", async () => {
    await tagClientThreadFromWorker({ contact_id: "cnt-1", topic: "tax", confidence: 2 })
    expect(lastInsert).toMatchObject({ contact_id: "cnt-1", confidence: 1 })
  })

  it("on a duplicate (23505) it UPDATES the existing row instead of erroring — idempotency", async () => {
    insertResult = { data: null, error: { code: "23505", message: "duplicate key" } }
    const r = await tagClientThreadFromWorker({ account_id: "acc-1", topic: "general" })
    expect(r).toContain("Updated this thread")
    expect(lastUpdate).toMatchObject({ topic_slug: "general", account_id: "acc-1" })
  })
})

describe("findClientThreadsForWorker", () => {
  it("requires at least one filter", async () => {
    const r = await findClientThreadsForWorker({})
    expect(r).toContain("needs at least one filter")
  })

  it("returns a friendly empty message when nothing matches", async () => {
    findResult = { data: [], error: null }
    const r = await findClientThreadsForWorker({ account_id: "acc-1" })
    expect(r).toContain("No tagged conversations")
  })

  it("formats matching threads with topic, status, and a Slack link", async () => {
    findResult = {
      data: [
        {
          id: "ct-1",
          topic_slug: "banking",
          status: "open",
          source: "slack",
          source_ref: "C0BA802S9LH:1781886351.552489",
          created_at: "2026-06-21T10:00:00Z",
        },
      ],
      error: null,
    }
    const r = await findClientThreadsForWorker({ account_id: "acc-1" })
    expect(r).toContain("Found 1 tagged conversation")
    expect(r).toContain("banking")
    expect(r).toContain("https://slack.com/archives/C0BA802S9LH/p1781886351552489")
  })
})

describe("Client Threads — R108 safety wiring", () => {
  it("tag/find tools are NOT in the shared WORKER_TOOLS (must never reach Hermes)", () => {
    expect(WORKER_TOOLS.some((t) => t.name === TAG_CLIENT_THREAD_TOOL.name)).toBe(false)
    expect(WORKER_TOOLS.some((t) => t.name === FIND_CLIENT_THREADS_TOOL.name)).toBe(false)
  })

  it("executeWorkerTool refuses tag_client_thread when it wasn't offered this call", async () => {
    const r = await executeWorkerTool("tag_client_thread", { account_id: "acc-1", topic: "banking" }, new Set())
    expect(r).toContain("not permitted")
    expect(lastInsert).toBeNull()
  })

  it("executeWorkerTool routes tag_client_thread when availableNames includes it", async () => {
    const r = await executeWorkerTool(
      "tag_client_thread",
      { account_id: "acc-1", topic: "banking" },
      new Set(["tag_client_thread"]),
    )
    expect(r).not.toContain("not permitted")
    expect(r).toContain("📌 Tagged")
  })

  it("executeWorkerTool refuses find_client_threads when it wasn't offered this call", async () => {
    const r = await executeWorkerTool("find_client_threads", { account_id: "acc-1" }, new Set())
    expect(r).toContain("not permitted")
  })
})
