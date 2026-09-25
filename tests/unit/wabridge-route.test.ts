import { describe, it, expect, vi, beforeEach } from "vitest"
import { createHmac } from "crypto"

const CHANNEL = "d884daf4-450f-4bf4-a514-e6a7066c697b"
const SECRET = "channel-secret"

const state = vi.hoisted(() => ({
  channel: null as null | Record<string, unknown>,
  channelError: null as null | { message: string },
  group: { id: "g1" } as { id: string } | { error: string },
  rpcResult: { data: true as unknown, error: null as null | { message: string } },
  rpcOverrides: {} as Record<string, { data: unknown; error: null | { message: string } }>,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  groupCalls: [] as Array<Record<string, unknown>>,
  channelLookups: 0,
}))

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: () => {
      const c: Record<string, unknown> = {}
      for (const op of ["select", "eq"]) c[op] = () => c
      c.maybeSingle = async () => {
        state.channelLookups++
        return { data: state.channel, error: state.channelError }
      }
      return c
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ fn, args })
      return state.rpcOverrides[fn] ?? state.rpcResult
    },
  },
}))
vi.mock("@/lib/messaging/groups", () => ({
  findOrCreateWhatsAppGroup: async (p: Record<string, unknown>) => {
    state.groupCalls.push(p)
    return "error" in state.group ? { error: state.group.error } : { group: state.group }
  },
}))

import { POST } from "@/app/api/wa-bridge/[channelId]/route"

const sign = (raw: string, secret = SECRET) => "sha256=" + createHmac("sha256", secret).update(raw).digest("hex")
const call = async (payload: unknown, opts: { sig?: string | null; raw?: string; channelId?: string; contentLength?: string } = {}) => {
  const raw = opts.raw ?? JSON.stringify(payload)
  const headers = new Headers()
  const sig = opts.sig === undefined ? sign(raw) : opts.sig
  if (sig) headers.set("x-hub-signature-256", sig)
  if (opts.contentLength) headers.set("content-length", opts.contentLength)
  const res = await POST({ text: async () => raw, headers } as never, { params: { channelId: opts.channelId ?? CHANNEL } })
  return { status: res.status, body: await res.json() }
}

const goodMessage = (over: Record<string, unknown> = {}) => ({
  event: "message",
  device_id: "17274521093@s.whatsapp.net",
  payload: { id: "M1", chat_id: "393331234567@s.whatsapp.net", timestamp: "2026-09-24T17:59:00Z", is_from_me: false, body: "Ciao", from_name: "Stefano", ...over },
})
const beat = (over: Record<string, unknown> = {}) => ({
  event: "bridge.heartbeat", ts: Date.now(), reachable: true, connected: true, logged_in: true, ...over,
})
const item = (over: Record<string, unknown> = {}) => ({
  id: "H1", chat: "393339980702", from_me: false, ts: "2026-09-20T10:00:00Z", text: "vecchio", media_type: "", chat_name: "Stefano Stella", ...over,
})

beforeEach(() => {
  state.channel = { id: CHANNEL, provider: "wabridge", is_active: true, webhook_secret: SECRET }
  state.channelError = null
  state.group = { id: "g1" }
  state.rpcResult = { data: true, error: null }
  state.rpcOverrides = {}
  state.rpcCalls = []
  state.groupCalls = []
  state.channelLookups = 0
})

describe("POST /api/wa-bridge/[channelId] — live messages", () => {
  it("saves an inbound message through the atomic function (not a backfill)", async () => {
    const r = await call(goodMessage())
    expect(r).toEqual({ status: 200, body: { ok: true } })
    expect(state.rpcCalls).toHaveLength(1)
    expect(state.rpcCalls[0].fn).toBe("wabridge_ingest_message")
    expect(state.rpcCalls[0].args).toMatchObject({
      p_group_id: "g1", p_channel_id: CHANNEL, p_external_id: "M1", p_direction: "inbound",
      p_sender_phone: "+393331234567", p_content_type: "text", p_content_text: "Ciao",
      p_created_at: "2026-09-24T17:59:00.000Z", p_backfill: false,
    })
    expect(state.groupCalls[0]).toMatchObject({ channelId: CHANNEL, remoteIdentifier: "393331234567", groupName: "Stefano" })
  })

  it("a phone-typed message is stored outbound, with no sender phone and no group rename", async () => {
    await call(goodMessage({ is_from_me: true, from_name: "Antonio" }))
    expect(state.rpcCalls[0].args).toMatchObject({ p_direction: "outbound", p_sender_phone: null })
    expect(state.groupCalls[0].groupName).toBeNull()
  })

  it("reports a redelivery as deduped (a 200, so GOWA stops retrying)", async () => {
    state.rpcResult = { data: false, error: null }
    expect(await call(goodMessage())).toEqual({ status: 200, body: { ok: true, deduped: true } })
  })

  it("acknowledges ignored events (groups, reactions) with 200 and writes nothing", async () => {
    for (const p of [goodMessage({ chat_id: "1203630000@g.us" }), { event: "message.reaction", payload: {} }]) {
      const r = await call(p)
      expect(r.status).toBe(200)
      expect(r.body.skipped).toBeTruthy()
    }
    expect(state.rpcCalls).toHaveLength(0)
    expect(state.groupCalls).toHaveLength(0)
  })

  it("an @lid chat is dropped (200) but COUNTED — a lost lead is never silent", async () => {
    const r = await call(goodMessage({ chat_id: "251556368777322@lid" }))
    expect(r.status).toBe(200)
    expect(state.rpcCalls.map((c) => c.fn)).toEqual(["wabridge_count_dropped"])
    expect(state.groupCalls).toHaveLength(0)
  })

  it("returns 500 (so GOWA retries) when the database save fails, and when the group cannot be made", async () => {
    state.rpcResult = { data: null, error: { message: "boom" } }
    expect((await call(goodMessage())).status).toBe(500)
    state.group = { error: "group failed" }
    expect((await call(goodMessage())).status).toBe(500)
  })
})

