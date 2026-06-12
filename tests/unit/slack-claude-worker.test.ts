/**
 * Unit tests for lib/ai-agent/slack-claude.ts
 *
 * Tests: slackScopeKey, SLACK_WORKER_SYSTEM_PROMPT shape,
 * findOrCreateConversationThread (scope reuse + new thread creation),
 * processSlackEvent (calls callWorker + posts to Slack + updates DB).
 *
 * All DB and external calls are mocked — no real network required.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

// --- Mocks ---------------------------------------------------------------

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: vi.fn(),
  },
}))

vi.mock("@/lib/ai-agent/worker-tools", () => ({
  callWorker: vi.fn(),
}))

vi.mock("@/lib/ai-agent/thread-summaries", () => ({
  createThreadSummary: vi.fn(),
}))

// Mock fetch globally (used for Slack API calls)
const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)

// -------------------------------------------------------------------------

import {
  slackScopeKey,
  SLACK_WORKER_SYSTEM_PROMPT,
  findOrCreateConversationThread,
  processSlackEvent,
  updateSlackMessage,
  prepareSlackImages,
  fetchThreadImages,
  fetchThreadHistory,
  buildThinkingBlocks,
  verifySlackSignature,
  parseSlackInteraction,
  STOP_THINKING_ACTION_ID,
} from "@/lib/ai-agent/slack-claude"
import { createHmac } from "crypto"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { callWorker } from "@/lib/ai-agent/worker-tools"
import { createThreadSummary } from "@/lib/ai-agent/thread-summaries"

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

function _makeSupabaseChain(data: unknown, error: unknown = null) {
  const chain: Record<string, unknown> = {}
  const methods = ["from","select","insert","update","eq","filter","not","gt","lt","order","limit","single","maybeSingle"]
  methods.forEach((m) => { chain[m] = vi.fn().mockReturnValue(chain) })
  chain.select = vi.fn().mockReturnValue({ ...chain, data, error })
  chain.limit = vi.fn().mockReturnValue({ data, error })
  chain.maybeSingle = vi.fn().mockResolvedValue({ data, error })
  chain.update = vi.fn().mockReturnValue({ ...chain, data: null, error: null })
  return chain
}

/**
 * Robust thenable chain for the processSlackEvent tests. processSlackEvent now
 * issues three kinds of supabase calls per run: a cancellation re-read
 * (select→eq→maybeSingle), a TOCTOU-guarded done-update (update→eq→eq, awaited),
 * and the decision-memory lookup (…→limit, awaited). A single chain where every
 * builder method returns `this`, terminal awaits resolve, and maybeSingle
 * reports the live status covers all three. Override `status` to simulate a Stop
 * landing mid-flight.
 */
function makeProcessChain(opts: { status?: string; data?: unknown[] } = {}): Record<string, unknown> {
  const status = opts.status ?? "processing"
  const result = { data: opts.data ?? [], error: null }
  const chain: Record<string, unknown> = {}
  const passthrough = ["from", "select", "update", "insert", "eq", "in", "filter", "not", "neq", "gt", "lt", "order"]
  passthrough.forEach((m) => { chain[m] = vi.fn(() => chain) })
  chain.limit = vi.fn(() => Promise.resolve(result))
  chain.single = vi.fn(() => Promise.resolve(result))
  chain.maybeSingle = vi.fn(() => Promise.resolve({ data: { status }, error: null }))
  // Thenable so a terminal `await update().eq().eq()` resolves.
  chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject)
  return chain
}

// -------------------------------------------------------------------------
// slackScopeKey
// -------------------------------------------------------------------------

describe("slackScopeKey", () => {
  it("returns channelId alone for top-level messages", () => {
    expect(slackScopeKey("C123", null)).toBe("C123")
    expect(slackScopeKey("C123", undefined)).toBe("C123")
  })

  it("returns channel:thread for threaded messages", () => {
    expect(slackScopeKey("C123", "1234567890.000100")).toBe("C123:1234567890.000100")
  })
})

// -------------------------------------------------------------------------
// SLACK_WORKER_SYSTEM_PROMPT
// -------------------------------------------------------------------------

describe("SLACK_WORKER_SYSTEM_PROMPT", () => {
  it("is a non-empty string", () => {
    expect(typeof SLACK_WORKER_SYSTEM_PROMPT).toBe("string")
    expect(SLACK_WORKER_SYSTEM_PROMPT.length).toBeGreaterThan(50)
  })

  it("instructs discuss-first behavior (not act-first)", () => {
    expect(SLACK_WORKER_SYSTEM_PROMPT).toMatch(/do NOT act/i)
  })

  it("instructs to wait for approval before propose_action", () => {
    expect(SLACK_WORKER_SYSTEM_PROMPT).toMatch(/propose_action/i)
    expect(SLACK_WORKER_SYSTEM_PROMPT).toMatch(/approval/i)
  })

  it("stays under the absolute bloat ceiling", () => {
    // Absolute guard against the Slack prompt ballooning. This was originally a
    // "shorter than the Hermes research prompt" comparison, but that no longer
    // holds and is intentionally dropped: the Slack prompt is now LONGER than
    // Hermes (~1826) and that's fine — the two prompts serve different purposes
    // (Slack = conversational + plain-English-by-default + SHARED THREADS + CODE
    // TASKS + SHIPPING; Hermes = analytical research). Ceiling history: 2000 →
    // 2600 (SHARED THREADS) → 3200 (plain-English block) → 3500 (2026-06-12,
    // headroom for the intentional plain-English rule). Keep this as a sanity cap.
    expect(SLACK_WORKER_SYSTEM_PROMPT.length).toBeLessThan(3500)
  })

  it("instructs awareness of Hermes's messages in shared threads", () => {
    expect(SLACK_WORKER_SYSTEM_PROMPT).toMatch(/SHARED THREADS/)
    expect(SLACK_WORKER_SYSTEM_PROMPT).toMatch(/Hermes/)
  })
})

