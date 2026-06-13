/**
 * Slack worker — direct portal-chat send (send_portal_message).
 *
 * Antonio authorized a Slack-only, no-confirmation-code direct send to portal
 * chat on 2026-06-13. These tests pin the send logic (recipient resolution,
 * admin stamping, dedup guard, validation) and the safety invariant that the
 * tool is Slack-gated — it must NEVER be in the shared WORKER_TOOLS (which the
 * Hermes research worker also uses, R108).
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

// --- Mock supabaseAdmin with a reconfigurable chainable builder ----------------
// Sequential awaits in sendPortalMessageFromWorker let a single shared builder
// with mutable state stand in for: account_contacts lookup (maybeSingle),
// portal_messages dedup select (maybeSingle), portal_messages insert (single).
let responses: {
  accountContacts?: { contact_id: string } | null
  dedup?: { id: string; created_at: string } | null
  insert?: { data: { id: string; created_at: string } | null; error: { message: string } | null }
}
let lastInsertedRow: Record<string, unknown> | null = null

function makeBuilder() {
  const state = { table: "" as string }
  const builder: Record<string, (...args: unknown[]) => unknown> = {
    from: (t: unknown) => {
      state.table = String(t)
      return builder
    },
    select: () => builder,
    eq: () => builder,
    gte: () => builder,
    limit: () => builder,
    insert: (row: unknown) => {
      lastInsertedRow = row as Record<string, unknown>
      return builder
    },
    maybeSingle: async () => {
      if (state.table === "account_contacts") return { data: responses.accountContacts ?? null }
      if (state.table === "portal_messages") return { data: responses.dedup ?? null }
      return { data: null }
    },
    single: async () =>
      responses.insert ?? { data: { id: "msg-1", created_at: "2026-06-13T00:00:00Z" }, error: null },
  }
  return builder
}

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: { from: (t: string) => makeBuilder().from(t) },
}))

const createPortalNotification = vi.fn().mockResolvedValue(undefined)
const notifyClientOfAdminMessage = vi.fn().mockResolvedValue(undefined)
vi.mock("@/lib/portal/notifications", () => ({
  createPortalNotification: (...a: unknown[]) => createPortalNotification(...a),
  notifyClientOfAdminMessage: (...a: unknown[]) => notifyClientOfAdminMessage(...a),
}))

const logAction = vi.fn()
vi.mock("@/lib/mcp/action-log", () => ({ logAction: (...a: unknown[]) => logAction(...a) }))

import {
  sendPortalMessageFromWorker,
  executeWorkerTool,
  WORKER_TOOLS,
  SEND_PORTAL_MESSAGE_TOOL,
} from "@/lib/ai-agent/worker-tools"

beforeEach(() => {
  responses = {}
  lastInsertedRow = null
  createPortalNotification.mockClear()
  notifyClientOfAdminMessage.mockClear()
  logAction.mockClear()
})

describe("sendPortalMessageFromWorker", () => {
  it("rejects when neither account_id nor contact_id is provided", async () => {
    const r = await sendPortalMessageFromWorker({ message: "hi" })
    expect(r).toContain("account_id")
    expect(lastInsertedRow).toBeNull()
  })

  it("rejects an empty / whitespace-only message", async () => {
    const r = await sendPortalMessageFromWorker({ account_id: "acc-1", message: "   " })
    expect(r).toContain("non-empty message")
    expect(lastInsertedRow).toBeNull()
  })

  it("account_id only: resolves the linked contact and stamps the message as admin", async () => {
    responses.accountContacts = { contact_id: "cnt-9" }
    const r = await sendPortalMessageFromWorker({ account_id: "acc-1", message: "Hello there" })
    expect(r).toContain("✅ Portal message sent")
    expect(lastInsertedRow).toMatchObject({
      account_id: "acc-1",
      contact_id: "cnt-9",
      sender_type: "admin",
      sender_id: "b0da5d9c-acf6-4761-9cae-2c3b14dbc631",
      message: "Hello there",
      attachments: [],
    })
    expect(notifyClientOfAdminMessage).toHaveBeenCalledOnce()
    expect(logAction).toHaveBeenCalledOnce()
  })

  it("contact_id only: inserts directly without an account lookup", async () => {
    const r = await sendPortalMessageFromWorker({ contact_id: "cnt-5", message: "Just you" })
    expect(r).toContain("✅ Portal message sent")
    expect(lastInsertedRow).toMatchObject({ account_id: null, contact_id: "cnt-5", sender_type: "admin" })
  })

  it("trims surrounding whitespace before sending", async () => {
    await sendPortalMessageFromWorker({ contact_id: "cnt-5", message: "  padded  " })
    expect(lastInsertedRow).toMatchObject({ message: "padded" })
  })

  it("dedup guard: an identical recent admin message blocks a re-send", async () => {
    responses.dedup = { id: "existing-1", created_at: "2026-06-13T00:00:00Z" }
    const r = await sendPortalMessageFromWorker({ contact_id: "cnt-5", message: "dup text" })
    expect(r).toContain("Already sent")
    expect(r).toContain("existing-1")
    expect(lastInsertedRow).toBeNull()
  })

  it("surfaces a DB insert error instead of claiming success", async () => {
    responses.insert = { data: null, error: { message: "boom" } }
    const r = await sendPortalMessageFromWorker({ contact_id: "cnt-5", message: "will fail" })
    expect(r).toContain("Failed to send portal message")
    expect(r).toContain("boom")
  })
})

describe("send_portal_message — safety wiring", () => {
  it("is NOT in the shared WORKER_TOOLS (Slack-gated only, must never reach Hermes — R108)", () => {
    expect(WORKER_TOOLS.some((t) => t.name === SEND_PORTAL_MESSAGE_TOOL.name)).toBe(false)
  })

  it("executeWorkerTool routes send_portal_message (NOT rejected by the read-only guard)", async () => {
    const r = await executeWorkerTool("send_portal_message", { contact_id: "cnt-5", message: "routed" })
    expect(r).not.toContain("not permitted")
    expect(r).toContain("✅ Portal message sent")
  })
})
