import { describe, it, expect, vi, beforeEach } from "vitest"

/**
 * confirmWorkerEmailSend — the dispatch half. The one that MUST NOT go wrong:
 * once the email has left, a post-send hiccup can never roll the row back to
 * pending (that would let a retry send the SAME email twice).
 */

// Mutable test state the supabase mock reads/writes.
const state = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  updates: [] as Array<Record<string, unknown>>,
  failPostSendUpdate: false,
  sendCalls: 0,
  failSend: false,
}))

vi.mock("@/lib/supabase-admin", () => {
  const makeChain = (op: "claim" | "update" | "select") => {
    const ctx: { patch?: Record<string, unknown> } = {}
    const chain: Record<string, unknown> = {}
    chain.update = (patch: Record<string, unknown>) => { ctx.patch = patch; return chain }
    chain.select = () => chain
    chain.eq = () => chain
    chain.maybeSingle = async () => ({ data: state.row })
    chain.single = async () => {
      // The pending→sent claim.
      if (ctx.patch && ctx.patch.status === "sent") {
        if (!state.row || state.row.status !== "pending") return { data: null }
        state.row = { ...state.row, ...ctx.patch }
        return { data: state.row }
      }
      return { data: state.row }
    }
    // terminal await for a bare update().eq().eq() (post-send bookkeeping / rollback)
    chain.then = (resolve: (v: unknown) => void) => {
      if (ctx.patch) {
        state.updates.push(ctx.patch)
        if (state.failPostSendUpdate && ctx.patch.gmail_message_id !== undefined) {
          return resolve(Promise.reject(new Error("db down")))
        }
        if (state.row) state.row = { ...state.row, ...ctx.patch }
      }
      return resolve({ data: null })
    }
    void op
    return chain
  }
  const admin = {
    from: () => makeChain("update"),
    storage: {
      from: () => ({
        download: async () => ({ data: { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }, error: null }),
      }),
    },
  }
  return { supabaseAdmin: admin }
})

const gmailPost = vi.hoisted(() => vi.fn())
vi.mock("@/lib/gmail", () => ({
  gmailPost: (...a: unknown[]) => gmailPost(...a),
  gmailGet: async () => ({ threadId: "gt", payload: { headers: [] }, messages: [] }),
  getHeader: () => "",
}))
vi.mock("@/lib/operations/email", () => ({ plainTextToParagraphs: (s: string) => s }))
vi.mock("@/lib/config", () => ({ APP_BASE_URL: "https://app.test" }))
vi.mock("@/lib/mcp/action-log", () => ({ logAction: vi.fn() }))
vi.mock("@/lib/inbox/email-recipients", () => ({
  checkRecipientsAllowed: () => ({ ok: true }),
  collectThreadRecipients: () => ["client@acme.com"],
  // Real values, not placeholders: the mailbox-override claim writes
  // TD_MAILBOXES[1] into the row and the sender lookup reads it back.
  TD_MAILBOXES: ["support@tonydurante.us", "antonio.durante@tonydurante.us"],
}))

import { confirmWorkerEmailSend } from "@/lib/inbox/worker-email-send"

const baseRow = () => ({
  id: "p1",
  status: "pending",
  mailbox: "support@tonydurante.us",
  to_address: "client@acme.com",
  subject: "Re: LLC",
  body: "here it is",
  gmail_thread_id: null, // no re-check path → exercises the simplest dispatch
  reply_to_message_id: null,
  attachments: [{ path: "worker-chat/0f8fad5b-d9cb-469f-a165-70867728950e.pdf", name: "a.pdf", content_type: "application/pdf", size: 3 }],
})

beforeEach(() => {
  state.row = baseRow()
  state.updates = []
  state.failPostSendUpdate = false
  state.sendCalls = 0
  gmailPost.mockReset()
  gmailPost.mockImplementation(async () => { state.sendCalls++; return { id: "gmail-msg-1" } })
})