// -------------------------------------------------------------------------
// findOrCreateConversationThread
// -------------------------------------------------------------------------

describe("findOrCreateConversationThread", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.SLACK_BOT_TOKEN_CLAUDE = "xoxb-test-token"
  })

  it("reuses an existing thread_id for the same scope within 30 min", async () => {
    const existingThreadId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    const mockChain = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      not: vi.fn().mockReturnThis(),
      gt: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({
        data: [
          {
            thread_id: existingThreadId,
            context_json: { slack_scope_key: "C123" },
          },
        ],
        error: null,
      }),
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(supabaseAdmin as any).from = vi.fn().mockReturnValue(mockChain)

    const result = await findOrCreateConversationThread("C123", null)
    expect(result).toBe(existingThreadId)
    expect(createThreadSummary).not.toHaveBeenCalled()
  })

  it("creates a new thread when no recent match exists", async () => {
    const mockChain = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      not: vi.fn().mockReturnThis(),
      gt: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: [], error: null }),
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(supabaseAdmin as any).from = vi.fn().mockReturnValue(mockChain)
    ;(createThreadSummary as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)

    const result = await findOrCreateConversationThread("C456", "1234567890.000100")

    expect(typeof result).toBe("string")
    expect(result.length).toBeGreaterThan(0)
    expect(createThreadSummary).toHaveBeenCalledWith(
      result,
      "investigation",
      "Slack C456:1234567890.000100",
    )
  })

  it("threaded reply reuses the channel-level thread that started the conversation", async () => {
    // Bug 1: channel-level mention stored scope_key = channelId (no thread_ts).
    // The follow-up reply arrives with thread_ts set → scope_key = channelId:thread_ts.
    // It must still find the channel-level thread_id via the channel-only fallback.
    const channelThreadId = "cccccccc-cccc-cccc-cccc-cccccccccccc"
    const mockChain = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      not: vi.fn().mockReturnThis(),
      gt: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({
        data: [
          {
            thread_id: channelThreadId,
            context_json: { slack_scope_key: "C123", slack_event_ts: "1781193406.121259" },
          },
        ],
        error: null,
      }),
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(supabaseAdmin as any).from = vi.fn().mockReturnValue(mockChain)

    const result = await findOrCreateConversationThread("C123", "1781193406.121259")
    expect(result).toBe(channelThreadId)
    expect(createThreadSummary).not.toHaveBeenCalled()
  })

  it("prefers the channel-level row whose original ts matches the reply thread_ts", async () => {
    // Two channel-level conversations in the window; the reply belongs to the older one.
    const olderThreadId = "11111111-1111-1111-1111-111111111111"
    const newerThreadId = "22222222-2222-2222-2222-222222222222"
    const mockChain = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      not: vi.fn().mockReturnThis(),
      gt: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({
        data: [
          // rows are DESC (most recent first)
          { thread_id: newerThreadId, context_json: { slack_scope_key: "C123", slack_event_ts: "200.000" } },
          { thread_id: olderThreadId, context_json: { slack_scope_key: "C123", slack_event_ts: "100.000" } },
        ],
        error: null,
      }),
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(supabaseAdmin as any).from = vi.fn().mockReturnValue(mockChain)

    // Reply in the older thread (thread_ts === older message's event_ts)
    const result = await findOrCreateConversationThread("C123", "100.000")
    expect(result).toBe(olderThreadId)
  })

  it("does not reuse a thread from a different scope", async () => {
    const mockChain = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      not: vi.fn().mockReturnThis(),
      gt: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({
        data: [
          {
            thread_id: "existing-thread",
            context_json: { slack_scope_key: "C999:other-thread-ts" },
          },
        ],
        error: null,
      }),
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(supabaseAdmin as any).from = vi.fn().mockReturnValue(mockChain)
    ;(createThreadSummary as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)

    const result = await findOrCreateConversationThread("C123", null)
    expect(result).not.toBe("existing-thread")
    expect(createThreadSummary).toHaveBeenCalled()
  })
})

// -------------------------------------------------------------------------
// processSlackEvent
// -------------------------------------------------------------------------

