import { describe, it, expect, vi, beforeEach } from "vitest"

const MARK = { emoji: "👍", reactor_id: "u1", reactor_type: "staff", reactor_name: "Luca", created_at: "t" }

const st = vi.hoisted(() => ({
  isStaff: true,
  /** the team-mark half of the one-transaction click */
  toggle: { ok: true, added: true, reactions: [] as unknown[] } as Record<string, unknown>,
  /** the phone half: the queue function's answer */
  phone: { ok: true, queued: false, reason: "off" } as unknown,
  /** the click RPC itself failing (database error / function missing) */
  clickError: null as null | { message: string; code?: string },
  /** answer of the plain toggle used ONLY as the fallback when the click function does not exist yet */
  legacy: { data: { ok: true, added: true, reactions: [] } as unknown, error: null as null | { message: string } },
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  uiEvents: [] as string[],
}))

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: "u1", user_metadata: { full_name: "Luca" }, app_metadata: { role: st.isStaff ? "admin" : "partner" }, email: "luca@tonydurante.us" } } }),
    },
  }),
}))
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      st.rpcCalls.push({ fn, args })
      if (fn === "wabridge_react_click") {
        if (st.clickError) return { data: null, error: st.clickError }
        return { data: { toggle: st.toggle, phone: st.phone }, error: null }
      }
      return st.legacy
    },
  },
}))
vi.mock("@/lib/ui-events", () => ({ emitUiEvent: async (k: string) => { st.uiEvents.push(k) } }))

import { POST } from "@/app/api/inbox/whatsapp/message/[id]/react/route"

const call = (body: Record<string, unknown>) => POST({ json: async () => body } as never, { params: { id: "m1" } })

beforeEach(() => {
  st.isStaff = true
  st.toggle = { ok: true, added: true, reactions: [MARK] }
  st.phone = { ok: true, queued: false, reason: "off" }
  st.clickError = null
  st.legacy = { data: { ok: true, added: true, reactions: [MARK] }, error: null }
  st.rpcCalls = []
  st.uiEvents = []
})

describe("POST /api/inbox/whatsapp/message/[id]/react — the team mark", () => {
  it("makes ONE database call (the team mark and the phone decision in one transaction) and returns the updated list", async () => {
    const res = await call({ emoji: "👍" })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, added: true })
    expect(body.reactions).toHaveLength(1)
    expect(st.rpcCalls).toEqual([{ fn: "wabridge_react_click", args: { p_message_id: "m1", p_emoji: "👍", p_reactor_id: "u1", p_reactor_name: "Luca" } }])
  })
  it("refuses a non-staff caller (a partner) before touching the database", async () => {
    st.isStaff = false
    const res = await call({ emoji: "👍" })
    expect(res.status).toBe(403)
    expect(st.rpcCalls).toHaveLength(0)
  })
  it("refuses an empty or non-emoji-looking string", async () => {
    for (const emoji of ["", "  ", "abc123", "x".repeat(100)]) {
      const res = await call({ emoji })
      expect(res.status).toBe(400)
    }
    expect(st.rpcCalls).toHaveLength(0)
  })
  it("a missing message is a clean 404, not a 500", async () => {
    st.toggle = { ok: false, code: "not_found" }
    st.phone = null
    expect((await call({ emoji: "👍" })).status).toBe(404)
  })
  it("a database error surfaces as a 500 without crashing", async () => {
    st.clickError = { message: "boom" }
    expect((await call({ emoji: "👍" })).status).toBe(500)
  })
  it("deployed BEFORE its database change: falls back to the plain team-mark toggle, silently", async () => {
    st.clickError = { message: "Could not find the function", code: "PGRST202" }
    const res = await call({ emoji: "👍" })
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toMatchObject({ ok: true, added: true, phone: { queued: false, notice: null } })
    expect(st.rpcCalls.map((c) => c.fn)).toEqual(["wabridge_react_click", "wabridge_toggle_reaction"])
  })
})

describe("RELEASE 2 — the same click also asks for the reaction to go to the customer's phone", () => {
  it("a new pick is queued; the answer says so, and other open Inboxes are woken", async () => {
    st.phone = { ok: true, queued: true, id: "x", status: "pending", hold_seconds: 10 }
    const body = await (await call({ emoji: "👍" })).json()
    expect(body.phone).toEqual({ queued: true, holdSeconds: 10, notice: null })
    expect(st.uiEvents).toEqual(["whatsapp"])
  })

  it("an un-pick whose phone side is refused is worded as a REMOVAL", async () => {
    st.toggle = { ok: true, added: false, reactions: [] }
    st.phone = { ok: true, queued: false, reason: "offline" }
    const body = await (await call({ emoji: "👍" })).json()
    expect(body.added).toBe(false)
    expect(body.phone.notice).toMatch(/removal was not sent/)
  })

  it("when the feature is OFF (the default) nothing is queued, nothing is said, and the team mark still worked", async () => {
    const res = await call({ emoji: "👍" })
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toMatchObject({ ok: true, added: true, phone: { queued: false, notice: null } })
    expect(st.uiEvents).toEqual([])
  })

  it("a refusal comes back as a plain-English notice (too old, not allowed, odd emoji, offline, no reply yet, sender not running)", async () => {
    for (const [reason, re] of [["too_old", /1 hour/], ["not_allowed", /switched on/], ["bad_emoji", /common reactions/], ["offline", /offline/], ["no_inbound", /hasn't written/], ["sender_offline", /sender on the Mac/]] as const) {
      st.phone = { ok: true, queued: false, reason }
      const body = await (await call({ emoji: "👍" })).json()
      expect(body.phone.queued).toBe(false)
      expect(body.phone.notice).toMatch(re)
    }
  })

  it("a garbled phone answer is a quiet failure of the phone side only — the team mark is still reported saved", async () => {
    for (const odd of [null, undefined, "x", 5, {}, { ok: true }]) {
      st.phone = odd
      const res = await call({ emoji: "👍" })
      expect(res.status).toBe(200)
      expect((await res.json()).phone.queued).toBe(false)
    }
  })
})
