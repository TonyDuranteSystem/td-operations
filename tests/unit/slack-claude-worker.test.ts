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
} from "@/lib/ai-agent/slack-claude"
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

  it("is shorter than the Hermes research prompt (conversational bias)", () => {
    // The Slack prompt should stay concise — if it grows > 2000 chars it's too long
    expect(SLACK_WORKER_SYSTEM_PROMPT.length).toBeLessThan(2000)
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

    const updateChain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ error: null }),
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(supabaseAdmin as any).from = vi.fn().mockReturnValue(updateChain)

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

    const updateChain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ error: null }),
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(supabaseAdmin as any).from = vi.fn().mockReturnValue(updateChain)

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
})