describe("processSlackEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.SLACK_BOT_TOKEN_CLAUDE = "xoxb-test-token"
  })

  it("calls callWorker with systemPromptOverride and posts reply to Slack", async () => {
    ;(callWorker as ReturnType<typeof vi.fn>).mockResolvedValue({
      reply: "Here is what I found.",
      toolsUsed: [],
    })

    mockFetch.mockResolvedValue({
      json: () => Promise.resolve({ ok: true, ts: "1234567890.000200" }),
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(supabaseAdmin as any).from = vi.fn(() => makeProcessChain())

    const row = {
      id: "row-id-001",
      body: "check the email from Manuel",
      thread_id: "thread-001",
      context_json: {
        slack_channel_id: "C0BAB08DSDN",
        slack_thread_ts: "1234567890.000100",
        slack_event_ts: "1234567890.000200",
      },
    }

    const reply = await processSlackEvent(row)
    expect(reply).toBe("Here is what I found.")

    expect(callWorker).toHaveBeenCalledWith("check the email from Manuel", {
      threadId: "thread-001",
      messageId: "row-id-001",
      systemPromptOverride: SLACK_WORKER_SYSTEM_PROMPT,
      enableCodeTasks: true,
    })

    // Should have called Slack chat.postMessage
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("chat.postMessage"),
      expect.objectContaining({ method: "POST" }),
    )
  })

  it("throws when slack_channel_id is missing from context_json", async () => {
    const row = {
      id: "row-id-002",
      body: "some message",
      thread_id: null,
      context_json: { slack_event_ts: "123" }, // missing slack_channel_id
    }
    await expect(processSlackEvent(row)).rejects.toThrow("missing slack_channel_id")
  })

  it("uses slack_event_ts as fallback thread_ts when slack_thread_ts is absent", async () => {
    ;(callWorker as ReturnType<typeof vi.fn>).mockResolvedValue({
      reply: "Got it.",
      toolsUsed: ["search_crm"],
    })

    mockFetch.mockResolvedValue({
      json: () => Promise.resolve({ ok: true, ts: "1111111111.000001" }),
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(supabaseAdmin as any).from = vi.fn(() => makeProcessChain())

    const row = {
      id: "row-id-003",
      body: "any question",
      thread_id: null,
      context_json: {
        slack_channel_id: "C0BAB08DSDN",
        slack_event_ts: "1111111111.000001",
        // no slack_thread_ts
      },
    }

    await processSlackEvent(row)

    const fetchCall = mockFetch.mock.calls.find((c) =>
      String(c[0]).includes("chat.postMessage"),
    )
    expect(fetchCall).toBeDefined()
    const body = JSON.parse(fetchCall![1].body)
    // Should use event_ts as thread_ts
    expect(body.thread_ts).toBe("1111111111.000001")
  })

  it("posts the answer as a NEW message and collapses the ack to ✅ when slack_ack_ts is present", async () => {
    // The answer must be a fresh chat.postMessage (triggers a Slack push); the
    // "On it 👍" ack is then collapsed to "✅" with the Stop button removed.
    ;(callWorker as ReturnType<typeof vi.fn>).mockResolvedValue({ reply: "answer", toolsUsed: [] })
    mockFetch.mockResolvedValue({ json: () => Promise.resolve({ ok: true, ts: "9.9" }) })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(supabaseAdmin as any).from = vi.fn(() => makeProcessChain())

    const row = {
      id: "row-ack-1",
      body: "question",
      thread_id: null,
      context_json: {
        slack_channel_id: "C0BAB08DSDN",
        slack_event_ts: "1.1",
        slack_ack_ts: "9.9",
      },
    }

    await processSlackEvent(row)

    // The answer is a fresh post (NOT an edit) so Slack notifies Antonio.
    const postCall = mockFetch.mock.calls.find((c) => String(c[0]).includes("chat.postMessage"))
    expect(postCall).toBeDefined()
    expect(JSON.parse(postCall![1].body).text).toBe("answer")

    // The ack is collapsed to "✅" with the Stop button dropped (blocks: []).
    const updateCall = mockFetch.mock.calls.find((c) => String(c[0]).includes("chat.update"))
    expect(updateCall).toBeDefined()
    expect(JSON.parse(updateCall![1].body)).toEqual({ channel: "C0BAB08DSDN", ts: "9.9", text: "✅", blocks: [] })
  })

  it("falls back to morphing the ack into the answer when the fresh post fails", async () => {
    // If chat.postMessage fails, the reply must NOT be lost — the worker morphs
    // the ack into the answer (old behavior: no push, but delivered).
    ;(callWorker as ReturnType<typeof vi.fn>).mockResolvedValue({ reply: "answer", toolsUsed: [] })
    mockFetch.mockImplementation((url: string) =>
      String(url).includes("chat.postMessage")
        ? Promise.resolve({ json: () => Promise.resolve({ ok: false, error: "channel_not_found" }) })
        : Promise.resolve({ json: () => Promise.resolve({ ok: true, ts: "2.2" }) }),
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(supabaseAdmin as any).from = vi.fn(() => makeProcessChain())

    const row = {
      id: "row-ack-2",
      body: "question",
      thread_id: null,
      context_json: {
        slack_channel_id: "C0BAB08DSDN",
        slack_event_ts: "1.1",
        slack_ack_ts: "stale-ts",
      },
    }

    await processSlackEvent(row)

    // Post was attempted, then the ack was morphed into the answer (not "✅").
    expect(mockFetch.mock.calls.find((c) => String(c[0]).includes("chat.postMessage"))).toBeDefined()
    const updateCall = mockFetch.mock.calls.find((c) => String(c[0]).includes("chat.update"))
    expect(updateCall).toBeDefined()
    expect(JSON.parse(updateCall![1].body)).toEqual({ channel: "C0BAB08DSDN", ts: "stale-ts", text: "answer", blocks: [] })
  })

  it("downloads slack_images and passes them to callWorker as image blocks", async () => {
    ;(callWorker as ReturnType<typeof vi.fn>).mockResolvedValue({ reply: "answer", toolsUsed: [] })
    mockFetch.mockImplementation((url: string) =>
      String(url).includes("/api/")
        ? Promise.resolve({ json: () => Promise.resolve({ ok: true, ts: "3.3" }) })
        : Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]).buffer) }),
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(supabaseAdmin as any).from = vi.fn(() => makeProcessChain())

    const row = {
      id: "row-img-1",
      body: "(image attached — no caption)",
      thread_id: null,
      context_json: {
        slack_channel_id: "C0BAB08DSDN",
        slack_event_ts: "1.1",
        slack_images: [{ url: "https://files.slack.com/img.png", name: "img.png", mimetype: "image/png" }],
      },
    }

    await processSlackEvent(row)

    const opts = (callWorker as ReturnType<typeof vi.fn>).mock.calls[0][1]
    expect(opts.images).toBeDefined()
    expect(opts.images.length).toBe(1)
    expect(opts.images[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64") },
    })
  })

  it("retries text-only when the API rejects an image (400) and still posts a reply", async () => {
    // First call (with images) fails with an image-related 400; the worker must
    // retry WITHOUT images so Antonio still gets a text answer.
    ;(callWorker as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(
        new Error('Claude API error 400: {"type":"error","error":{"message":"messages.0.content.1.image.source: invalid base64 data"}}'),
      )
      .mockResolvedValueOnce({ reply: "text-only answer", toolsUsed: [] })
    mockFetch.mockImplementation((url: string) =>
      String(url).includes("/api/")
        ? Promise.resolve({ json: () => Promise.resolve({ ok: true, ts: "9.9" }) })
        : Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]).buffer) }),
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(supabaseAdmin as any).from = vi.fn(() => makeProcessChain())

    const row = {
      id: "row-img-400",
      body: "look at this",
      thread_id: null,
      context_json: {
        slack_channel_id: "C0BAB08DSDN",
        slack_event_ts: "1.1",
        slack_images: [{ url: "https://files.slack.com/img.png", name: "img.png", mimetype: "image/png" }],
      },
    }

    const reply = await processSlackEvent(row)

    expect(reply).toBe("text-only answer")
    // callWorker invoked twice: first WITH images, retry WITHOUT
    expect((callWorker as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2)
    expect((callWorker as ReturnType<typeof vi.fn>).mock.calls[0][1].images).toBeDefined()
    expect((callWorker as ReturnType<typeof vi.fn>).mock.calls[1][1].images).toBeUndefined()
  })

  it("does NOT retry (re-throws) on a non-image API error", async () => {
    ;(callWorker as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Claude API error 529: {"type":"error","error":{"message":"overloaded"}}'),
    )
    mockFetch.mockImplementation((url: string) =>
      String(url).includes("/api/")
        ? Promise.resolve({ json: () => Promise.resolve({ ok: true, ts: "9.9" }) })
        : Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]).buffer) }),
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(supabaseAdmin as any).from = vi.fn().mockReturnValue({ update: vi.fn().mockReturnThis(), eq: vi.fn().mockResolvedValue({ error: null }) })

    const row = {
      id: "row-529",
      body: "look at this",
      thread_id: null,
      context_json: {
        slack_channel_id: "C0BAB08DSDN",
        slack_event_ts: "1.1",
        slack_images: [{ url: "https://files.slack.com/img.png", name: "img.png", mimetype: "image/png" }],
      },
    }

    await expect(processSlackEvent(row)).rejects.toThrow("529")
    expect((callWorker as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
  })

  it("falls back to thread-history images when the current message has none (thread reply)", async () => {
    ;(callWorker as ReturnType<typeof vi.fn>).mockResolvedValue({ reply: "answer", toolsUsed: [] })
    mockFetch.mockImplementation((url: string) => {
      const u = String(url)
      if (u.includes("conversations.replies")) {
        // Thread history holds a screenshot from an earlier message
        return Promise.resolve({
          json: () =>
            Promise.resolve({
              ok: true,
              messages: [
                { files: [{ url_private: "https://files.slack.com/old.png", name: "old.png", mimetype: "image/png", size: 1234 }] },
                {}, // the @mention reply itself — no files
              ],
            }),
        })
      }
      if (u.includes("/api/") || u.includes("chat.")) {
        return Promise.resolve({ json: () => Promise.resolve({ ok: true, ts: "4.4" }) })
      }
      // image download (url_private) — valid PNG magic bytes
      return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x9, 0x8, 0x7]).buffer) })
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(supabaseAdmin as any).from = vi.fn(() => makeProcessChain())

    const row = {
      id: "row-thread-img",
      body: "read the screenshot",
      thread_id: null,
      context_json: {
        slack_channel_id: "C0BAB08DSDN",
        slack_thread_ts: "100.000", // in a thread
        slack_event_ts: "200.000",
        slack_images: [], // current message carried none
      },
    }

    await processSlackEvent(row)

    // conversations.replies must have been queried for the thread root ts
    const repliesCall = mockFetch.mock.calls.find((c) => String(c[0]).includes("conversations.replies"))
    expect(repliesCall).toBeDefined()
    expect(String(repliesCall![0])).toContain("ts=100.000")

    // and the harvested image reached callWorker as a base64 block
    const opts = (callWorker as ReturnType<typeof vi.fn>).mock.calls[0][1]
    expect(opts.images).toBeDefined()
    expect(opts.images.length).toBe(1)
    expect(opts.images[0].source.data).toBe(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x9, 0x8, 0x7]).toString("base64"))
  })

  it("does NOT fetch thread history when the message is not in a thread", async () => {
    ;(callWorker as ReturnType<typeof vi.fn>).mockResolvedValue({ reply: "answer", toolsUsed: [] })
    mockFetch.mockResolvedValue({ json: () => Promise.resolve({ ok: true, ts: "5.5" }) })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(supabaseAdmin as any).from = vi.fn(() => makeProcessChain())

    const row = {
      id: "row-no-thread",
      body: "just a channel-level mention",
      thread_id: null,
      context_json: {
        slack_channel_id: "C0BAB08DSDN",
        slack_event_ts: "300.000",
        // no slack_thread_ts → not in a thread
        slack_images: [],
      },
    }

    await processSlackEvent(row)

    expect(mockFetch.mock.calls.find((c) => String(c[0]).includes("conversations.replies"))).toBeUndefined()
    const opts = (callWorker as ReturnType<typeof vi.fn>).mock.calls[0][1]
    expect(opts.images).toBeUndefined()
  })
})

