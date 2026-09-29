import { describe, it, expect, vi, beforeEach } from "vitest"

const st = vi.hoisted(() => ({
  isStaff: true,
  rpcResult: { data: { ok: true, added: true, reactions: [{ emoji: "👍", reactor_id: "u1", reactor_type: "staff", reactor_name: "Luca", created_at: "t" }] }, error: null as null | { message: string } },
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
}))

vi.mock("@/lib/supabase/server", () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: "u1", user_metadata: { full_name: "Luca" }, app_metadata: { role: st.isStaff ? "admin" : "partner" } } } }) } }) }))
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      st.rpcCalls.push({ fn, args })
      return st.rpcResult
    },
  },
}))

import { POST } from "@/app/api/inbox/whatsapp/message/[id]/react/route"

const call = (body: Record<string, unknown>) => POST({ json: async () => body } as never, { params: { id: "m1" } })

beforeEach(() => {
  st.isStaff = true
  st.rpcResult = { data: { ok: true, added: true, reactions: [{ emoji: "👍", reactor_id: "u1", reactor_type: "staff", reactor_name: "Luca", created_at: "t" }] }, error: null }
  st.rpcCalls = []
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
