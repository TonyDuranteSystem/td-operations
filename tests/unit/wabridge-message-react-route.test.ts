import { describe, it, expect, vi, beforeEach } from "vitest"

const st = vi.hoisted(() => ({
  isStaff: true,
  rpcResult: { data: { ok: true, added: true, reactions: [{ emoji: "👍", reactor_id: "u1", reactor_type: "staff", reactor_name: "Luca", created_at: "t" }] }, error: null as null | { message: string } },
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  /** the phone-reaction queue function's answer (separate from the team-mark toggle's) */
  queue: { data: { ok: true, queued: false, reason: "off" } as unknown, error: null as null | { message: string }, throws: false },
  uiEvents: [] as string[],
}))

vi.mock("@/lib/supabase/server", () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: "u1", user_metadata: { full_name: "Luca" }, app_metadata: { role: st.isStaff ? "admin" : "partner" } } } }) } }) }))
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      st.rpcCalls.push({ fn, args })
      if (fn === "wabridge_queue_phone_reaction") {
        if (st.queue.throws) throw new Error("queue exploded")
        return { data: st.queue.data, error: st.queue.error }
      }
      return st.rpcResult
    },
  },
}))

vi.mock("@/lib/ui-events", () => ({ emitUiEvent: async (k: string) => { st.uiEvents.push(k) } }))

import { POST } from "@/app/api/inbox/whatsapp/message/[id]/react/route"

const call = (body: Record<string, unknown>) => POST({ json: async () => body } as never, { params: { id: "m1" } })

beforeEach(() => {
  st.isStaff = true
  st.rpcResult = { data: { ok: true, added: true, reactions: [{ emoji: "👍", reactor_id: "u1", reactor_type: "staff", reactor_name: "Luca", created_at: "t" }] }, error: null }
  st.rpcCalls = []
  st.queue = { data: { ok: true, queued: false, reason: "off" }, error: null, throws: false }
  st.uiEvents = []
})

describe("POST /api/inbox/whatsapp/message/[id]/react", () => {
  it("toggles a reaction and returns the updated list", async () => {
    const res = await call({ emoji: "👍" })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, added: true })
    expect(body.reactions).toHaveLength(1)
    expect(st.rpcCalls[0]).toEqual({
      fn: "wabridge_toggle_reaction",
      args: { p_message_id: "m1", p_emoji: "👍", p_reactor_id: "u1", p_reactor_name: "Luca" },
    })
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
    st.rpcResult = { data: { ok: false, code: "not_found" }, error: null }
    const res = await call({ emoji: "👍" })
    expect(res.status).toBe(404)
  })
  it("a database error surfaces as a 500 without crashing", async () => {
    st.rpcResult = { data: null, error: { message: "boom" } }
    const res = await call({ emoji: "👍" })
    expect(res.status).toBe(500)
  })
})

describe("RELEASE 2 — the same click also asks for the reaction to go to the customer's phone", () => {
  const queueCall = () => st.rpcCalls.find((c) => c.fn === "wabridge_queue_phone_reaction")

  it("a new pick is queued as 'set' for the staff member, AFTER the team mark is saved", async () => {
    st.queue.data = { ok: true, queued: true, id: "x", status: "pending", hold_seconds: 10 }
    const res = await call({ emoji: "👍" })
    const body = await res.json()
    expect(st.rpcCalls.map((c) => c.fn)).toEqual(["wabridge_toggle_reaction", "wabridge_queue_phone_reaction"])
    expect(queueCall()?.args).toEqual({ p_message_id: "m1", p_emoji: "👍", p_action: "set", p_user: "u1" })
    expect(body.phone).toEqual({ queued: true, holdSeconds: 10, notice: null })
    expect(st.uiEvents).toEqual(["whatsapp"]) // other open Inboxes show "sending to the phone…"
  })

  it("un-picking (the team mark was removed) is sent as 'remove'", async () => {
    st.rpcResult = { data: { ok: true, added: false, reactions: [] }, error: null }
    st.queue.data = { ok: true, queued: true, id: "x", status: "pending", hold_seconds: 10 }
    await call({ emoji: "👍" })
    expect(queueCall()?.args.p_action).toBe("remove")
  })

  it("when the feature is OFF (the default) nothing is queued, nothing is said, and the team mark still worked", async () => {
    const res = await call({ emoji: "👍" })
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toMatchObject({ ok: true, added: true, phone: { queued: false, notice: null } })
    expect(st.uiEvents).toEqual([])
  })

  it("a refusal comes back as a plain-English notice (too old, not allowed, odd emoji, offline)", async () => {
    for (const [reason, re] of [["too_old", /1 hour/], ["not_allowed", /switched on/], ["bad_emoji", /common reactions/], ["offline", /offline/]] as const) {
      st.queue.data = { ok: true, queued: false, reason }
      const body = await (await call({ emoji: "👍" })).json()
      expect(body.phone.queued).toBe(false)
      expect(body.phone.notice).toMatch(re)
    }
  })

  it("a queue failure or crash NEVER undoes or fails the team mark", async () => {
    st.queue.error = { message: "boom" }
    let res = await call({ emoji: "👍" })
    expect(res.status).toBe(200)
    expect((await res.json()).phone.queued).toBe(false)
    st.queue.error = null
    st.queue.throws = true
    res = await call({ emoji: "👍" })
    expect(res.status).toBe(200)
    expect((await res.json()).added).toBe(true)
  })

  it("a bad or missing team mark never reaches the queue; a non-staff caller neither", async () => {
    st.isStaff = false
    await call({ emoji: "👍" })
    st.isStaff = true
    st.rpcResult = { data: { ok: false, code: "not_found" }, error: null }
    await call({ emoji: "👍" })
    expect(queueCall()).toBeUndefined()
  })
})

