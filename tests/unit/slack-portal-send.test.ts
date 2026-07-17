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
  accountContacts?: Array<{ contact_id: string; role?: string | null; ownership_pct?: number | null; is_primary?: boolean | null }>
  dedup?: { id: string; created_at: string } | null
  insert?: { data: { id: string; created_at: string } | null; error: { message: string } | null }
  markerError?: { code?: string } | null
}
let lastInsertedRow: Record<string, unknown> | null = null

function makeBuilder() {
  const state = { table: "" as string, lastInsertTable: "" as string }
  const builder: Record<string, (...args: unknown[]) => unknown> = {
    from: (t: unknown) => {
      state.table = String(t)
      return builder
    },
    select: () => builder,
    eq: () => builder,
    gte: () => builder,
    lt: () => builder,
    limit: () => builder,
    order: () => builder,
    insert: (row: unknown) => {
      state.lastInsertTable = state.table
      // worker_send_markers is a bookkeeping insert (idempotency); don't treat
      // it as the portal message row the tests assert on.
      if (state.table !== "worker_send_markers") lastInsertedRow = row as Record<string, unknown>
      return builder
    },
    maybeSingle: async () => {
      if (state.table === "portal_messages") return { data: responses.dedup ?? null }
      // accounts/contacts recipient-name lookups
      return { data: null }
    },
    single: async () =>
      responses.insert ?? { data: { id: "msg-1", created_at: "2026-06-13T00:00:00Z" }, error: null },
    // Directly-awaited chains: the account_contacts member fetch (array of
    // links) and the worker_send_markers idempotency insert ({error}).
    then: (resolve: (v: unknown) => void) => {
      if (state.lastInsertTable === "worker_send_markers") {
        state.lastInsertTable = ""
        return Promise.resolve({ error: responses.markerError ?? null }).then(resolve)
      }
      if (state.table === "account_contacts") {
        return Promise.resolve({ data: responses.accountContacts ?? [] }).then(resolve)
      }
      return Promise.resolve({ data: null, error: null }).then(resolve)
    },
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
    responses.accountContacts = [{ contact_id: "cnt-9" }]
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

describe("CRM Portal Chats panel — send attribution + recipient pin", () => {
  it("records the acting staff member (CRM worker) in the audit log", async () => {
    await sendPortalMessageFromWorker({ contact_id: "cnt-5", message: "hi" }, "crm-portal:luca@tonydurante.us")
    expect(logAction).toHaveBeenCalledOnce()
    const arg = logAction.mock.calls[0][0] as { actor: string; summary: string }
    expect(arg.actor).toBe("crm-portal:luca@tonydurante.us")
    expect(arg.summary).toContain("CRM worker")
  })

  it("defaults to the Slack-worker actor when none is passed (Slack path unchanged)", async () => {
    await sendPortalMessageFromWorker({ contact_id: "cnt-5", message: "hi" })
    const arg = logAction.mock.calls[0][0] as { actor: string; summary: string }
    expect(arg.actor).toBe("claude.slack")
    expect(arg.summary).toContain("Slack worker")
  })

  it("HARD-PINS the recipient: a model-supplied contact_id is overridden by the panel's client", async () => {
    responses.accountContacts = [{ contact_id: "cnt-PINNED" }]
    // Model tries to message a DIFFERENT client; the pin forces the open account.
    const r = await executeWorkerTool(
      "send_portal_message",
      { contact_id: "cnt-ATTACKER", message: "pinned" },
      undefined,
      undefined,
      undefined,
      { actor: "crm-portal:luca@tonydurante.us", pinnedPortalRecipient: { account_id: "acc-PIN" } },
    )
    expect(r).toContain("✅ Portal message sent")
    expect(lastInsertedRow).toMatchObject({ account_id: "acc-PIN", contact_id: "cnt-PINNED" })
    // the attacker-supplied contact id never reached the insert
    expect(lastInsertedRow).not.toMatchObject({ contact_id: "cnt-ATTACKER" })
  })
})