describe("POST /api/wa-bridge/[channelId] — auth and channel checks", () => {
  it("rejects a missing, wrong or forged signature and never touches the database", async () => {
    for (const sig of [null, "sha256=" + "0".repeat(64), sign("{}", "other-secret")]) {
      expect((await call(goodMessage(), { sig })).status).toBe(401)
    }
    expect(state.rpcCalls).toHaveLength(0)
    expect(state.groupCalls).toHaveLength(0)
  })

  it("fails closed when the channel has no secret", async () => {
    state.channel = { ...state.channel, webhook_secret: null }
    expect((await call(goodMessage())).status).toBe(401)
    state.channel = { ...state.channel, webhook_secret: "" }
    expect((await call(goodMessage())).status).toBe(401)
  })

  it("404s an unknown channel and a channel that is not a bridge channel", async () => {
    state.channel = null
    expect((await call(goodMessage())).status).toBe(404)
    state.channel = { id: CHANNEL, provider: "twochat", is_active: true, webhook_secret: SECRET }
    expect((await call(goodMessage())).status).toBe(404)
  })

  it("a malformed channel id is a 404 WITHOUT touching the database (not a retried 500)", async () => {
    for (const id of ["not-a-uuid", "1234", "'; drop table x;--", ""]) {
      const r = await call(goodMessage(), { channelId: id })
      expect(r.status).toBe(404)
    }
    expect(state.channelLookups).toBe(0)
  })

  it("rejects an oversized body before doing any work", async () => {
    expect((await call(goodMessage(), { contentLength: "5000000" })).status).toBe(413)
    expect(state.channelLookups).toBe(0)
    expect((await call(null, { raw: "x".repeat(2_000_001), sig: "sha256=" + "0".repeat(64) })).status).toBe(413)
  })

  it("acknowledges but ignores everything when the channel is switched off", async () => {
    state.channel = { ...state.channel, is_active: false }
    const r = await call(goodMessage())
    expect(r.status).toBe(200)
    expect(state.rpcCalls).toHaveLength(0)
  })

  it("a signed but non-JSON body is a 400, not a crash", async () => {
    const raw = "not json"
    expect((await call(null, { raw, sig: sign(raw) })).status).toBe(400)
  })

  it("500s a channel lookup failure instead of leaking a 404", async () => {
    state.channelError = { message: "db down" }
    expect((await call(goodMessage())).status).toBe(500)
  })
})

describe("POST /api/wa-bridge/[channelId] — heartbeat", () => {
  it("records a fresh, signed, complete heartbeat through the atomic RPC and saves no message", async () => {
    const r = await call(beat({ connected: false, logged_in: true }))
    expect(r).toEqual({ status: 200, body: { ok: true, heartbeat: true } })
    expect(state.rpcCalls).toEqual([
      { fn: "wabridge_record_heartbeat", args: { p_channel_id: CHANNEL, p_reachable: true, p_connected: false, p_logged_in: true } },
    ])
    expect(state.groupCalls).toHaveLength(0)
  })

  it("rejects an UNSIGNED heartbeat (nobody can fake a healthy bridge)", async () => {
    expect((await call(beat(), { sig: "sha256=" + "0".repeat(64) })).status).toBe(401)
    expect(state.rpcCalls).toHaveLength(0)
  })

  it("rejects a REPLAYED (old) heartbeat even though its signature is valid", async () => {
    const r = await call(beat({ ts: Date.now() - 10 * 60_000 }))
    expect(r.status).toBe(400)
    expect(state.rpcCalls).toHaveLength(0)
  })

  it("rejects a heartbeat with a missing field instead of reading it as healthy", async () => {
    const r = await call(beat({ logged_in: undefined }))
    expect(r.status).toBe(400)
    expect(state.rpcCalls).toHaveLength(0)
  })

  it("500s when the heartbeat cannot be stored, so the Mac's next beat retries", async () => {
    state.rpcOverrides.wabridge_record_heartbeat = { data: null, error: { message: "db down" } }
    expect((await call(beat())).status).toBe(500)
  })
})

