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
// find_client_threads now reads TWO lists — Team Chat (the live one) and the older
// tracking list (the archive) — plus the Team Chat messages. Keyed by table so a
// test can seed one side without the other silently answering for it.
let teamThreadsResult: { data: unknown[] | null; error: { message: string } | null }
let teamMessagesResult: { data: unknown[] | null; error: { message: string } | null }
let lastInsert: Record<string, unknown> | null = null
let lastUpdate: Record<string, unknown> | null = null

function makeBuilder(table = "") {
  const state = { op: "" as "" | "insert" | "update", table }
  const b: Record<string, unknown> = {
    from: (t: string) => { state.table = t; return b },
    is: () => b,
    in: () => b,
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
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
      const r =
        state.table === "internal_threads" ? teamThreadsResult
        : state.table === "internal_messages" ? teamMessagesResult
        : findResult
      return Promise.resolve(r).then(res, rej)
    },
  }
  return b
}

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: { from: (t: string) => makeBuilder(t) },
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
  teamThreadsResult = { data: [], error: null }
  teamMessagesResult = { data: [], error: null }
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
    expect(r).toContain("No conversations")
  })

  it("REGRESSION: answers with what was SAID, never a slack.com link", async () => {
    // This used to return a slack.com permalink per conversation. With the workspace
    // gone that is a dead end handed to staff on all four panels — while the stored
    // copy of the very conversation being asked about sat unread in the same row.
    findResult = {
      data: [
        {
          id: "ct-1",
          topic_slug: "banking",
          status: "open",
          source: "slack",
          source_ref: "C0BA802S9LH:1781886351.552489",
          created_at: "2026-06-21T10:00:00Z",
          transcript: [
            { author: "Marco Rossi", text: "the bank asked for the EIN letter", ts: "1781886351.552489" },
            { author: "Luca", text: "sent it this morning", ts: "1781886400.000000" },
          ],
        },
      ],
      error: null,
    }
    const r = await findClientThreadsForWorker({ account_id: "acc-1" })
    expect(r).toContain("Found 1 conversation")
    expect(r).toContain("banking")
    expect(r).toContain("the bank asked for the EIN letter")
    expect(r).toContain("Luca: sent it this morning")
    expect(r).not.toContain("slack.com")
  })

  it("REGRESSION: a conversation started in TEAM CHAT is found — the whole point of the repoint", async () => {
    // The lookup used to read only the old tracking list. Its writers were the Slack
    // modal and a tagger switched on only inside the Slack support channel, so once
    // Slack goes that list never grows again — and every conversation started in Team
    // Chat from that day on would be invisible here. The worker would then answer
    // "what's open for this client" with a confidently out-of-date picture.
    teamThreadsResult = {
      data: [
        {
          id: "tt-1",
          title: "QA Alpha LLC — banking",
          topic_slug: "banking",
          account_id: "acc-1",
          resolved_at: null,
          created_at: "2026-07-30T09:00:00Z",
          last_activity_at: "2026-07-31T09:00:00Z",
        },
      ],
      error: null,
    }
    teamMessagesResult = {
      data: [
        { thread_id: "tt-1", sender_name: "Luca", message: "bank wants the EIN letter", created_at: "2026-07-31T09:00:00Z" },
      ],
      error: null,
    }
    const r = await findClientThreadsForWorker({ account_id: "acc-1" })
    expect(r).toContain("banking")
    expect(r).toContain("in Team Chat")
    expect(r).toContain("bank wants the EIN letter")
  })

  it("shows BOTH lists, newest first, each saying where it lives", async () => {
    teamThreadsResult = {
      data: [{ id: "tt-1", title: "Acme — tax", topic_slug: "tax", account_id: "acc-1", resolved_at: null, created_at: "2026-07-30T09:00:00Z", last_activity_at: "2026-07-31T09:00:00Z" }],
      error: null,
    }
    teamMessagesResult = { data: [{ thread_id: "tt-1", sender_name: "Luca", message: "newest thing", created_at: "2026-07-31T09:00:00Z" }], error: null }
    findResult = {
      data: [{ id: "ct-1", topic_slug: "banking", status: "open", source: "slack", source_ref: "C1:1.1", created_at: "2026-06-21T10:00:00Z", transcript: [{ author: "Marco", text: "older thing", ts: "1" }] }],
      error: null,
    }
    const r = await findClientThreadsForWorker({ account_id: "acc-1" })
    expect(r).toContain("Found 2 conversation")
    expect(r).toContain("in Team Chat")
    expect(r).toContain("earlier record, not in Team Chat")
    // Newest first — the live one leads.
    expect(r.indexOf("newest thing")).toBeLessThan(r.indexOf("older thing"))
  })

  it("a broken Team Chat read is REPORTED, never answered as 'no conversations'", async () => {
    // Half a lookup failing and returning the other half looks like a complete
    // answer. For "what's open for this client" that is a confidently wrong picture.
    teamThreadsResult = { data: null, error: { message: "connection reset" } }
    const r = await findClientThreadsForWorker({ account_id: "acc-1" })
    expect(r).toMatch(/❌/)
    expect(r).toMatch(/Team Chat/i)
    expect(r).toMatch(/connection reset/)
  })

  it("says plainly when there is no stored copy, rather than implying the conversation was empty", async () => {
    findResult = {
      data: [
        { id: "ct-2", topic_slug: "tax", status: "open", source: "slack", source_ref: "C1:1.1", created_at: "2026-06-21T10:00:00Z", transcript: null },
      ],
      error: null,
    }
    const r = await findClientThreadsForWorker({ account_id: "acc-1" })
    expect(r).toMatch(/no stored copy/i)
    expect(r).not.toContain("slack.com")
  })

  it("caps a long conversation and says how much was left out", async () => {
    // The caller is a model with a context budget; an unbounded dump would crowd out
    // the rest of the turn, and silent truncation would read as the whole record.
    findResult = {
      data: [
        {
          id: "ct-3", topic_slug: "tax", status: "open", source: "slack", source_ref: "C1:1.1",
          created_at: "2026-06-21T10:00:00Z",
          transcript: Array.from({ length: 20 }, (_, i) => ({ author: "Luca", text: `line ${i}`, ts: `${i}` })),
        },
      ],
      error: null,
    }
    const r = await findClientThreadsForWorker({ account_id: "acc-1" })
    expect(r).toContain("line 19")
    expect(r).toMatch(/earlier message\(s\) not shown/)
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