// -------------------------------------------------------------------------
// updateSlackMessage
// -------------------------------------------------------------------------

describe("updateSlackMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.SLACK_BOT_TOKEN_CLAUDE = "xoxb-test-token"
  })

  it("calls chat.update with channel/ts/text and returns true on ok", async () => {
    mockFetch.mockResolvedValue({ json: () => Promise.resolve({ ok: true, ts: "1.1" }) })
    const ok = await updateSlackMessage("C123", "123.456", "the answer")
    expect(ok).toBe(true)
    const call = mockFetch.mock.calls.find((c) => String(c[0]).includes("chat.update"))
    expect(call).toBeDefined()
    expect(JSON.parse(call![1].body)).toEqual({ channel: "C123", ts: "123.456", text: "the answer" })
  })

  it("returns false when chat.update fails", async () => {
    mockFetch.mockResolvedValue({ json: () => Promise.resolve({ ok: false, error: "message_not_found" }) })
    const ok = await updateSlackMessage("C123", "123.456", "the answer")
    expect(ok).toBe(false)
  })
})

// -------------------------------------------------------------------------
// prepareSlackImages
// -------------------------------------------------------------------------

describe("prepareSlackImages", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.SLACK_BOT_TOKEN_CLAUDE = "xoxb-test-token"
  })

  it("downloads a supported image and returns a base64 block", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 10, 20, 30]).buffer),
    })
    const blocks = await prepareSlackImages([
      { url: "https://files.slack.com/a.png", name: "a.png", mimetype: "image/png" },
    ])
    expect(blocks).toEqual([
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 10, 20, 30]).toString("base64") },
      },
    ])
  })

  it("skips a download whose body is not a valid image (HTML login page)", async () => {
    // url_private returns an HTML login page (not an error status) when the bot
    // lacks files:read — the magic-byte guard must skip it, not base64 garbage.
    const html = Buffer.from("<!DOCTYPE html><html><body>Sign in</body></html>", "utf8")
    mockFetch.mockResolvedValue({ ok: true, arrayBuffer: () => Promise.resolve(html.buffer.slice(html.byteOffset, html.byteOffset + html.byteLength)) })
    const blocks = await prepareSlackImages([
      { url: "https://files.slack.com/login.png", name: "login.png", mimetype: "image/png" },
    ])
    expect(blocks).toEqual([])
  })

  it("skips unsupported media types without downloading", async () => {
    const blocks = await prepareSlackImages([
      { url: "https://files.slack.com/a.heic", name: "a.heic", mimetype: "image/heic" },
    ])
    expect(blocks).toEqual([])
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("skips an image whose downloaded body exceeds the 5MB cap", async () => {
    const tooBig = new Uint8Array(5 * 1024 * 1024 + 1)
    // Valid PNG magic so it passes the image-validity guard and is rejected by the size cap (the path under test)
    tooBig[0] = 0x89
    tooBig[1] = 0x50
    mockFetch.mockResolvedValue({ ok: true, arrayBuffer: () => Promise.resolve(tooBig.buffer) })
    const blocks = await prepareSlackImages([
      { url: "https://files.slack.com/big.png", name: "big.png", mimetype: "image/png" },
    ])
    expect(blocks).toEqual([])
  })

  it("skips an image when the download responds non-ok", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 401 })
    const blocks = await prepareSlackImages([
      { url: "https://files.slack.com/x.png", name: "x.png", mimetype: "image/png" },
    ])
    expect(blocks).toEqual([])
  })

  it("returns [] (and does not fetch) when the bot token is missing", async () => {
    delete process.env.SLACK_BOT_TOKEN_CLAUDE
    const blocks = await prepareSlackImages([
      { url: "https://files.slack.com/x.png", name: "x.png", mimetype: "image/png" },
    ])
    expect(blocks).toEqual([])
    expect(mockFetch).not.toHaveBeenCalled()
  })
})

