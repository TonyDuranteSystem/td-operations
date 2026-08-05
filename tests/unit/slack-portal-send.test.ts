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
      // worker_send_markers (idempotency) and conversations (activity log) are
      // bookkeeping inserts — don't treat them as the portal message row the
      // tests assert on.
      if (state.table !== "worker_send_markers" && state.table !== "conversations") {
        lastInsertedRow = row as Record<string, unknown>
      }
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

/**
 * The tools this call was actually handed. `executeWorkerTool` now refuses
 * `send_portal_message` outright when it is not in this set — a real,
 * irreversible, client-visible send must never fire on a call that was not
 * offered the tool (added 2026-08-05; it was one of only two injected tools
 * missing that check, and it failed OPEN). These tests exercise the pin and the
 * language guard, so they must declare the tool as offered, exactly as the live
 * surfaces do via `enableSlackSend`.
 */
const OFFERED_PORTAL_SEND = new Set(["send_portal_message"])


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
    const r = await executeWorkerTool("send_portal_message", { contact_id: "cnt-5", message: "routed" }, OFFERED_PORTAL_SEND)
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

  it("DEFAULTS to the panel's client when the model names no recipient", async () => {
    responses.accountContacts = [{ contact_id: "cnt-DEFAULT" }]
    // The panel's prompt says "pass only the message" — the surface's own client
    // fills in. This is what keeps the everyday flow working now that the
    // recipient is a DEFAULT rather than a lock (Antonio, 2026-07-29).
    const r = await executeWorkerTool(
      "send_portal_message",
      { message: "no recipient supplied" },
      OFFERED_PORTAL_SEND,
      undefined,
      undefined,
      { actor: "crm-portal:luca@tonydurante.us", pinnedPortalRecipient: { account_id: "acc-PIN" } },
    )
    expect(r).toContain("✅ Portal message sent")
    expect(lastInsertedRow).toMatchObject({ account_id: "acc-PIN", contact_id: "cnt-DEFAULT" })
  })

  it("HARD-PINS the recipient: a model-supplied contact_id is overridden by the panel's client", async () => {
    // Briefly relaxed to a "staff-directed default" on 2026-07-29 and REVERTED the
    // same day on council findings: the sidebar and Team Chat carry this pin but no
    // client-scope validator, so a model-produced id would be delivered unchecked —
    // and on Portal Chats the client's OWN chat text is in context, so a line inside
    // it could retarget a client-visible message. Cross-client portal messaging needs
    // its own confirm-the-recipient step before it can be opened (email has one).
    responses.accountContacts = [{ contact_id: "cnt-PINNED" }]
    const r = await executeWorkerTool(
      "send_portal_message",
      { contact_id: "cnt-ATTACKER", message: "pinned" },
      OFFERED_PORTAL_SEND,
      undefined,
      undefined,
      { actor: "crm-portal:luca@tonydurante.us", pinnedPortalRecipient: { account_id: "acc-PIN" } },
    )
    expect(r).toContain("✅ Portal message sent")
    expect(lastInsertedRow).toMatchObject({ account_id: "acc-PIN", contact_id: "cnt-PINNED" })
    expect(lastInsertedRow).not.toMatchObject({ contact_id: "cnt-ATTACKER" })
  })
})

/**
 * THE EXECUTOR GATE (added 2026-08-05, from the worker capability audit).
 *
 * `send_portal_message` is a real, irreversible, CLIENT-VISIBLE send that also
 * auto-emails the client (R103). It was one of only two conditionally-injected
 * tools with no `availableNames` re-check, and it failed OPEN — the branch carried
 * a comment asserting it "reaches here only when the model was handed the tool",
 * which is the exact assumption every sibling branch in the file explicitly refuses
 * to make ("even if a name leaks", R108).
 *
 * That mattered most on the surfaces that never offer it: the Hermes cron and the
 * portal reply-suggester build NO send context at all, and BOTH remaining
 * safeties — the fail-closed pin check and the Italian/English language guard —
 * are themselves conditioned on a send context existing. So a leaked tool name
 * there fell through every layer to the live send with model-chosen recipient ids.
 */
describe("send_portal_message — executor availability gate", () => {
  it("refuses when the tool was NOT offered on this call (empty set)", async () => {
    const r = await executeWorkerTool(
      "send_portal_message",
      { contact_id: "cnt-5", message: "should never send" },
      new Set<string>(),
    )
    expect(r).toContain("not permitted")
    expect(r).not.toContain("✅")
  })

  it("refuses when availableNames is absent entirely — the research-worker shape", async () => {
    // Hermes / the portal suggester pass no tool set and no send context. Before the
    // gate this reached sendPortalMessageFromWorker and delivered to a real client.
    const r = await executeWorkerTool("send_portal_message", {
      contact_id: "cnt-5",
      message: "should never send",
    })
    expect(r).toContain("not permitted")
    expect(r).not.toContain("✅")
  })

  it("tells the model NOT to claim a send, so a refusal can't become a false 'sent'", async () => {
    const r = await executeWorkerTool(
      "send_portal_message",
      { contact_id: "cnt-5", message: "x" },
      new Set<string>(),
    )
    expect(r.toLowerCase()).toContain("do not claim")
  })

  it("still runs normally when the tool WAS offered", async () => {
    const r = await executeWorkerTool(
      "send_portal_message",
      { contact_id: "cnt-5", message: "offered" },
      OFFERED_PORTAL_SEND,
    )
    expect(r).toContain("✅ Portal message sent")
  })
})
