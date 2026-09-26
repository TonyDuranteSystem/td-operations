import { describe, it, expect, vi, beforeEach } from "vitest"

const OB = "9c1a2b3c-0000-4000-8000-0000000000aa"

const st = vi.hoisted(() => ({
  staffDenied: false,
  isStaff: true,
  isOwner: true,
  channels: [{ id: "ch1" }] as Array<{ id: string }>,
  channelError: null as null | { message: string },
  rpcResults: {} as Record<string, { data: unknown; error: null | { message: string } }>,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
}))

vi.mock("@/lib/auth/require-staff-route", () => ({
  requireStaffRoute: async () => (st.staffDenied ? new Response(JSON.stringify({ error: "Not authorized" }), { status: 403 }) : null),
}))
vi.mock("@/lib/supabase/server", () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) } }) }))
vi.mock("@/lib/auth", () => ({ isStaffUser: () => st.isStaff, isOwnerOnly: () => st.isOwner }))
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: () => {
      const c: Record<string, unknown> = {}
      for (const op of ["select", "eq"]) c[op] = () => c
      c.then = (resolve: (v: unknown) => unknown) => resolve({ data: st.channelError ? null : st.channels, error: st.channelError })
      return c
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      st.rpcCalls.push({ fn, args })
      return st.rpcResults[fn] ?? { data: { ok: true }, error: null }
    },
  },
}))

import { POST as resolvePost } from "@/app/api/inbox/whatsapp/outbox/resolve/route"
import { POST as modePost } from "@/app/api/inbox/whatsapp/send-mode/route"

const req = (body: unknown) => ({ json: async () => body }) as never
const run = async (fn: (r: never) => Promise<Response>, body: unknown) => {
  const res = await fn(req(body))
  return { status: res.status, body: await res.json() }
}

beforeEach(() => {
  st.staffDenied = false
  st.isStaff = true
  st.isOwner = true
  st.channels = [{ id: "ch1" }]
  st.channelError = null
  st.rpcResults = {}
  st.rpcCalls = []
})

describe("POST /api/inbox/whatsapp/outbox/resolve", () => {
  it("staff can mark an unconfirmed reply as sent or discard it (recorded with who decided)", async () => {
    st.rpcResults.wabridge_resolve_outbox = { data: { ok: true, status: "sent" }, error: null }
    const r = await run(resolvePost, { outboxId: OB, action: "sent" })
    expect(r).toEqual({ status: 200, body: { success: true, status: "sent" } })
    expect(st.rpcCalls[0]).toEqual({ fn: "wabridge_resolve_outbox", args: { p_outbox_id: OB, p_action: "sent", p_user: "u1" } })
    await run(resolvePost, { outboxId: OB, action: "discard" })
    expect(st.rpcCalls[1].args.p_action).toBe("discard")
  })
  it("refuses a client or partner (not TD staff) before touching the database", async () => {
    st.isStaff = false
    expect((await run(resolvePost, { outboxId: OB, action: "sent" })).status).toBe(403)
    st.staffDenied = true
    st.isStaff = true
    expect((await run(resolvePost, { outboxId: OB, action: "sent" })).status).toBe(403)
    expect(st.rpcCalls).toHaveLength(0)
  })
  it("rejects bad input", async () => {
    for (const body of [{}, { outboxId: "nope", action: "sent" }, { outboxId: OB, action: "retry" }, { outboxId: OB }, { action: "sent" }]) {
      expect((await run(resolvePost, body)).status).toBe(400)
    }
    expect(st.rpcCalls).toHaveLength(0)
  })
  it("relays the database's plain refusal as a 409 (still being sent / not waiting for a decision)", async () => {
    st.rpcResults.wabridge_resolve_outbox = { data: { ok: false, code: "in_flight", message: "It is being sent right now — wait a minute." }, error: null }
    const r = await run(resolvePost, { outboxId: OB, action: "sent" })
    expect(r.status).toBe(409)
    expect(r.body.error).toMatch(/being sent right now/)
  })
  it("a database error is a generic 500 without detail", async () => {
    st.rpcResults.wabridge_resolve_outbox = { data: null, error: { message: "secret internals" } }
    const r = await run(resolvePost, { outboxId: OB, action: "sent" })
    expect(r.status).toBe(500)
    expect(JSON.stringify(r.body)).not.toContain("secret")
  })
})

describe("POST /api/inbox/whatsapp/send-mode (owner only)", () => {
  it("only the owner can change the pause switch — anyone else is refused before the database", async () => {
    st.isOwner = false
    expect((await run(modePost, { mode: "live" })).status).toBe(403)
    expect(st.rpcCalls).toHaveLength(0)
  })
  it("changes the mode through the database rules, for the one bridge line", async () => {
    const r = await run(modePost, { mode: "shadow" })
    expect(r).toEqual({ status: 200, body: { success: true } })
    expect(st.rpcCalls).toEqual([{ fn: "wabridge_set_send_mode", args: { p_channel_id: "ch1", p_mode: "shadow", p_allow_all: false } }])
  })
  it("'everyone' is only ever passed when explicitly true", async () => {
    await run(modePost, { mode: "live", allowAll: "yes" })
    expect(st.rpcCalls[0].args.p_allow_all).toBe(false)
    await run(modePost, { mode: "live", allowAll: true })
    expect(st.rpcCalls[1].args.p_allow_all).toBe(true)
  })
  it("saves the approved numbers first, then the mode", async () => {
    await run(modePost, { allowlist: ["17274234285"], mode: "live" })
    expect(st.rpcCalls.map((c) => c.fn)).toEqual(["wabridge_set_send_allowlist", "wabridge_set_send_mode"])
    expect(st.rpcCalls[0].args).toEqual({ p_channel_id: "ch1", p_digits: ["17274234285"] })
  })
  it("relays a refusal (going live with no list) as a 409 with the database's wording", async () => {
    st.rpcResults.wabridge_set_send_mode = { data: { ok: false, code: "needs_allowlist", message: "Going live needs a list of allowed numbers first." }, error: null }
    const r = await run(modePost, { mode: "live" })
    expect(r.status).toBe(409)
    expect(r.body.error).toMatch(/list of allowed numbers/)
  })
  it("rejects bad input", async () => {
    for (const body of [{}, { mode: "turbo" }, { allowlist: "17274234285" }, { allowlist: [1, 2] }, { allowlist: Array.from({ length: 201 }, () => "17274234285") }]) {
      expect((await run(modePost, body)).status).toBe(400)
    }
    expect(st.rpcCalls).toHaveLength(0)
  })
  it("refuses to guess when there is not exactly one WhatsApp bridge line", async () => {
    st.channels = []
    expect((await run(modePost, { mode: "shadow" })).status).toBe(409)
    st.channels = [{ id: "a" }, { id: "b" }]
    expect((await run(modePost, { mode: "shadow" })).status).toBe(409)
    expect(st.rpcCalls).toHaveLength(0)
  })
  it("a database error is a generic 500", async () => {
    st.channelError = { message: "secret internals" }
    const r = await run(modePost, { mode: "shadow" })
    expect(r.status).toBe(500)
    expect(JSON.stringify(r.body)).not.toContain("secret")
  })
})
