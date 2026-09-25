import { describe, it, expect, vi, beforeEach } from "vitest"

const st = vi.hoisted(() => ({
  staffDenied: false,
  messages: [] as Array<Record<string, unknown>>,
  provider: "wabridge" as string | null,
  outbox: [] as Array<Record<string, unknown>>,
  sendMode: "shadow" as unknown,
  outboxThrows: false,
  outboxStatusFilter: "" as string,
}))

vi.mock("@/lib/auth/require-staff-route", () => ({
  requireStaffRoute: async () => (st.staffDenied ? new Response(JSON.stringify({ error: "Not authorized" }), { status: 403 }) : null),
}))
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const c: Record<string, unknown> = {}
      for (const op of ["select", "eq", "order"]) c[op] = () => c
      c.neq = (_col: string, val: string) => {
        st.outboxStatusFilter = val
        return c
      }
      const rows = () => {
        if (table === "messages") return { data: st.messages, error: null }
        if (table === "wa_outbox") {
          if (st.outboxThrows) throw new Error("outbox exploded")
          return { data: st.outbox, error: null }
        }
        return { data: null, error: null }
      }
      c.then = (resolve: (v: unknown) => unknown) => resolve(rows())
      c.maybeSingle = async () => {
        if (table === "messaging_groups") return { data: { channel_id: "ch1" }, error: null }
        if (table === "messaging_channels") return { data: st.provider ? { provider: st.provider } : null, error: null }
        if (table === "wa_bridge_state") return { data: { send_mode: st.sendMode }, error: null }
        return { data: null, error: null }
      }
      return c
    },
  },
}))

import { GET } from "@/app/api/inbox/whatsapp/messages/[groupId]/route"

const get = async () => {
  const res = await GET({} as never, { params: { groupId: "g1" } })
  return { status: res.status, body: await res.json() }
}
const inbound = { id: "m1", content_text: "Ciao", direction: "inbound", sender_name: "Stefano", sender_phone: "+39", created_at: "2026-09-25T10:00:00Z", content_type: "text", media_url: null }

beforeEach(() => {
  st.staffDenied = false
  st.messages = [inbound]
  st.provider = "wabridge"
  st.outbox = []
  st.sendMode = "shadow"
  st.outboxThrows = false
  st.outboxStatusFilter = ""
})

describe("GET /api/inbox/whatsapp/messages/[groupId]", () => {
  it("refuses non-staff", async () => {
    st.staffDenied = true
    expect((await get()).status).toBe(403)
  })
  it("merges waiting / test-mode replies into the chat as 'TD Team', in time order, with their state", async () => {
    st.outbox = [
      { id: "o1", body: "Certo!", status: "shadow", created_at: "2026-09-25T10:05:00Z", error: null },
      { id: "o0", body: "Un attimo", status: "queued", created_at: "2026-09-25T09:59:00Z", error: null },
    ]
    const r = await get()
    expect(r.status).toBe(200)
    expect(r.body.messages.map((m: { id: string }) => m.id)).toEqual(["outbox:o0", "m1", "outbox:o1"])
    expect(r.body.messages[0]).toMatchObject({ direction: "outbound", sender_name: "TD Team", outbox_status: "queued", content_text: "Un attimo" })
    expect(r.body.messages[2].outbox_status).toBe("shadow")
  })
  it("asks the queue for everything EXCEPT sent messages (a sent reply is an ordinary message row — never shown twice)", async () => {
    await get()
    expect(st.outboxStatusFilter).toBe("sent")
  })
  it("tells the screen the send mode and whether the person has ever written", async () => {
    const r = await get()
    expect(r.body.send).toEqual({ mode: "shadow", hasInbound: true })
    st.messages = [{ ...inbound, direction: "outbound" }]
    expect((await get()).body.send).toEqual({ mode: "shadow", hasInbound: false })
  })
  it("an unreadable send mode is paused (fail closed)", async () => {
    st.sendMode = "LIVE!!"
    expect((await get()).body.send.mode).toBe("paused")
  })
  it("another provider: no overlay, no send info — the chat is untouched", async () => {
    st.provider = "twochat"
    st.outbox = [{ id: "o1", body: "x", status: "shadow", created_at: "2026-09-25T10:05:00Z", error: null }]
    const r = await get()
    expect(r.body.messages.map((m: { id: string }) => m.id)).toEqual(["m1"])
    expect(r.body.send).toBeNull()
  })
  it("a claimed reply shows as 'sending' for under 2 minutes, then 'unknown' with its id so a person can decide", async () => {
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
    st.outbox = [
      { id: "o1", body: "in flight", status: "unknown", created_at: "2026-09-25T10:04:00Z", claimed_at: ago(20_000), error: null },
      { id: "o2", body: "never confirmed", status: "unknown", created_at: "2026-09-25T10:05:00Z", claimed_at: ago(10 * 60_000), error: null },
    ]
    const r = await get()
    const byId = Object.fromEntries(r.body.messages.map((m: { id: string }) => [m.id, m]))
    expect(byId["outbox:o1"]).toMatchObject({ outbox_status: "sending", outbox_id: "o1" })
    expect(byId["outbox:o2"]).toMatchObject({ outbox_status: "unknown", outbox_id: "o2" })
  })
  it("a failure reading the queue never hides the chat itself", async () => {
    st.outboxThrows = true
    const r = await get()
    expect(r.status).toBe(200)
    expect(r.body.messages.map((m: { id: string }) => m.id)).toEqual(["m1"])
  })
})
