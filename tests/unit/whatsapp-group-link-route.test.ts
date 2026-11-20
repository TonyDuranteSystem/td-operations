import { describe, it, expect, vi, beforeEach } from "vitest"

const state = vi.hoisted(() => ({
  group: null as null | Record<string, unknown>,
  account: null as null | Record<string, unknown>,
  updates: [] as Array<Record<string, unknown>>,
  updateError: null as null | { message: string },
  denied: false,
}))

vi.mock("@/lib/auth/require-staff-route", () => ({
  requireStaffRoute: async () => (state.denied ? new Response(JSON.stringify({ error: "no" }), { status: 403 }) : null),
}))
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const c: Record<string, unknown> = {}
      c.select = () => c
      c.eq = () => c
      c.update = (patch: Record<string, unknown>) => { state.updates.push(patch); return { eq: async () => ({ error: state.updateError }) } }
      c.maybeSingle = async () => ({ data: table === "messaging_groups" ? state.group : state.account, error: null })
      return c
    },
  },
}))

import { GET, POST } from "@/app/api/inbox/whatsapp/group-link/route"

const post = (body: unknown) => POST(new Request("http://x/api", { method: "POST", body: JSON.stringify(body) }) as never)
const get = (q: string) => GET({ nextUrl: new URL(`http://x/api?${q}`) } as never)

beforeEach(() => {
  state.group = { id: "g1", external_group_id: "120363432541591903@g.us", account_id: null }
  state.account = { id: "a1", company_name: "Acme LLC" }
  state.updates = []
  state.updateError = null
  state.denied = false
})

describe("group-link route", () => {
  it("links a WhatsApp group to a company and returns the company name; never renames the group", async () => {
    const res = await post({ groupId: "g1", accountId: "a1" })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ accountId: "a1", accountName: "Acme LLC" })
    expect(state.updates).toEqual([{ account_id: "a1" }])
  })
  it("unlinks with null", async () => {
    const res = await post({ groupId: "g1", accountId: null })
    expect(await res.json()).toEqual({ accountId: null, accountName: null })
    expect(state.updates).toEqual([{ account_id: null }])
  })
  it("refuses a one-to-one chat (those link through the match bar), a missing company and bad input", async () => {
    state.group = { id: "g1", external_group_id: "393331234567@c.us", account_id: null }
    expect((await post({ groupId: "g1", accountId: "a1" })).status).toBe(400)
    state.group = { id: "g1", external_group_id: "120363432541591903@g.us", account_id: null }
    state.account = null
    expect((await post({ groupId: "g1", accountId: "zzz" })).status).toBe(404)
    expect((await post({ groupId: "g1" })).status).toBe(400)
    expect((await post({ accountId: "a1" })).status).toBe(400)
    expect(state.updates).toEqual([])
  })
  it("a failed save is an error, not a success", async () => {
    state.updateError = { message: "boom" }
    expect((await post({ groupId: "g1", accountId: "a1" })).status).toBe(500)
  })
  it("staff only", async () => {
    state.denied = true
    expect((await post({ groupId: "g1", accountId: "a1" })).status).toBe(403)
    expect((await get("groupId=g1")).status).toBe(403)
  })
  it("GET says whether this is a group and which company it has", async () => {
    state.group = { id: "g1", external_group_id: "120363432541591903@g.us", account_id: "a1" }
    expect(await (await get("groupId=g1")).json()).toEqual({ isGroup: true, accountId: "a1", accountName: "Acme LLC" })
    state.group = { id: "g2", external_group_id: "393331234567@c.us", account_id: null }
    expect((await (await get("groupId=g2")).json()).isGroup).toBe(false)
  })
})