// -------------------------------------------------------------------------
// fetchThreadImages
// -------------------------------------------------------------------------

describe("fetchThreadImages", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.SLACK_BOT_TOKEN_CLAUDE = "xoxb-test-token"
  })

  it("returns supported images found across thread messages", async () => {
    mockFetch.mockResolvedValue({
      json: () =>
        Promise.resolve({
          ok: true,
          messages: [
            { files: [{ url_private: "https://files.slack.com/a.png", name: "a.png", mimetype: "image/png", size: 1000 }] },
            { text: "no files here" },
            { files: [{ url_private: "https://files.slack.com/b.jpg", name: "b.jpg", mimetype: "image/jpeg", size: 2000 }] },
          ],
        }),
    })
    const imgs = await fetchThreadImages("C123", "100.000")
    expect(imgs).toEqual([
      { url: "https://files.slack.com/a.png", name: "a.png", mimetype: "image/png" },
      { url: "https://files.slack.com/b.jpg", name: "b.jpg", mimetype: "image/jpeg" },
    ])
    // calls conversations.replies with the thread root ts
    expect(String(mockFetch.mock.calls[0][0])).toContain("conversations.replies")
    expect(String(mockFetch.mock.calls[0][0])).toContain("channel=C123")
    expect(String(mockFetch.mock.calls[0][0])).toContain("ts=100.000")
  })

  it("skips unsupported types and oversize files", async () => {
    mockFetch.mockResolvedValue({
      json: () =>
        Promise.resolve({
          ok: true,
          messages: [
            { files: [{ url_private: "u1", name: "heic", mimetype: "image/heic", size: 1000 }] }, // unsupported
            { files: [{ url_private: "u2", name: "big", mimetype: "image/png", size: 5 * 1024 * 1024 + 1 }] }, // oversize
            { files: [{ url_private: "u3", name: "ok", mimetype: "image/png", size: 500 }] }, // keep
          ],
        }),
    })
    const imgs = await fetchThreadImages("C123", "100.000")
    expect(imgs).toEqual([{ url: "u3", name: "ok", mimetype: "image/png" }])
  })

  it("returns [] when the Slack API responds not-ok (e.g. missing scope)", async () => {
    mockFetch.mockResolvedValue({
      json: () => Promise.resolve({ ok: false, error: "missing_scope" }),
    })
    const imgs = await fetchThreadImages("C123", "100.000")
    expect(imgs).toEqual([])
  })

  it("returns [] (and does not fetch) when the bot token is missing", async () => {
    delete process.env.SLACK_BOT_TOKEN_CLAUDE
    const imgs = await fetchThreadImages("C123", "100.000")
    expect(imgs).toEqual([])
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("returns [] when fetch throws", async () => {
    mockFetch.mockRejectedValue(new Error("network down"))
    const imgs = await fetchThreadImages("C123", "100.000")
    expect(imgs).toEqual([])
  })
})

