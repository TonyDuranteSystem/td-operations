import { describe, it, expect, vi, beforeEach } from "vitest"

/**
 * POST /api/inbox/worker-chat/confirm-send — the wiring the bug hunter proved
 * untestable by mutation (2026-08-07): the panel's signature pick must survive
 * the route and reach confirmWorkerEmailSend as its 4th argument. The dispatch
 * behavior itself is covered in worker-email-confirm.test.ts; THIS file pins
 * the seam between them, so deleting the forwarding no longer stays green.
 */

const state = vi.hoisted(() => ({
  row: { id: "p1", kind: "email", mailbox: "support@tonydurante.us", status: "pending", actor: "inbox:luca@tonydurante.us" } as Record<string, unknown> | null,
}))

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { email: "luca@tonydurante.us" } } }) },
  }),
}))
vi.mock("@/lib/auth", () => ({ isDashboardUser: () => true }))
vi.mock("@/lib/inbox/mailbox-access", () => ({ checkMailboxAccess: async () => true }))
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.row }) }) }),
    }),
  },
}))

const confirmSpy = vi.hoisted(() => vi.fn(async () => ({ ok: true, gmailMessageId: "g1", to: "client@acme.com" })))
vi.mock("@/lib/inbox/worker-email-send", () => ({ confirmWorkerEmailSend: confirmSpy }))

import { POST } from "@/app/api/inbox/worker-chat/confirm-send/route"

function req(body: Record<string, unknown>) {
  // The handler touches only req.json(); a structural stand-in keeps the test
  // free of NextRequest construction ceremony.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { json: async () => body } as any
}

beforeEach(() => {
  state.row = { id: "p1", kind: "email", mailbox: "support@tonydurante.us", status: "pending", actor: "inbox:luca@tonydurante.us" }
  confirmSpy.mockClear()
})

describe("confirm-send route — signature_variant forwarding", () => {
  it("forwards the staff pick as the 4th argument", async () => {
    const res = await POST(req({ prepared_id: "p1", action: "confirm", mailbox: "support", signature_variant: "none" }))
    expect(res.status).toBe(200)
    expect(confirmSpy).toHaveBeenCalledWith("p1", "luca@tonydurante.us", "support", "none")
  })

  it("passes undefined when the panel sends no pick — the default lives in the dispatcher, not here", async () => {
    await POST(req({ prepared_id: "p1", action: "confirm", mailbox: "support" }))
    expect(confirmSpy).toHaveBeenCalledWith("p1", "luca@tonydurante.us", "support", undefined)
  })

  it("narrows garbage to the parser's fallback rather than passing it through", async () => {
    await POST(req({ prepared_id: "p1", action: "confirm", mailbox: "support", signature_variant: "GALA!!" }))
    const forwarded = confirmSpy.mock.calls[0][3]
    expect(forwarded).toBe("gala") // parseSignatureVariant's fallback, never the raw string
  })
})
