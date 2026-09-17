/**
 * Tests for lib/messaging/send-dispatcher.ts
 *
 * Verifies the provider routing logic without hitting any external service:
 *   - channel not found → error
 *   - provider = NULL → "not configured" error
 *   - unknown provider → "unknown" error
 *   - known provider (meta/twilio) → handler stub error ("not yet implemented")
 *   - twochat → real send + the outbound message gets recorded on success
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const channelSingle = vi.fn()
const messagesInsert = vi.fn().mockResolvedValue({ data: null, error: null })
const groupsUpdateEq = vi.fn().mockResolvedValue({ data: null, error: null })

// Must be hoisted before any import that touches supabase-admin
vi.mock("@/lib/supabase-admin", () => {
  const from = vi.fn((table: string) => {
    if (table === "messaging_channels") {
      return { select: () => ({ eq: () => ({ single: channelSingle }) }) }
    }
    if (table === "messages") {
      return { insert: messagesInsert }
    }
    if (table === "messaging_groups") {
      return { update: () => ({ eq: groupsUpdateEq }) }
    }
    throw new Error(`unexpected table ${table}`)
  })
  return { supabaseAdmin: { from } }
})

import { dispatchWhatsAppMessage } from "@/lib/messaging/send-dispatcher"

function mockChannel(provider: string | null, dbError = false) {
  channelSingle.mockResolvedValue(
    dbError
      ? { data: null, error: { message: "Not found" } }
      : { data: { provider }, error: null }
  )
}

const baseParams = { chatId: "123@c.us", message: "hi", channelId: "uuid-1", groupId: "group-1" }

beforeEach(() => {
  vi.clearAllMocks()
  messagesInsert.mockResolvedValue({ data: null, error: null })
  groupsUpdateEq.mockResolvedValue({ data: null, error: null })
})

describe("dispatchWhatsAppMessage", () => {
  it("returns error when channel not found in DB", async () => {
    mockChannel(null, /* dbError */ true)
    const result = await dispatchWhatsAppMessage(baseParams)
    expect(result.ok).toBe(false)
    expect((result as { ok: false; error: string }).error).toContain("not found")
  })

  it("returns 'not configured' error when provider is null", async () => {
    mockChannel(null)
    const result = await dispatchWhatsAppMessage(baseParams)
    expect(result.ok).toBe(false)
    expect((result as { ok: false; error: string }).error).toContain("not configured")
  })

  it("returns 'unknown provider' error for an unrecognised provider", async () => {
    mockChannel("periskope")
    const result = await dispatchWhatsAppMessage(baseParams)
    expect(result.ok).toBe(false)
    expect((result as { ok: false; error: string }).error).toContain("Unknown WhatsApp provider")
    expect((result as { ok: false; error: string }).error).toContain("periskope")
  })

  it("routes to meta stub and surfaces its 'not yet implemented' error", async () => {
    mockChannel("meta")
    const result = await dispatchWhatsAppMessage(baseParams)
    expect(result.ok).toBe(false)
    expect((result as { ok: false; error: string }).error).toContain("not yet implemented")
  })

  it("routes to twilio stub and surfaces its 'not yet implemented' error", async () => {
    mockChannel("twilio")
    const result = await dispatchWhatsAppMessage(baseParams)
    expect(result.ok).toBe(false)
    expect((result as { ok: false; error: string }).error).toContain("not yet implemented")
  })

  it("does not attempt to record a message when the send fails", async () => {
    mockChannel("meta")
    await dispatchWhatsAppMessage(baseParams)
    expect(messagesInsert).not.toHaveBeenCalled()
  })
})

describe("dispatchWhatsAppMessage — twochat provider", () => {
  const originalFetch = global.fetch
  const originalKey = process.env.TWOCHAT_API_KEY

  afterEach(() => {
    global.fetch = originalFetch
    process.env.TWOCHAT_API_KEY = originalKey
  })

  // twochat's own handler re-queries messaging_channels for phone_number, so
  // the mock must answer both the dispatcher's `provider` lookup and the
  // handler's `phone_number` lookup with the one row shape.
  function mockTwoChatChannel() {
    channelSingle.mockResolvedValue({
      data: { provider: "twochat", phone_number: "+17274521093" },
      error: null,
    })
  }

  it("errors clearly when TWOCHAT_API_KEY is not set", async () => {
    mockTwoChatChannel()
    delete process.env.TWOCHAT_API_KEY
    const result = await dispatchWhatsAppMessage({ ...baseParams, chatId: "17274521093@c.us" })
    expect(result.ok).toBe(false)
    expect((result as { ok: false; error: string }).error).toContain("TWOCHAT_API_KEY")
  })

  it("sends via 2Chat's API with the JID converted to E.164 on both sides", async () => {
    mockTwoChatChannel()
    process.env.TWOCHAT_API_KEY = "test-key"
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, message_uuid: "MSG1", batched: true }),
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const result = await dispatchWhatsAppMessage({ ...baseParams, chatId: "17274521093@c.us" })

    expect(result.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.p.2chat.io/open/whatsapp/send-message",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-User-API-Key": "test-key" }),
      })
    )
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body).toEqual({
      from_number: "+17274521093",
      to_number: "+17274521093",
      text: "hi",
    })
  })

  it("includes the media URL in the 2Chat request when one is given", async () => {
    mockTwoChatChannel()
    process.env.TWOCHAT_API_KEY = "test-key"
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true }),
    })
    global.fetch = fetchMock as unknown as typeof fetch

    await dispatchWhatsAppMessage({
      ...baseParams,
      chatId: "17274521093@c.us",
      mediaUrl: "https://example.com/file.jpg",
    })

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.url).toBe("https://example.com/file.jpg")
  })

  it("surfaces a clear error when 2Chat's API rejects the request", async () => {
    mockTwoChatChannel()
    process.env.TWOCHAT_API_KEY = "test-key"
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: "Invalid API key" }),
    }) as unknown as typeof fetch

    const result = await dispatchWhatsAppMessage({ ...baseParams, chatId: "17274521093@c.us" })
    expect(result.ok).toBe(false)
    expect((result as { ok: false; error: string }).error).toContain("401")
  })

  it("treats a 200 response with success:false as a failure, not a silent success", async () => {
    mockTwoChatChannel()
    process.env.TWOCHAT_API_KEY = "test-key"
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: false }),
    }) as unknown as typeof fetch

    const result = await dispatchWhatsAppMessage({ ...baseParams, chatId: "17274521093@c.us" })
    expect(result.ok).toBe(false)
  })

  it("records the outbound message and bumps last_message_at after a successful send", async () => {
    mockTwoChatChannel()
    process.env.TWOCHAT_API_KEY = "test-key"
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true }),
    }) as unknown as typeof fetch

    const result = await dispatchWhatsAppMessage({ ...baseParams, chatId: "17274521093@c.us" })

    expect(result.ok).toBe(true)
    expect(messagesInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        group_id: "group-1",
        channel_id: "uuid-1",
        direction: "outbound",
        content_text: "hi",
        content_type: "text",
      })
    )
    expect(groupsUpdateEq).toHaveBeenCalledWith("id", "group-1")
  })

  it("still reports success even if saving the outbound copy fails", async () => {
    mockTwoChatChannel()
    process.env.TWOCHAT_API_KEY = "test-key"
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true }),
    }) as unknown as typeof fetch
    messagesInsert.mockResolvedValue({ data: null, error: { message: "db down" } })

    const result = await dispatchWhatsAppMessage({ ...baseParams, chatId: "17274521093@c.us" })
    expect(result.ok).toBe(true)
  })
})