// -------------------------------------------------------------------------
// fetchThreadHistory
// -------------------------------------------------------------------------

describe("fetchThreadHistory", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.SLACK_BOT_TOKEN_CLAUDE = "xoxb-test-token"
  })

  it("formats who-said-what, labels Antonio/Hermes, and skips Claude's own messages", async () => {
    mockFetch.mockResolvedValue({
      json: () =>
        Promise.resolve({
          ok: true,
          messages: [
            { user: "U0BAALR4Y4Q", text: "look at this invoice" }, // Antonio
            { user: "U0B9D3MAD9B", text: "I found the duplicate" }, // Hermes
            { user: "U0B9S675WTT", text: "On it 👍" }, // Claude — must be skipped
          ],
        }),
    })
    const out = await fetchThreadHistory("C123", "100.000")
    expect(out).toBe("Antonio: look at this invoice\nHermes: I found the duplicate")
    // queries conversations.replies with channel + thread root ts + limit
    const url = String(mockFetch.mock.calls[0][0])
    expect(url).toContain("conversations.replies")
    expect(url).toContain("channel=C123")
    expect(url).toContain("ts=100.000")
  })

  it("rewrites <@ID> mention tokens to readable @names", async () => {
    mockFetch.mockResolvedValue({
      json: () =>
        Promise.resolve({
          ok: true,
          messages: [
            { user: "U0BAALR4Y4Q", text: "<@U0B9S675WTT> and <@U0B9D3MAD9B> please check" },
          ],
        }),
    })
    const out = await fetchThreadHistory("C123", "100.000")
    expect(out).toBe("Antonio: @Claude and @Hermes please check")
  })

  it("includes a file note for messages that carry files but no text", async () => {
    mockFetch.mockResolvedValue({
      json: () =>
        Promise.resolve({
          ok: true,
          messages: [
            { user: "U0BAALR4Y4Q", files: [{ name: "shot.png" }] },
          ],
        }),
    })
    const out = await fetchThreadHistory("C123", "100.000")
    expect(out).toBe("Antonio:  [+1 file(s)]")
  })

  it("labels unknown senders as 'Bot' (bot_id present) or 'Someone'", async () => {
    mockFetch.mockResolvedValue({
      json: () =>
        Promise.resolve({
          ok: true,
          messages: [
            { bot_id: "B999", text: "automated note" },
            { user: "UUNKNOWN", text: "hello" },
          ],
        }),
    })
    const out = await fetchThreadHistory("C123", "100.000")
    expect(out).toBe("Bot: automated note\nSomeone: hello")
  })

  it("returns '' when the Slack API responds not-ok (e.g. missing scope)", async () => {
    mockFetch.mockResolvedValue({ json: () => Promise.resolve({ ok: false, error: "missing_scope" }) })
    const out = await fetchThreadHistory("C123", "100.000")
    expect(out).toBe("")
  })

  it("returns '' when there are no usable lines", async () => {
    mockFetch.mockResolvedValue({
      json: () => Promise.resolve({ ok: true, messages: [{ user: "U0B9S675WTT", text: "only me" }] }),
    })
    const out = await fetchThreadHistory("C123", "100.000")
    expect(out).toBe("")
  })

  it("returns '' (and does not fetch) when the bot token is missing", async () => {
    delete process.env.SLACK_BOT_TOKEN_CLAUDE
    const out = await fetchThreadHistory("C123", "100.000")
    expect(out).toBe("")
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("returns '' when fetch throws", async () => {
    mockFetch.mockRejectedValue(new Error("network down"))
    const out = await fetchThreadHistory("C123", "100.000")
    expect(out).toBe("")
  })
})

