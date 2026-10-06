/**
 * POST /api/inbox/reply — an email with an unresolved fill-in-the-blank ("[price]", "{name}") must not leave by
 * accident (dev job bbc70ff8). The AI draft mode writes these on purpose when it lacks a fact; the composer asks
 * first, and the SERVER enforces the same rule for any other caller. An explicit allowPlaceholders:true is the
 * only way through.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const st = vi.hoisted(() => ({ resolveCalls: 0 }))

vi.mock("@/lib/auth/require-staff-route", () => ({ requireStaffRoute: async () => null }))
vi.mock("@/lib/supabase/server", () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) } }) }))
vi.mock("@/lib/auth", () => ({ isStaffUser: () => true, isAdmin: () => true }))
vi.mock("@/lib/messaging/send-dispatcher", () => ({ dispatchWhatsAppMessage: vi.fn() }))
vi.mock("@/lib/messaging/attachment-staging", () => ({ resolveWhatsAppAttachmentUrl: vi.fn() }))
vi.mock("@/lib/gmail", () => ({ gmailPost: vi.fn(), extractBody: vi.fn() }))
vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: { from: () => ({}) } }))
// Past the guard the route resolves the reply target; making that throw proves the request GOT past the guard
// without needing the whole Gmail pipeline.
vi.mock("@/lib/inbox/reply-target", () => {
  class ReplyTargetError extends Error {
    status = 400
  }
  return {
    ReplyTargetError,
    buildThreadQuotes: vi.fn(),
    resolveReplyTarget: async () => {
      st.resolveCalls++
      throw new ReplyTargetError("stop here — past the placeholder guard")
    },
  }
})

import { POST } from "@/app/api/inbox/reply/route"

const email = (message: string, extra: Record<string, unknown> = {}) => ({
  conversationId: "gmail:thread-1",
  message,
  channel: "gmail",
  mailbox: "support",
  ...extra,
})
const call = async (body: Record<string, unknown>) => {
  const res = await POST({ json: async () => body } as never)
  return { status: res.status, body: await res.json() }
}

beforeEach(() => {
  st.resolveCalls = 0
})

describe("POST /api/inbox/reply — unresolved placeholders", () => {
  it("refuses an email that still has a [blank], naming it, before touching Gmail", async () => {
    const r = await call(email("Hi Michael,\n\nThe fee is [price].\n\nBest,\nTony"))
    expect(r.status).toBe(400)
    expect(r.body.code).toBe("unresolved_placeholders")
    expect(r.body.placeholders).toEqual(["[price]"])
    expect(r.body.error).toContain("[price]")
    expect(st.resolveCalls).toBe(0)
  })

  it("refuses {curly} blanks too", async () => {
    const r = await call(email("Hi {name}, thanks."))
    expect(r.status).toBe(400)
    expect(r.body.code).toBe("unresolved_placeholders")
  })

  it("lets the same email through when the sender confirmed (allowPlaceholders: true)", async () => {
    const r = await call(email("The fee is [price].", { allowPlaceholders: true }))
    expect(r.body.code).not.toBe("unresolved_placeholders")
    expect(st.resolveCalls).toBe(1)
  })

  it("only an explicit true counts — truthy look-alikes do not unlock it", async () => {
    for (const v of ["true", 1, "yes", {}]) {
      const r = await call(email("The fee is [price].", { allowPlaceholders: v }))
      expect(r.body.code).toBe("unresolved_placeholders")
    }
    expect(st.resolveCalls).toBe(0)
  })

  it("does not block ordinary mail (footnotes, [sic], markdown links)", async () => {
    const r = await call(email("See note [1] — he wrote [sic] — and the [guide](https://example.com)."))
    expect(r.body.code).not.toBe("unresolved_placeholders")
    expect(st.resolveCalls).toBe(1)
  })
})
