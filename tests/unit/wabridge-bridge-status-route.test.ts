import { describe, it, expect, vi, beforeEach } from "vitest"

const CH = "4cb021ab-1731-49b8-9d27-6483d2dae4f1"
const st = vi.hoisted(() => ({
  staffDenied: false,
  owner: true,
  channels: [{ id: "4cb021ab-1731-49b8-9d27-6483d2dae4f1" }] as Array<{ id: string }>,
  states: [] as Array<Record<string, unknown>>,
  channelError: null as null | { message: string },
}))

vi.mock("@/lib/auth/require-staff-route", () => ({
  requireStaffRoute: async () => (st.staffDenied ? new Response(JSON.stringify({ error: "Not authorized" }), { status: 403 }) : null),
}))
vi.mock("@/lib/supabase/server", () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: { email: "x" } } }) } }) }))
vi.mock("@/lib/auth", () => ({ isOwnerOnly: () => st.owner }))
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const result = () =>
        table === "messaging_channels"
          ? { data: st.channelError ? null : st.channels, error: st.channelError }
          : { data: st.states, error: null }
      const c: Record<string, unknown> = {}
      for (const op of ["select", "eq", "in"]) c[op] = () => c
      c.then = (resolve: (v: unknown) => unknown) => resolve(result())
      return c
    },
  },
}))

import { GET } from "@/app/api/inbox/whatsapp/bridge-status/route"

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()
const healthy = () => ({ channel_id: CH, last_heartbeat_at: iso(30_000), reachable: true, connected: true, logged_in: true, bad_beats: 0 })
const unlinked = (over: Record<string, unknown> = {}) => ({
  channel_id: CH, last_heartbeat_at: iso(30_000), reachable: true, connected: false, logged_in: false, bad_beats: 3,
  link_code: "AB12-CD34", link_code_at: iso(20_000), ...over,
})
const get = async () => {
  const res = await GET()
  return { status: res.status, body: await res.json(), cache: res.headers.get("cache-control") }
}

beforeEach(() => {
  st.staffDenied = false
  st.owner = true
  st.channels = [{ id: CH }]
  st.states = [healthy()]
  st.channelError = null
})

describe("GET /api/inbox/whatsapp/bridge-status", () => {
  it("refuses non-staff and reveals nothing", async () => {
    st.staffDenied = true
    const r = await get()
    expect(r.status).toBe(403)
  })
  it("healthy: no banner data and no code", async () => {
    const r = await get()
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ health: "ok", code: null, reason: null })
    expect(r.cache).toBe("no-store")
  })
  it("no wabridge channel at all → health none", async () => {
    st.channels = []
    expect((await get()).body).toMatchObject({ health: "none" })
  })
  it("unlinked + owner + fresh code → the owner sees the code, with the reason and the not-cached header", async () => {
    st.states = [unlinked()]
    const r = await get()
    expect(r.body).toMatchObject({ health: "unlinked", isOwner: true, code: "AB12-CD34" })
    expect(r.body.reason).toMatch(/unlinked/i)
    expect(r.cache).toBe("no-store")
  })
  it("unlinked but the caller is NOT the owner → no code (other staff see the problem, never the credential)", async () => {
    st.owner = false
    st.states = [unlinked()]
    const r = await get()
    expect(r.body).toMatchObject({ health: "unlinked", isOwner: false, code: null })
    expect(JSON.stringify(r.body)).not.toContain("AB12")
  })
  it("an expired code is not shown", async () => {
    st.states = [unlinked({ link_code_at: iso(5 * 60_000) })]
    expect((await get()).body.code).toBeNull()
  })
  it("a code left in the row after the device is linked again is never shown", async () => {
    st.states = [{ ...healthy(), link_code: "AB12-CD34", link_code_at: iso(10_000) }]
    const r = await get()
    expect(r.body).toMatchObject({ health: "ok", code: null })
  })
  it("other problems (offline) show wording but no code", async () => {
    st.states = [{ ...unlinked(), last_heartbeat_at: iso(20 * 60_000) }]
    const r = await get()
    expect(r.body.health).toBe("offline")
    expect(r.body.code).toBeNull()
    expect(r.body.hint).toBeTruthy()
  })
  it("the OWNER also gets the pause switch position, approved numbers and pacing; other staff never do", async () => {
    st.states = [{ ...healthy(), send_mode: "live", send_allowlist: ["17274234285"], send_min_gap_seconds: 60, send_hourly_cap: 10, send_daily_cap: 5, send_distinct_per_hour: 6, send_same_body_per_hour: 2 }]
    const owner = await get()
    expect(owner.body.send).toEqual({
      mode: "live",
      allowlist: ["17274234285"],
      pacing: { minGapSeconds: 60, hourlyCap: 10, dailyCap: 5, distinctPerHour: 6, sameBodyPerHour: 2 },
    })
    st.owner = false
    const staff = await get()
    expect(staff.body.send).toBeNull()
    expect(JSON.stringify(staff.body)).not.toContain("17274234285")
  })
  it("an unreadable send mode is shown as paused (fail closed)", async () => {
    st.states = [{ ...healthy(), send_mode: "LIVE!!", send_allowlist: [] }]
    expect((await get()).body.send.mode).toBe("paused")
  })
  it("a database failure is a generic 500 that leaks no detail", async () => {
    st.channelError = { message: "secret db detail" }
    const r = await get()
    expect(r.status).toBe(500)
    expect(JSON.stringify(r.body)).not.toContain("secret")
    expect(r.cache).toBe("no-store")
  })
})
