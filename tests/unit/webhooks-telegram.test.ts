/**
 * Tests for app/api/webhooks/telegram/[channelId]/route.ts
 *
 * Covers: fail-closed auth via Telegram's own `X-Telegram-Bot-Api-Secret-Token`
 * header (not a URL param, unlike the 2Chat webhook — Telegram supports a
 * proper secret header natively via setWebhook's secret_token), non-text
 * updates acknowledged but not stored, inbound text ingestion, and
 * webhook-retry dedup via the unique-constraint path.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const channelSingle = vi.fn()
const messagesInsert = vi.fn()
const groupsSelectSingle = vi.fn()
const groupsUpdate = vi.fn()
const groupsUpdatePayload = vi.fn()

vi.mock("@/lib/supabase-admin", () => {
  const from = vi.fn((table: string) => {
    if (table === "messaging_channels") {
      return { select: () => ({ eq: () => ({ single: channelSingle }) }) }
    }
    if (table === "messages") {
      return { insert: messagesInsert }
    }
    if (table === "messaging_groups") {
      return {
        select: () => ({ eq: () => ({ single: groupsSelectSingle }) }),
        update: (payload: unknown) => {
          groupsUpdatePayload(payload)
          return { eq: groupsUpdate }
        },
      }
    }
    throw new Error(`unexpected table ${table}`)
  })
  return { supabaseAdmin: { from } }
})

const findOrCreateTelegramGroup = vi.fn()
vi.mock("@/lib/messaging/telegram-groups", () => ({
  findOrCreateTelegramGroup: (...args: unknown[]) => findOrCreateTelegramGroup(...args),
}))

import { POST } from "@/app/api/webhooks/telegram/[channelId]/route"

function makeRequest(body: unknown, secretHeader: string | null) {
  const headers = new Headers()
  if (secretHeader !== null) headers.set("x-telegram-bot-api-secret-token", secretHeader)
  return new NextRequest("http://localhost/api/webhooks/telegram/ch1", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  groupsSelectSingle.mockResolvedValue({ data: { unread_count: 0 }, error: null })
  groupsUpdate.mockResolvedValue({ data: null, error: null })
})

describe("POST /api/webhooks/telegram/[channelId]", () => {
  it("rejects a request with no secret configured on the channel (fail closed)", async () => {
    channelSingle.mockResolvedValue({ data: { id: "ch1", webhook_secret: null }, error: null })
    const res = await POST(makeRequest({}, "anything"), { params: { channelId: "ch1" } })
    expect(res.status).toBe(401)
  })

  it("rejects a request with the wrong secret header", async () => {
    channelSingle.mockResolvedValue({ data: { id: "ch1", webhook_secret: "real-secret" }, error: null })
    const res = await POST(makeRequest({}, "wrong"), { params: { channelId: "ch1" } })
    expect(res.status).toBe(401)
  })

  it("rejects a request with no secret header at all", async () => {
    channelSingle.mockResolvedValue({ data: { id: "ch1", webhook_secret: "real-secret" }, error: null })
    const res = await POST(makeRequest({}, null), { params: { channelId: "ch1" } })
    expect(res.status).toBe(401)
  })

  it("rejects an unknown channel id", async () => {
    channelSingle.mockResolvedValue({ data: null, error: { message: "not found" } })
    const res = await POST(makeRequest({}, "s"), { params: { channelId: "missing" } })
    expect(res.status).toBe(404)
  })

  it("acknowledges a non-message update (e.g. edited_message) without storing anything", async () => {
    channelSingle.mockResolvedValue({ data: { id: "ch1", webhook_secret: "s" }, error: null })
    const res = await POST(
      makeRequest({ update_id: 1, edited_message: { text: "oops" } }, "s"),
      { params: { channelId: "ch1" } }
    )
    expect(res.status).toBe(200)
    expect(findOrCreateTelegramGroup).not.toHaveBeenCalled()
  })

  it("acknowledges a non-text message (e.g. a sticker) without storing anything", async () => {
    channelSingle.mockResolvedValue({ data: { id: "ch1", webhook_secret: "s" }, error: null })
    const res = await POST(
      makeRequest({ update_id: 1, message: { message_id: 1, date: 1, chat: { id: 1, type: "private" } } }, "s"),
      { params: { channelId: "ch1" } }
    )
    expect(res.status).toBe(200)
    expect(findOrCreateTelegramGroup).not.toHaveBeenCalled()
  })

  it("inserts a genuinely new inbound message and increments the group's unread count", async () => {
    channelSingle.mockResolvedValue({ data: { id: "ch1", webhook_secret: "s" }, error: null })
    findOrCreateTelegramGroup.mockResolvedValue({ group: { id: "g1", channel_id: "ch1", external_group_id: "-5366287225", group_name: "Daniel X" } })
    messagesInsert.mockResolvedValue({ data: null, error: null })
    groupsSelectSingle.mockResolvedValue({ data: { unread_count: 3 }, error: null })

    const res = await POST(
      makeRequest(
        {
          update_id: 1,
          message: {
            message_id: 42,
            date: 1,
            text: "Hey guys",
            chat: { id: -5366287225, type: "group", title: "Daniel X" },
            from: { id: 999, first_name: "Daniel" },
          },
        },
        "s"
      ),
      { params: { channelId: "ch1" } }
    )

    expect(res.status).toBe(200)
    expect(findOrCreateTelegramGroup).toHaveBeenCalledWith({
      channelId: "ch1",
      chatId: "-5366287225",
      groupName: "Daniel X",
    })
    expect(messagesInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        group_id: "g1",
        channel_id: "ch1",
        external_message_id: "-5366287225:42",
        direction: "inbound",
        sender_name: "Daniel",
        content_text: "Hey guys",
        content_type: "text",
        status: "new",
      })
    )
    expect(groupsUpdatePayload).toHaveBeenCalledWith(
      expect.objectContaining({ is_active: true, unread_count: 4 })
    )
  })

  it("falls back to the sender's username when no first_name or chat title is present", async () => {
    channelSingle.mockResolvedValue({ data: { id: "ch1", webhook_secret: "s" }, error: null })
    findOrCreateTelegramGroup.mockResolvedValue({ group: { id: "g1", channel_id: "ch1", external_group_id: "7064869750", group_name: null } })
    messagesInsert.mockResolvedValue({ data: null, error: null })

    await POST(
      makeRequest(
        {
          update_id: 1,
          message: {
            message_id: 1,
            date: 1,
            text: "hi",
            chat: { id: 7064869750, type: "private" },
            from: { id: 1, username: "midnight_pearl" },
          },
        },
        "s"
      ),
      { params: { channelId: "ch1" } }
    )

    expect(findOrCreateTelegramGroup).toHaveBeenCalledWith({
      channelId: "ch1",
      chatId: "7064869750",
      groupName: "@midnight_pearl",
    })
  })

  it("treats a redelivered webhook (unique-constraint hit) as a successful dedup, not an error", async () => {
    channelSingle.mockResolvedValue({ data: { id: "ch1", webhook_secret: "s" }, error: null })
    findOrCreateTelegramGroup.mockResolvedValue({ group: { id: "g1", channel_id: "ch1", external_group_id: "x", group_name: null } })
    messagesInsert.mockResolvedValue({ data: null, error: { code: "23505", message: "duplicate key" } })

    const res = await POST(
      makeRequest(
        { update_id: 1, message: { message_id: 1, date: 1, text: "hi", chat: { id: 1, type: "private" } } },
        "s"
      ),
      { params: { channelId: "ch1" } }
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.deduped).toBe(true)
  })

  it("surfaces a genuine insert failure (not a dedup) as a 500", async () => {
    channelSingle.mockResolvedValue({ data: { id: "ch1", webhook_secret: "s" }, error: null })
    findOrCreateTelegramGroup.mockResolvedValue({ group: { id: "g1", channel_id: "ch1", external_group_id: "x", group_name: null } })
    messagesInsert.mockResolvedValue({ data: null, error: { code: "42501", message: "permission denied" } })

    const res = await POST(
      makeRequest(
        { update_id: 1, message: { message_id: 1, date: 1, text: "hi", chat: { id: 1, type: "private" } } },
        "s"
      ),
      { params: { channelId: "ch1" } }
    )
    expect(res.status).toBe(500)
  })
})
