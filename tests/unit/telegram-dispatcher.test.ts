/**
 * Tests for lib/messaging/telegram-dispatcher.ts — dispatchTelegramMessage.
 *
 * Covers: missing token → clear error (never a silent send attempt), a
 * successful send records the outbound copy, Telegram's own rejection
 * (ok:false / non-2xx) surfaces its `description` verbatim, and a failed
 * DB save after a successful send still reports success (the message really
 * did go out — only our own copy of it would be missing).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const messagesInsert = vi.fn().mockResolvedValue({ data: null, error: null })
const groupsUpdateEq = vi.fn().mockResolvedValue({ data: null, error: null })

vi.mock("@/lib/supabase-admin", () => {
  const from = vi.fn((table: string) => {
    if (table === "messages") return { insert: messagesInsert }
    if (table === "messaging_groups") return { update: () => ({ eq: groupsUpdateEq }) }
    throw new Error(`unexpected table ${table}`)
  })
  return { supabaseAdmin: { from } }
})

import { dispatchTelegramMessage } from "@/lib/messaging/telegram-dispatcher"

const baseParams = { chatId: "-5366287225", message: "hi", channelId: "uuid-1", groupId: "group-1" }
const originalFetch = global.fetch
const originalToken = process.env.TELEGRAM_CLIENT_BOT_TOKEN

beforeEach(() => {
  vi.clearAllMocks()
  messagesInsert.mockResolvedValue({ data: null, error: null })
  groupsUpdateEq.mockResolvedValue({ data: null, error: null })
})

afterEach(() => {
  global.fetch = originalFetch
  process.env.TELEGRAM_CLIENT_BOT_TOKEN = originalToken
})

describe("dispatchTelegramMessage", () => {
  it("errors clearly when TELEGRAM_CLIENT_BOT_TOKEN is not set — never the Hermes bot's token", async () => {
    delete process.env.TELEGRAM_CLIENT_BOT_TOKEN
    const result = await dispatchTelegramMessage(baseParams)
    expect(result.ok).toBe(false)
    expect((result as { ok: false; error: string }).error).toContain("TELEGRAM_CLIENT_BOT_TOKEN")
  })

  it("sends via the Telegram Bot API using the chat_id and message text verbatim", async () => {
    process.env.TELEGRAM_CLIENT_BOT_TOKEN = "test-token"
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 42 } }),
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const result = await dispatchTelegramMessage(baseParams)

    expect(result.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/bottest-token/sendMessage",
      expect.objectContaining({ method: "POST" })
    )
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body).toEqual({ chat_id: "-5366287225", text: "hi" })
  })

  it("surfaces Telegram's own rejection description verbatim (e.g. chat not found)", async () => {
    process.env.TELEGRAM_CLIENT_BOT_TOKEN = "test-token"
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ ok: false, description: "Bad Request: chat not found" }),
    }) as unknown as typeof fetch

    const result = await dispatchTelegramMessage(baseParams)
    expect(result.ok).toBe(false)
    expect((result as { ok: false; error: string }).error).toBe("Bad Request: chat not found")
  })

  it("treats a 200 response with ok:false as a failure, not a silent success", async () => {
    process.env.TELEGRAM_CLIENT_BOT_TOKEN = "test-token"
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: false, description: "Forbidden: bot was blocked by the user" }),
    }) as unknown as typeof fetch

    const result = await dispatchTelegramMessage(baseParams)
    expect(result.ok).toBe(false)
  })

  it("records the outbound message and bumps last_message_at after a successful send", async () => {
    process.env.TELEGRAM_CLIENT_BOT_TOKEN = "test-token"
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: {} }),
    }) as unknown as typeof fetch

    const result = await dispatchTelegramMessage(baseParams)

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
    process.env.TELEGRAM_CLIENT_BOT_TOKEN = "test-token"
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: {} }),
    }) as unknown as typeof fetch
    messagesInsert.mockResolvedValue({ data: null, error: { message: "db down" } })

    const result = await dispatchTelegramMessage(baseParams)
    expect(result.ok).toBe(true)
  })

  it("does not attempt to record a message when the send fails", async () => {
    process.env.TELEGRAM_CLIENT_BOT_TOKEN = "test-token"
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ ok: false, description: "chat not found" }),
    }) as unknown as typeof fetch

    await dispatchTelegramMessage(baseParams)
    expect(messagesInsert).not.toHaveBeenCalled()
  })
})
