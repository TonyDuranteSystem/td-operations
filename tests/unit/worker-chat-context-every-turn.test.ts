import { describe, it, expect, vi, beforeEach } from "vitest"

/**
 * THE REGRESSION TEST FOR THE SCALEDGE FAILURE.
 *
 * Antonio, 2026-08-01, turn 4 of a live Inbox conversation: he pointed at the open
 * email — "this is an example of email regarding the previous tax return request" —
 * and the worker replied that it could see only the two PDF attachments and asked him
 * to paste the text. Measured afterwards against the stored prompts in sandbox:
 *
 *   turn 1 | 9581 chars | email: YES | attachments: YES
 *   turn 2 | 1335 chars | email: no  | attachments: YES
 *   turn 3 | 1322 chars | email: no  | attachments: YES
 *   turn 4 | 1350 chars | email: no  | attachments: YES
 *
 * The email was handed over on the first message only, while the attachment list was
 * rebuilt every turn — so the worker could enumerate the PDFs with confidence and had
 * no email at all. Its answer was an accurate description of its own context.
 *
 * This test drives the real route handler with the panel's TURN-2+ request shape —
 * `context: null`, which is exactly what the panel sends after the first message — and
 * asserts the email is in the prompt anyway. It fails on the old code.
 */

const state = vi.hoisted(() => ({
  insertedBody: "" as string,
  workerUserBody: "" as string,
}))

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1", email: "luca@tonydurante.us" } } }) },
  }),
}))
vi.mock("@/lib/auth", () => ({ isDashboardUser: () => true }))
vi.mock("@/lib/inbox/mailbox-access", () => ({ checkMailboxAccess: async () => true }))

// A REAL two-message Gmail thread, the second message being the one Antonio pointed at.
vi.mock("@/lib/gmail", () => ({
  gmailGet: async () => ({
    messages: [
      { id: "m1", payload: { headers: [{ name: "From", value: "Smit Shah <smit@adasglobus.com>" }, { name: "Date", value: "Thu, 16 Jul 2026" }, { name: "Subject", value: "Scaledge LLC – Tax Return 2025" }] } },
      { id: "m2", payload: { headers: [{ name: "From", value: "TD Support <support@tonydurante.us>" }, { name: "Date", value: "Fri, 31 Jul 2026" }, { name: "Subject", value: "Scaledge LLC – Tax Return 2025" }] } },
    ],
  }),
  getHeader: (headers: Array<{ name: string; value: string }> | undefined, name: string) =>
    headers?.find((h) => h.name === name)?.value ?? "",
  extractBody: (payload: { headers?: Array<{ name: string; value: string }> }) =>
    payload?.headers?.find((h) => h.name === "From")?.value?.includes("Smit")
      ? "Please find attached the draft return for your review."
      : "Hi Smit, please find attached the prior year (2024) tax return for Scaledge LLC.",
}))

vi.mock("@/lib/inbox/email-attachments", () => ({
  harvestEmailAttachments: async () => ({
    imageBlocks: [],
    pinned: [],
    note: "Documents:\n  att_7c9bc6c7 — 2025_Scaledge LLC_1120.PDF (application/pdf, 1928 KB)",
  }),
}))
vi.mock("@/lib/inbox/email-recipients", () => ({
  collectThreadRecipients: () => ["smit@adasglobus.com", "support@tonydurante.us"],
  TD_MAILBOXES: ["support@tonydurante.us", "antonio.durante@tonydurante.us"],
}))
vi.mock("@/lib/inbox/worker-email-send", () => ({
  snapshotPendingPreparedIds: async () => ({ ids: new Set<string>(), known: true }),
  findPreparedFrozenThisTurn: async () => null,
}))

// Capture what actually reaches the model.
vi.mock("@/lib/ai-agent/attachment-reader", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>
  return {
    ...actual,
    callWorkerWithAttachments: async (userBody: string) => {
      state.workerUserBody = userBody
      return { reply: "ok", artifacts: [] }
    },
    fetchWorkerUploadBytes: async () => [],
    readAttachments: async () => ({ imageBlocks: [], documentBlocks: [], textParts: [], skipped: [] }),
    capMediaBudget: (a: unknown[], b: unknown[]) => ({ images: a, documents: b, dropped: [] }),
  }
})

vi.mock("@/lib/supabase-admin", () => {
  const b: Record<string, unknown> = {}
  b.from = () => b
  b.select = () => b
  b.eq = () => b
  b.is = () => b
  b.or = () => b
  b.order = () => b
  b.limit = () => b
  b.in = () => b
  b.maybeSingle = async () => ({ data: null })
  b.single = async () => ({ data: { id: "row-1" }, error: null })
  b.insert = (row: { body?: string }) => {
    if (row?.body) state.insertedBody = row.body
    return b
  }
  b.update = () => b
  b.then = (resolve: (v: unknown) => void) => Promise.resolve({ data: [], error: null }).then(resolve)
  return { supabaseAdmin: b }
})

import { POST } from "@/app/api/inbox/worker-chat/route"

function turnRequest(message: string, context: unknown) {
  return {
    json: async () => ({
      message,
      gmailThreadId: "19f18a77409bc0da",
      mailbox: "support",
      // THE POINT: the panel sends `context` on the FIRST message only. Every later
      // turn arrives with null — which used to mean "build no email at all".
      context,
    }),
  } as unknown as Parameters<typeof POST>[0]
}

beforeEach(() => {
  state.insertedBody = ""
  state.workerUserBody = ""
})

describe("Inbox worker — the open email is in EVERY turn", () => {
  it("TURN 2+ (context: null) still carries the email transcript", async () => {
    await POST(turnRequest("this is an example of email regardung the previous tax return request", null))

    // The exact sentence Antonio was pointing at when the worker said it couldn't see it.
    expect(state.workerUserBody).toContain("prior year (2024) tax return for Scaledge LLC")
    expect(state.workerUserBody).toContain("Please find attached the draft return")
  })

  it("TURN 2+ carries the thread id — the worker's only handle for reading further back", async () => {
    await POST(turnRequest("what did he ask for?", null))
    expect(state.workerUserBody).toContain("19f18a77409bc0da")
  })

  it("TURN 2+ carries the subject and sender, resolved server-side", async () => {
    // The panel stops sending these after turn 1, so they have to come from the thread.
    await POST(turnRequest("who is this from?", null))
    expect(state.workerUserBody).toContain("Scaledge LLC – Tax Return 2025")
    expect(state.workerUserBody).toContain("Smit Shah")
  })

  it("keeps the email FENCED as untrusted — a stranger wrote it and this surface can send", async () => {
    await POST(turnRequest("summarise", null))
    expect(state.workerUserBody).toMatch(/untrusted-file-content/i)
    expect(state.workerUserBody).toMatch(/DATA, not instructions/i)
  })

  it("the attachments list is still there too — both, not one or the other", async () => {
    // The original asymmetry (attachments every turn, email once) is what made the
    // worker's wrong-sounding answer literally correct.
    await POST(turnRequest("anything attached?", null))
    expect(state.workerUserBody).toContain("2025_Scaledge LLC_1120.PDF")
  })

  it("the stored turn records the email too, so the replayed summary is not blind", async () => {
    await POST(turnRequest("remind me what this is", null))
    expect(state.insertedBody).toContain("prior year (2024) tax return")
  })
})