// -------------------------------------------------------------------------
// processSlackEvent — shared-thread context injection
// -------------------------------------------------------------------------

describe("processSlackEvent shared-thread context", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.SLACK_BOT_TOKEN_CLAUDE = "xoxb-test-token"
  })

  it("prepends Slack thread history to the worker body for a thread reply", async () => {
    ;(callWorker as ReturnType<typeof vi.fn>).mockResolvedValue({ reply: "ok", toolsUsed: [] })
    mockFetch.mockImplementation((url: string) => {
      const u = String(url)
      if (u.includes("conversations.replies")) {
        return Promise.resolve({
          json: () =>
            Promise.resolve({
              ok: true,
              messages: [
                { user: "U0BAALR4Y4Q", text: "check this" },
                { user: "U0B9D3MAD9B", text: "Hermes found the answer" },
              ],
            }),
        })
      }
      // chat.postMessage / chat.update / cron trigger
      return Promise.resolve({ json: () => Promise.resolve({ ok: true, ts: "9.9" }) })
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(supabaseAdmin as any).from = vi.fn(() => makeProcessChain())

    const row = {
      id: "row-shared-1",
      body: "do what Hermes said",
      thread_id: "thread-x",
      context_json: {
        slack_channel_id: "C0BAB08DSDN",
        slack_thread_ts: "100.000",
        slack_event_ts: "200.000",
        slack_images: [],
      },
    }

    await processSlackEvent(row)

    const sentBody = (callWorker as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(sentBody).toContain("[SLACK THREAD CONTEXT")
    expect(sentBody).toContain("Hermes: Hermes found the answer")
    expect(sentBody).toContain("[YOUR CURRENT MESSAGE]")
    expect(sentBody).toContain("do what Hermes said")
  })

  it("uses the raw body (no context block) when the message is not in a thread", async () => {
    ;(callWorker as ReturnType<typeof vi.fn>).mockResolvedValue({ reply: "ok", toolsUsed: [] })
    mockFetch.mockResolvedValue({ json: () => Promise.resolve({ ok: true, ts: "9.9" }) })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(supabaseAdmin as any).from = vi.fn(() => makeProcessChain())

    const row = {
      id: "row-shared-2",
      body: "channel-level mention",
      thread_id: null,
      context_json: {
        slack_channel_id: "C0BAB08DSDN",
        slack_event_ts: "300.000", // no slack_thread_ts → not in a thread
        slack_images: [],
      },
    }

    await processSlackEvent(row)

    const sentBody = (callWorker as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(sentBody).toBe("channel-level mention")
    // No thread → no conversations.replies call
    expect(mockFetch.mock.calls.find((c) => String(c[0]).includes("conversations.replies"))).toBeUndefined()
  })

  // ── Stop button: cancellation honored before posting ──────────────────────
  it("does NOT post the answer or mark done when the row was cancelled mid-flight", async () => {
    ;(callWorker as ReturnType<typeof vi.fn>).mockResolvedValue({ reply: "the answer", toolsUsed: [] })
    mockFetch.mockResolvedValue({ json: () => Promise.resolve({ ok: true, ts: "9.9" }) })

    // Live status reads back 'cancelled' (Stop was clicked while callWorker ran).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(supabaseAdmin as any).from = vi.fn(() => makeProcessChain({ status: "cancelled" }))

    const row = {
      id: "row-cancelled",
      body: "do the thing",
      thread_id: null,
      context_json: {
        slack_channel_id: "C0BAB08DSDN",
        slack_event_ts: "1.1",
        slack_ack_ts: "9.9",
      },
    }

    const reply = await processSlackEvent(row)
    expect(reply).toBe("the answer") // still returned to the cron (marks row, not re-posted)

    // No answer posted: neither a chat.update morph nor a fresh chat.postMessage.
    expect(mockFetch.mock.calls.find((c) => String(c[0]).includes("chat.update"))).toBeUndefined()
    expect(mockFetch.mock.calls.find((c) => String(c[0]).includes("chat.postMessage"))).toBeUndefined()
  })
})

// -------------------------------------------------------------------------
// buildThinkingBlocks
// -------------------------------------------------------------------------

describe("buildThinkingBlocks", () => {
  it("renders the ack text as a section and a danger Stop button", () => {
    const blocks = buildThinkingBlocks("On it 👍")
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toEqual({ type: "section", text: { type: "mrkdwn", text: "On it 👍" } })

    const actions = blocks[1] as { type: string; elements: Array<Record<string, unknown>> }
    expect(actions.type).toBe("actions")
    const button = actions.elements[0]
    expect(button.action_id).toBe(STOP_THINKING_ACTION_ID)
    expect(button.style).toBe("danger")
    expect((button.text as { text: string }).text).toContain("Stop")
  })
})

// -------------------------------------------------------------------------
// verifySlackSignature
// -------------------------------------------------------------------------

describe("verifySlackSignature", () => {
  const secret = "test-signing-secret"
  const body = "payload=%7B%22type%22%3A%22block_actions%22%7D"
  const now = 1_700_000_000_000 // fixed clock
  const ts = String(Math.floor(now / 1000))

  function sign(rawBody: string, timestamp: string): string {
    return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`
  }

  it("accepts a correctly signed, fresh request", () => {
    expect(verifySlackSignature(body, ts, sign(body, ts), secret, now)).toBe(true)
  })

  it("rejects a tampered body", () => {
    expect(verifySlackSignature(body + "x", ts, sign(body, ts), secret, now)).toBe(false)
  })

  it("rejects a stale timestamp (replay > 5 min)", () => {
    const oldTs = String(Math.floor(now / 1000) - 600)
    expect(verifySlackSignature(body, oldTs, sign(body, oldTs), secret, now)).toBe(false)
  })

  it("rejects when the secret is missing", () => {
    expect(verifySlackSignature(body, ts, sign(body, ts), undefined, now)).toBe(false)
  })

  it("rejects an empty or non-numeric timestamp", () => {
    expect(verifySlackSignature(body, "", sign(body, ts), secret, now)).toBe(false)
    expect(verifySlackSignature(body, "abc", sign(body, ts), secret, now)).toBe(false)
  })
})

// -------------------------------------------------------------------------
// parseSlackInteraction
// -------------------------------------------------------------------------

describe("parseSlackInteraction", () => {
  function encode(payload: unknown): string {
    return `payload=${encodeURIComponent(JSON.stringify(payload))}`
  }

  it("extracts action_id, message ts, and channel id from a block_actions payload", () => {
    const raw = encode({
      type: "block_actions",
      actions: [{ action_id: "stop_thinking", value: "stop_thinking" }],
      message: { ts: "1234567890.000300" },
      channel: { id: "C0BAB08DSDN" },
    })
    expect(parseSlackInteraction(raw)).toEqual({
      actionId: "stop_thinking",
      messageTs: "1234567890.000300",
      channelId: "C0BAB08DSDN",
    })
  })

  it("falls back to container fields when message/channel are absent", () => {
    const raw = encode({
      type: "block_actions",
      actions: [{ action_id: "stop_thinking" }],
      container: { type: "message", message_ts: "999.111", channel_id: "C999" },
    })
    expect(parseSlackInteraction(raw)).toEqual({
      actionId: "stop_thinking",
      messageTs: "999.111",
      channelId: "C999",
    })
  })

  it("returns null when there is no payload field", () => {
    expect(parseSlackInteraction("foo=bar")).toBeNull()
  })

  it("returns null on malformed JSON", () => {
    expect(parseSlackInteraction("payload=%7Bnot-json")).toBeNull()
  })

  it("returns null when there are no actions", () => {
    expect(parseSlackInteraction(encode({ type: "block_actions", actions: [] }))).toBeNull()
  })
})
