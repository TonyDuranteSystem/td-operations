import { describe, it, expect, vi, beforeEach } from "vitest"

const GROUP = "9c1a2b3c-0000-4000-8000-000000000001"
const CHANNEL = "4cb021ab-1731-49b8-9d27-6483d2dae4f1"

const st = vi.hoisted(() => ({
  staffDenied: false,
  isStaff: true,
  group: { external_group_id: "17274234285@c.us", channel_id: "4cb021ab-1731-49b8-9d27-6483d2dae4f1" } as null | Record<string, unknown>,
  provider: "wabridge" as string | null,
  rpc: { data: { ok: true, id: "ob1", status: "shadow" } as unknown, error: null as null | { message: string } },
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  dispatched: 0,
}))

vi.mock("@/lib/auth/require-staff-route", () => ({
  requireStaffRoute: async () => (st.staffDenied ? new Response(JSON.stringify({ error: "Not authorized" }), { status: 403 }) : null),
}))
vi.mock("@/lib/supabase/server", () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: "u1", app_metadata: { role: "admin" } } } }) } }) }))
vi.mock("@/lib/auth", () => ({ isStaffUser: () => st.isStaff }))
vi.mock("@/lib/messaging/send-dispatcher", () => ({
  dispatchWhatsAppMessage: async () => {
    st.dispatched++
    return { ok: true, result: {} }
  },
}))
vi.mock("@/lib/messaging/attachment-staging", () => ({ resolveWhatsAppAttachmentUrl: async () => "https://x/y" }))
vi.mock("@/lib/gmail", () => ({ gmailPost: vi.fn(), extractBody: vi.fn() }))
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const c: Record<string, unknown> = {}
      for (const op of ["select", "eq"]) c[op] = () => c
      const one = async () => (table === "messaging_groups" ? { data: st.group, error: null } : { data: st.provider ? { provider: st.provider } : null, error: null })
      c.single = one
      c.maybeSingle = one
      return c
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      st.rpcCalls.push({ fn, args })
      return st.rpc
    },
  },
}))

import { POST } from "@/app/api/inbox/reply/route"

const call = async (body: Record<string, unknown>) => {
  const res = await POST({ json: async () => body } as never)
  return { status: res.status, body: await res.json() }
}
const wa = (over: Record<string, unknown> = {}) => ({ conversationId: GROUP, message: "Ciao!", channel: "whatsapp", clientMsgId: "draft-1234-5678", ...over })

beforeEach(() => {
  st.staffDenied = false
  st.isStaff = true
  st.group = { external_group_id: "17274234285@c.us", channel_id: CHANNEL }
  st.provider = "wabridge"
  st.rpc = { data: { ok: true, id: "ob1", status: "shadow" }, error: null }
  st.rpcCalls = []
  st.dispatched = 0
})

describe("POST /api/inbox/reply on the self-hosted WhatsApp line", () => {
  it("queues the reply through the database rules and NEVER calls the inline sender", async () => {
    const r = await call(wa())
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ success: true, queued: true, status: "shadow", outboxId: "ob1", duplicate: false })
    expect(st.dispatched).toBe(0)
    expect(st.rpcCalls[0]).toEqual({
      fn: "wabridge_enqueue_reply",
      args: { p_group_id: GROUP, p_body: "Ciao!", p_client_msg_id: "draft-1234-5678", p_created_by: "u1" },
    })
  })
  it("refuses a portal client / partner (not TD staff) before touching the queue", async () => {
    st.isStaff = false
    const r = await call(wa())
    expect(r.status).toBe(403)
    expect(st.rpcCalls).toHaveLength(0)
    expect(st.dispatched).toBe(0)
  })
  it("refuses attachments (text only) without silently dropping them", async () => {
    const r = await call(wa({ attachmentPath: "whatsapp-new/abc.pdf" }))
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/text only/i)
    expect(st.rpcCalls).toHaveLength(0)
  })
  it("passes a missing client id on as empty so the database refuses it (a retry must never send twice)", async () => {
    st.rpc = { data: { ok: false, code: "bad_request", message: "Missing message id — please reload the page and try again." }, error: null }
    const r = await call(wa({ clientMsgId: undefined }))
    expect(r.status).toBe(400)
    expect(st.rpcCalls[0].args.p_client_msg_id).toBe("")
  })
  it("turns each rule refusal into a plain 409 with the database's own wording", async () => {
    for (const code of ["paused", "no_inbound", "not_allowed", "inactive", "not_one_to_one"]) {
      st.rpc = { data: { ok: false, code, message: `refused: ${code}` }, error: null }
      const r = await call(wa())
      expect(r.status).toBe(409)
      expect(r.body.error).toBe(`refused: ${code}`)
    }
  })
  it("a database error or an unreadable answer is a refusal, never a queued message", async () => {
    st.rpc = { data: null, error: { message: "boom" } }
    let r = await call(wa())
    expect(r.status).toBe(500)
    expect(r.body.success).toBeUndefined()
    expect(JSON.stringify(r.body)).not.toContain("boom")
    st.rpc = { data: { ok: true }, error: null }
    r = await call(wa())
    expect(r.body.success).toBeUndefined()
  })
  it("returns the ORIGINAL row for a retry of the same draft", async () => {
    st.rpc = { data: { ok: true, id: "ob1", status: "queued", duplicate: true }, error: null }
    const r = await call(wa())
    expect(r.body).toMatchObject({ success: true, duplicate: true, outboxId: "ob1" })
  })
  it("another provider still uses the dispatcher, unchanged", async () => {
    st.provider = "twochat"
    const r = await call(wa())
    expect(st.dispatched).toBe(1)
    expect(st.rpcCalls).toHaveLength(0)
    expect(r.status).toBe(200)
  })
})