describe("confirmWorkerEmailSend", () => {
  it("sends the frozen payload and returns ok", async () => {
    const r = await confirmWorkerEmailSend("p1", "luca@tonydurante.us")
    expect(r.ok).toBe(true)
    expect(r.ok && r.gmailMessageId).toBe("gmail-msg-1")
    expect(state.sendCalls).toBe(1)
    expect(state.row!.status).toBe("sent")
  })

  it("does NOT roll back to pending when POST-SEND bookkeeping fails (no double-send)", async () => {
    state.failPostSendUpdate = true
    const r = await confirmWorkerEmailSend("p1", "luca@tonydurante.us")
    // The email left exactly once and the result is success…
    expect(state.sendCalls).toBe(1)
    expect(r.ok).toBe(true)
    // …and the row was NEVER rolled back to pending (a retry can't re-send).
    expect(state.updates.some((u) => u.status === "pending")).toBe(false)
    expect(state.row!.status).toBe("sent")
  })

  it("refuses a row that is no longer pending (double Confirm click)", async () => {
    state.row = { ...baseRow(), status: "sent" }
    const r = await confirmWorkerEmailSend("p1", "luca@tonydurante.us")
    expect(r.ok).toBe(false)
    expect(state.sendCalls).toBe(0)
  })

  it("rolls back to pending when the send FAILS before leaving (safe retry)", async () => {
    gmailPost.mockRejectedValueOnce(new Error("Gmail 500"))
    const r = await confirmWorkerEmailSend("p1", "luca@tonydurante.us")
    expect(r.ok).toBe(false)
    // rolled back so the staff can retry
    expect(state.updates.some((u) => u.status === "pending")).toBe(true)
    expect(state.sendCalls).toBe(0)
  })

  it("CANCELS (not pending) a permanently-bad attachment path — no endless retry", async () => {
    state.row = { ...baseRow(), attachments: [{ path: "not-a-valid-path", name: "x.pdf", size: 3 }] }
    const r = await confirmWorkerEmailSend("p1", "luca@tonydurante.us")
    expect(r.ok).toBe(false)
    expect(state.sendCalls).toBe(0)
    // terminal → cancelled, never pending
    expect(state.updates.some((u) => u.status === "cancelled")).toBe(true)
    expect(state.updates.some((u) => u.status === "pending")).toBe(false)
  })

  it("refuses a stale prepared send (older than the TTL) and cancels it", async () => {
    state.row = { ...baseRow(), created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() }
    const r = await confirmWorkerEmailSend("p1", "luca@tonydurante.us")
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toMatch(/too old/)
    expect(state.sendCalls).toBe(0)
    expect(state.row!.status).toBe("cancelled")
  })
})

/**
 * The staff member's signature pick from the Confirm card (Luca's Team Chat
 * request, Antonio approved 2026-08-07). The raw MIME gmailPost received is
 * decoded here so the assertions read the HTML that actually leaves.
 */
function sentMime(): string {
  const payload = gmailPost.mock.calls.at(-1)?.[1] as { raw: string }
  const raw = Buffer.from(payload.raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8")
  // Decode every base64 body chunk (html + plain parts) back to text so a
  // marker can be searched regardless of which part carries it.
  const decoded = raw
    .split(/\r\n\r\n/)
    .map((chunk) => {
      const b64 = chunk.replace(/\r\n/g, "")
      return /^[A-Za-z0-9+/=]+$/.test(b64) && b64.length > 20
        ? Buffer.from(b64, "base64").toString("utf-8")
        : chunk
    })
    .join("\n")
  return decoded
}

describe("the signature pick on the Confirm card", () => {
  it("defaults to the full signature when the panel sends no pick (pre-picker behavior)", async () => {
    const r = await confirmWorkerEmailSend("p1", "luca@tonydurante.us")
    expect(r.ok).toBe(true)
    const mime = sentMime()
    // support full = the lockup + badges redesign
    expect(mime).toContain("signature-td-lockup.png")
    expect(mime).toContain("signature-badges.png")
    expect(mime).toContain("Best regards,")
  })

  it("honours a compact pick", async () => {
    const r = await confirmWorkerEmailSend("p1", "luca@tonydurante.us", undefined, "text")
    expect(r.ok).toBe(true)
    const mime = sentMime()
    expect(mime).toContain("signature-td-mark.png")
    expect(mime).not.toContain("signature-td-lockup.png")
    expect(mime).not.toContain("signature-badges.png")
  })

  it("honours 'none': no block, no sign-off, no stray blank lines", async () => {
    const r = await confirmWorkerEmailSend("p1", "luca@tonydurante.us", undefined, "none")
    expect(r.ok).toBe(true)
    const mime = sentMime()
    expect(mime).not.toContain("signature-td")
    expect(mime).not.toContain("Best regards")
    // The identity block never rendered (the From header still carries the
    // mailbox address, so the address line is the marker, not the email).
    expect(mime).not.toContain("10225 Ulmerton Rd")
    expect(mime).toContain("here it is")
  })

  it("applies the picked signature to the OVERRIDDEN mailbox, not the row's", async () => {
    const r = await confirmWorkerEmailSend("p1", "luca@tonydurante.us", "antonio", "gala")
    expect(r.ok).toBe(true)
    const mime = sentMime()
    // Antonio's full variant keeps his portrait + the original banner
    expect(mime).toContain("signature-antonio-gala.jpg")
    expect(mime).toContain("tony-logos.png")
    expect(mime).not.toContain("signature-badges.png")
  })
})
