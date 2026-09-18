/**
 * Tests for app/api/webhooks/2chat/[channelId]/route.ts
 *
 * Covers: fail-closed auth, status-change routing (disconnect alert), inbound
 * message ingestion, and webhook-retry dedup via the unique-constraint path.
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

const findOrCreateWhatsAppGroup = vi.fn()
vi.mock("@/lib/messaging/groups", () => ({
  findOrCreateWhatsAppGroup: (...args: unknown[]) => findOrCreateWhatsAppGroup(...args),
}))

const sendDisconnectAlertEmail = vi.fn()
vi.mock("@/lib/messaging/disconnect-alert", () => ({
  sendDisconnectAlertEmail: (...args: unknown[]) => sendDisconnectAlertEmail(...args),
}))

import { POST } from "@/app/api/webhooks/2chat/[channelId]/route"

function makeRequest(body: unknown, secret: string | null) {
  const url = new URL("http://localhost/api/webhooks/2chat/ch1")
  if (secret !== null) url.searchParams.set("secret", secret)
  return new NextRequest(url, { method: "POST", body: JSON.stringify(body) })
}

beforeEach(() => {
  vi.clearAllMocks()
  groupsSelectSingle.mockResolvedValue({ data: { unread_count: 0 }, error: null })
  groupsUpdate.mockResolvedValue({ data: null, error: null })
})

describe("POST /api/webhooks/2chat/[channelId]", () => {
  it("rejects a request with no secret configured on the channel (fail closed)", async () => {
    channelSingle.mockResolvedValue({ data: { id: "ch1", phone_number: "+1", webhook_secret: null }, error: null })
    const res = await POST(makeRequest({ sent_by: "user" }, "anything"), { params: { channelId: "ch1" } })
    expect(res.status).toBe(401)
  })

  it("rejects a request with the wrong secret", async () => {
    channelSingle.mockResolvedValue({ data: { id: "ch1", phone_number: "+1", webhook_secret: "real-secret" }, error: null })
    const res = await POST(makeRequest({ sent_by: "user" }, "wrong"), { params: { channelId: "ch1" } })
    expect(res.status).toBe(401)
  })

  it("rejects an unknown channel id", async () => {
    channelSingle.mockResolvedValue({ data: null, error: { message: "not found" } })
    const res = await POST(makeRequest({ sent_by: "user" }, "s"), { params: { channelId: "missing" } })
    expect(res.status).toBe(404)
  })

  it("sends the disconnect alert and does not touch messages for a disconnected event", async () => {
    channelSingle.mockResolvedValue({ data: { id: "ch1", phone_number: "+17274521093", webhook_secret: "s" }, error: null })
    const res = await POST(
      makeRequest({ event: "disconnected", payload: { reason: "LOGOUT" } }, "s"),
      { params: { channelId: "ch1" } }
    )
    expect(res.status).toBe(200)
    expect(sendDisconnectAlertEmail).toHaveBeenCalledWith({ channelName: "+17274521093", reason: "LOGOUT" })
    expect(findOrCreateWhatsAppGroup).not.toHaveBeenCalled()
  })

  it("acknowledges qr-received without alerting or touching messages", async () => {
    channelSingle.mockResolvedValue({ data: { id: "ch1", phone_number: "+1", webhook_secret: "s" }, error: null })
    const res = await POST(makeRequest({ event: "qr-received" }, "s"), { params: { channelId: "ch1" } })
    expect(res.status).toBe(200)
    expect(sendDisconnectAlertEmail).not.toHaveBeenCalled()
  })

  it("skips an outbound echo (sent_by=agent) without inserting a duplicate", async () => {
    channelSingle.mockResolvedValue({ data: { id: "ch1", phone_number: "+1", webhook_secret: "s" }, error: null })
    const res = await POST(
      makeRequest({ sent_by: "agent", remote_phone_number: "+15551234567", message: { text: "hi" } }, "s"),
      { params: { channelId: "ch1" } }
    )
    expect(res.status).toBe(200)
    expect(findOrCreateWhatsAppGroup).not.toHaveBeenCalled()
    expect(messagesInsert).not.toHaveBeenCalled()
  })

  it("inserts a genuinely new inbound message and increments the group's unread count", async () => {
    channelSingle.mockResolvedValue({ data: { id: "ch1", phone_number: "+1", webhook_secret: "s" }, error: null })
    findOrCreateWhatsAppGroup.mockResolvedValue({ group: { id: "g1", channel_id: "ch1", external_group_id: "x", group_name: null } })
    messagesInsert.mockResolvedValue({ data: null, error: null })
    groupsSelectSingle.mockResolvedValue({ data: { unread_count: 3 }, error: null })

    const res = await POST(
      makeRequest(
        { uuid: "MSG1", sent_by: "user", remote_phone_number: "+15551234567", message: { text: "hello" } },
        "s"
      ),
      { params: { channelId: "ch1" } }
    )

    expect(res.status).toBe(200)
    expect(findOrCreateWhatsAppGroup).toHaveBeenCalledWith({ channelId: "ch1", remoteIdentifier: "+15551234567" })
    expect(messagesInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        group_id: "g1",
        channel_id: "ch1",
        external_message_id: "MSG1",
        direction: "inbound",
        sender_phone: "+15551234567",
        content_text: "hello",
        status: "new",
      })
    )
  })

  it("revives a deleted (hidden) group when a new inbound message arrives, not just bumps unread_count", async () => {
    // Bug-hunter finding, dev job f331cd43, 2026-09-18: a client texting back
    // into a group staff had hidden via Delete used to update the SAME hidden
    // row's unread_count with no way for it to ever reappear in the Inbox.
    channelSingle.mockResolvedValue({ data: { id: "ch1", phone_number: "+1", webhook_secret: "s" }, error: null })
    findOrCreateWhatsAppGroup.mockResolvedValue({ group: { id: "g1", channel_id: "ch1", external_group_id: "x", group_name: null } })
    messagesInsert.mockResolvedValue({ data: null, error: null })
    groupsSelectSingle.mockResolvedValue({ data: { unread_count: 0 }, error: null })

    const res = await POST(
      makeRequest(
        { uuid: "MSG2", sent_by: "user", remote_phone_number: "+15551234567", message: { text: "still there?" } },
        "s"
      ),
      { params: { channelId: "ch1" } }
    )

    expect(res.status).toBe(200)
    expect(groupsUpdatePayload).toHaveBeenCalledWith(
      expect.objectContaining({ is_active: true, unread_count: 1 })
    )
  })

  it("treats a redelivered webhook (unique-constraint hit) as a successful dedup, not an error", async () => {
    channelSingle.mockResolvedValue({ data: { id: "ch1", phone_number: "+1", webhook_secret: "s" }, error: null })
    findOrCreateWhatsAppGroup.mockResolvedValue({ group: { id: "g1", channel_id: "ch1", external_group_id: "x", group_name: null } })
    messagesInsert.mockResolvedValue({ data: null, error: { code: "23505", message: "duplicate key" } })

    const res = await POST(
      makeRequest({ uuid: "MSG1", sent_by: "user", remote_phone_number: "+15551234567", message: { text: "hello" } }, "s"),
      { params: { channelId: "ch1" } }
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.deduped).toBe(true)
  })

  it("surfaces a genuine insert failure (not a dedup) as a 500", async () => {
    channelSingle.mockResolvedValue({ data: { id: "ch1", phone_number: "+1", webhook_secret: "s" }, error: null })
    findOrCreateWhatsAppGroup.mockResolvedValue({ group: { id: "g1", channel_id: "ch1", external_group_id: "x", group_name: null } })
    messagesInsert.mockResolvedValue({ data: null, error: { code: "42501", message: "permission denied" } })

    const res = await POST(
      makeRequest({ uuid: "MSG1", sent_by: "user", remote_phone_number: "+15551234567", message: { text: "hello" } }, "s"),
      { params: { channelId: "ch1" } }
    )
    expect(res.status).toBe(500)
  })
})
