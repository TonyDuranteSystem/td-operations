import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const state = vi.hoisted(() => ({
  channels: [{ id: "c1" }, { id: "c2" }] as Array<{ id: string }>,
  channelError: null as null | { message: string },
  rpc: {} as Record<string, { data: unknown; error: null | { message: string } }>,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  logs: [] as Array<Record<string, unknown>>,
}))

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: () => {
      const c: Record<string, unknown> = {}
      c.select = () => c
      c.eq = () => c
      c.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: state.channels, error: state.channelError }).then(resolve)
      return c
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ fn, args })
      return state.rpc[args.p_channel_id as string] ?? { data: {}, error: null }
    },
  },
}))
vi.mock("@/lib/cron-log", () => ({ logCron: (l: Record<string, unknown>) => state.logs.push(l) }))

import { GET } from "@/app/api/cron/wa-bridge-link/route"

const call = async (auth?: string) => {
  const headers = new Headers()
  if (auth) headers.set("authorization", auth)
  const res = await GET({ headers } as never)
  return { status: res.status, body: await res.json() }
}

const OLD_SECRET = process.env.CRON_SECRET
beforeEach(() => {
  process.env.CRON_SECRET = "s3cret"
  state.channels = [{ id: "c1" }, { id: "c2" }]
  state.channelError = null
  state.rpc = {}
  state.rpcCalls = []
  state.logs = []
})
afterEach(() => {
  if (OLD_SECRET === undefined) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = OLD_SECRET
})

describe("GET /api/cron/wa-bridge-link", () => {
  it("fails CLOSED: no secret configured means nobody may run it, even with no header", async () => {
    delete process.env.CRON_SECRET
    expect((await call()).status).toBe(401)
    expect((await call("Bearer ")).status).toBe(401)
    expect(state.rpcCalls).toHaveLength(0)
  })

  it("rejects a missing or wrong bearer token", async () => {
    expect((await call()).status).toBe(401)
    expect((await call("Bearer nope")).status).toBe(401)
    expect(state.rpcCalls).toHaveLength(0)
  })

  it("sweeps every active bridge channel and totals the chats it linked", async () => {
    state.rpc = {
      c1: { data: { linked: 3, mismatch: 1, waiting: 2, none: 10 }, error: null },
      c2: { data: { linked: 2, ambiguous: 1, none: 4 }, error: null },
    }
    const r = await call("Bearer s3cret")
    expect(r).toMatchObject({ status: 200, body: { ok: true, channels: 2, linked: 5 } })
    // chats the rules HELD BACK are visible, not silently dropped
    expect(r.body.outcomes).toEqual({ linked: 5, mismatch: 1, waiting: 2, none: 14, ambiguous: 1 })
    expect(state.logs[0]).toMatchObject({ details: { outcomes: { mismatch: 1, waiting: 2, ambiguous: 1 } } })
    expect(state.rpcCalls).toEqual([
      { fn: "wabridge_link_unlinked", args: { p_channel_id: "c1" } },
      { fn: "wabridge_link_unlinked", args: { p_channel_id: "c2" } },
    ])
    expect(state.logs[0]).toMatchObject({ endpoint: "/api/cron/wa-bridge-link", status: "success" })
  })

  it("is a clean no-op when there is no bridge channel", async () => {
    state.channels = []
    expect((await call("Bearer s3cret")).body).toMatchObject({ ok: true, channels: 0, linked: 0 })
    expect(state.rpcCalls).toHaveLength(0)
  })

  it("reports a database failure as a 500 and logs it", async () => {
    state.rpc = { c1: { data: null, error: { message: "db down" } } }
    const r = await call("Bearer s3cret")
    expect(r.status).toBe(500)
    expect(state.logs[0]).toMatchObject({ status: "error" })
    state.channelError = { message: "channels down" }
    expect((await call("Bearer s3cret")).status).toBe(500)
  })
})