describe("POST /api/wa-bridge/[channelId] — history download (backfill)", () => {
  const batch = (items: unknown[], over: Record<string, unknown> = {}) => ({ event: "bridge.backfill", ts: Date.now(), items, ...over })

  it("saves history as a BACKFILL (no unread, no un-hiding) and counts inserted vs already-known", async () => {
    let n = 0
    state.rpcOverrides.wabridge_ingest_message = { data: null, error: null }
    // first item inserts, second is a duplicate
    const orig = state.rpcOverrides
    const r1 = await call(batch([item({ id: "H1" })]))
    expect(r1.status).toBe(200)
    expect(state.rpcCalls[0].args).toMatchObject({ p_backfill: true, p_external_id: "H1", p_direction: "inbound", p_created_at: "2026-09-20T10:00:00.000Z" })
    expect(r1.body).toMatchObject({ ok: true, inserted: 0, deduped: 1, skipped: 0 }) // mocked "false" => deduped
    state.rpcOverrides = orig
    state.rpcOverrides.wabridge_ingest_message = { data: true, error: null }
    state.rpcCalls = []
    const r2 = await call(batch([item({ id: "H2" }), item({ id: "H3", from_me: true })]))
    expect(r2.body).toMatchObject({ ok: true, inserted: 2, deduped: 0 })
    n = state.rpcCalls.filter((c) => c.fn === "wabridge_ingest_message").length
    expect(n).toBe(2)
    expect(state.rpcCalls[1].args).toMatchObject({ p_direction: "outbound", p_sender_phone: null, p_backfill: true })
  })

  it("a catch-up batch marked live:true is saved as LIVE (missed recent messages must count as unread)", async () => {
    await call(batch([item({ id: "CU1" })], { live: true }))
    expect(state.rpcCalls[0].args).toMatchObject({ p_external_id: "CU1", p_backfill: false })
    state.rpcCalls = []
    await call(batch([item({ id: "CU2" })], { live: "true" })) // only a real boolean true counts
    expect(state.rpcCalls[0].args).toMatchObject({ p_backfill: true })
  })

  it("makes ONE chat lookup per distinct chat in a batch, not one per message", async () => {
    await call(batch([item({ id: "A" }), item({ id: "B" }), item({ id: "C", chat: "393519330171" })]))
    expect(state.groupCalls.map((g) => g.remoteIdentifier)).toEqual(["393339980702", "393519330171"])
  })

  it("skips unusable rows and still saves the rest", async () => {
    const r = await call(batch([item({ id: undefined }), item({ id: "OK" }), { junk: true }]))
    expect(r.body).toMatchObject({ ok: true, inserted: 1, skipped: 2 })
  })

  it("rejects a stale (replayed) batch, an oversized batch and a non-array", async () => {
    expect((await call(batch([item()], { ts: Date.now() - 60 * 60_000 }))).status).toBe(400)
    expect((await call(batch(Array.from({ length: 201 }, (_, i) => item({ id: `X${i}` })))) ).status).toBe(400)
    expect((await call(batch([], { items: "nope" }))).status).toBe(400)
    expect(state.rpcCalls).toHaveLength(0)
  })

  it("500s on a database failure so the Mac retries the batch (dedupe makes that safe)", async () => {
    state.rpcOverrides.wabridge_ingest_message = { data: null, error: { message: "boom" } }
    expect((await call(batch([item()]))).status).toBe(500)
  })

  it("requires a valid signature like every other event", async () => {
    expect((await call(batch([item()]), { sig: "sha256=" + "0".repeat(64) })).status).toBe(401)
    expect(state.rpcCalls).toHaveLength(0)
  })
})

describe("POST /api/wa-bridge/[channelId] — saved contact names", () => {
  const names = (list: unknown, over: Record<string, unknown> = {}) => ({ event: "bridge.names", ts: Date.now(), names: list, ...over })

  it("passes the phone's names to the atomic name-sync function and reports how many chats changed", async () => {
    state.rpcOverrides.wabridge_apply_names = { data: 2, error: null }
    const list = [{ digits: "393339980702", name: "Stefano Stella" }, { digits: "393519330171", name: "Patrick Covelli" }]
    const r = await call(names(list))
    expect(r).toEqual({ status: 200, body: { ok: true, updated: 2 } })
    expect(state.rpcCalls[0]).toEqual({ fn: "wabridge_apply_names", args: { p_channel_id: CHANNEL, p_names: list } })
  })

  it("rejects stale, oversized or malformed batches and unsigned requests", async () => {
    expect((await call(names([], { ts: Date.now() - 60 * 60_000 }))).status).toBe(400)
    expect((await call(names(Array.from({ length: 501 }, () => ({ digits: "393339980702", name: "x" }))))).status).toBe(400)
    expect((await call(names("nope"))).status).toBe(400)
    expect((await call(names([]), { sig: "sha256=" + "0".repeat(64) })).status).toBe(401)
    expect(state.rpcCalls).toHaveLength(0)
  })

  it("500s when the name sync fails", async () => {
    state.rpcOverrides.wabridge_apply_names = { data: null, error: { message: "db down" } }
    expect((await call(names([{ digits: "393339980702", name: "x" }]))).status).toBe(500)
  })
})
