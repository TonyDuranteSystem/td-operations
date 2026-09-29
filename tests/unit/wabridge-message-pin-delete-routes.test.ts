import { describe, it, expect, vi, beforeEach } from "vitest"

const st = vi.hoisted(() => ({
  isStaff: true,
  message: { id: "m1", deleted_at: null as string | null } as Record<string, unknown> | null,
  updateCalls: [] as Array<Record<string, unknown>>,
  updateError: null as null | { message: string },
}))

vi.mock("@/lib/supabase/server", () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: "u1", app_metadata: { role: st.isStaff ? "admin" : "partner" } } } }) } }) }))
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: st.message, error: null }) }) }),
      update: (payload: Record<string, unknown>) => {
        st.updateCalls.push(payload)
        return { eq: async () => ({ error: st.updateError }) }
      },
    }),
  },
}))

import { POST as pinPOST } from "@/app/api/inbox/whatsapp/message/[id]/pin/route"
import { DELETE } from "@/app/api/inbox/whatsapp/message/[id]/route"

beforeEach(() => {
  st.isStaff = true
  st.message = { id: "m1", deleted_at: null }
  st.updateCalls = []
  st.updateError = null
})

describe("POST /api/inbox/whatsapp/message/[id]/pin", () => {
  const call = (pinned: boolean) => pinPOST({ json: async () => ({ pinned }) } as never, { params: { id: "m1" } })

  it("pins, storing a real timestamp", async () => {
    const res = await call(true)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, pinned: true })
    expect(typeof st.updateCalls[0].pinned_at).toBe("string")
  })
  it("unpins, clearing the timestamp", async () => {
    const res = await call(false)
    expect(res.status).toBe(200)
    expect(st.updateCalls[0].pinned_at).toBeNull()
  })
  it("refuses a non-staff caller", async () => {
    st.isStaff = false
    const res = await call(true)
    expect(res.status).toBe(403)
    expect(st.updateCalls).toHaveLength(0)
  })
  it("a missing message is a 404", async () => {
    st.message = null
    const res = await call(true)
    expect(res.status).toBe(404)
  })
  it("cannot pin an already-hidden message", async () => {
    st.message = { id: "m1", deleted_at: "2026-01-01T00:00:00Z" }
    const res = await call(true)
    expect(res.status).toBe(409)
    expect(st.updateCalls).toHaveLength(0)
  })
})

describe("DELETE /api/inbox/whatsapp/message/[id] (hide from our view — never a real WhatsApp unsend)", () => {
  const call = () => DELETE({} as never, { params: { id: "m1" } })

  it("hides the message, stamping who and when", async () => {
    const res = await call()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(st.updateCalls[0]).toMatchObject({ deleted_by: "u1" })
    expect(typeof st.updateCalls[0].deleted_at).toBe("string")
  })
  it("refuses a non-staff caller", async () => {
    st.isStaff = false
    const res = await call()
    expect(res.status).toBe(403)
    expect(st.updateCalls).toHaveLength(0)
  })
  it("a missing message is a 404", async () => {
    st.message = null
    const res = await call()
    expect(res.status).toBe(404)
  })
  it("refuses hiding an already-hidden message a second time", async () => {
    st.message = { id: "m1", deleted_at: "2026-01-01T00:00:00Z" }
    const res = await call()
    expect(res.status).toBe(409)
    expect(st.updateCalls).toHaveLength(0)
  })
})
