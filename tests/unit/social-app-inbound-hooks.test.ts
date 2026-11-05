/**
 * TD Social — the two places a new WhatsApp message or a new email can reach a phone (dev job 2072bc3e, Step 2 pull request D):
 *   the WhatsApp bridge route (a single live message, and a live catch-up batch), and the mail save (`indexThread`).
 * These run the REAL candidate rules and stop at the working part, so they prove what reaches a phone and what never does.
 * Every case also proves the save itself is never harmed by an alert.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createHmac } from "crypto"

const CHANNEL = "d884daf4-450f-4bf4-a514-e6a7066c697b"
const SECRET = "channel-secret"

const { runInboundJobsLive, ingestAnswers, gmailGet, upsert } = vi.hoisted(() => ({
  runInboundJobsLive: vi.fn(),
  ingestAnswers: [] as Array<{ data: unknown; error: null | { message: string } }>,
  gmailGet: vi.fn(),
  upsert: vi.fn(),
}))

vi.mock("@/lib/app/inbound-alerts-live", () => ({ runInboundJobsLive }))
vi.mock("@/lib/ui-events", () => ({ emitUiEvent: async () => undefined }))
vi.mock("@/lib/messaging/groups", () => ({
  findOrCreateWhatsAppGroup: async (p: { remoteIdentifier: string }) => ({ group: { id: `g-${p.remoteIdentifier}` } }),
}))
vi.mock("@/lib/gmail", async () => ({ ...(await vi.importActual<typeof import("@/lib/gmail")>("@/lib/gmail")), gmailGet }))
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "email_index") return { upsert }
      const c: Record<string, unknown> = {}
      for (const op of ["select", "eq"]) c[op] = () => c
      c.maybeSingle = async () => ({ data: { id: CHANNEL, provider: "wabridge", is_active: true, webhook_secret: SECRET }, error: null })
      return c
    },
    rpc: async (fn: string) => {
      if (fn === "wabridge_ingest_message") return ingestAnswers.shift() ?? { data: true, error: null }
      return { data: true, error: null }
    },
  },
}))

import { POST } from "@/app/api/wa-bridge/[channelId]/route"
import { indexThread, type CrmDirectory } from "@/lib/email-index/sync"

const sign = (raw: string) => "sha256=" + createHmac("sha256", SECRET).update(raw).digest("hex")
const call = async (payload: unknown) => {
  const raw = JSON.stringify(payload)
  const headers = new Headers({ "x-hub-signature-256": sign(raw) })
  const res = await POST({ text: async () => raw, headers } as never, { params: { channelId: CHANNEL } })
  return { status: res.status, body: await res.json() }
}

const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString()
const live = (over: Record<string, unknown> = {}) => ({
  event: "message",
  device_id: "17274521093@s.whatsapp.net",
  payload: { id: "M1", chat_id: "393331234567@s.whatsapp.net", timestamp: isoAgo(20_000), is_from_me: false, body: "Ciao", from_name: "Stefano", ...over },
})
const item = (over: Record<string, unknown> = {}) => ({ id: "H1", chat: "393339980702", from_me: false, ts: isoAgo(20_000), text: "ciao", media_type: "", chat_name: "Stefano", ...over })
const batch = (items: unknown[], over: Record<string, unknown> = {}) => ({ event: "bridge.backfill", ts: Date.now(), items, ...over })

const KEYS = ["APNS_KEY_ID", "APNS_TEAM_ID", "APNS_PRIVATE_KEY"] as const
const saved: Record<string, string | undefined> = {}
const setKey = () => { process.env.APNS_KEY_ID = "ABCDE12345"; process.env.APNS_TEAM_ID = "TEAM123456"; process.env.APNS_PRIVATE_KEY = "x" }

beforeEach(() => {
  runInboundJobsLive.mockReset(); runInboundJobsLive.mockResolvedValue(undefined)
  gmailGet.mockReset(); upsert.mockReset(); upsert.mockResolvedValue({ error: null })
  ingestAnswers.length = 0
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k] }
})
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
})

describe("the bridge route: a single live message", () => {
  it("a fresh customer message reaches the working part as one job for its chat", async () => {
    setKey()
    expect((await call(live())).status).toBe(200)
    expect(runInboundJobsLive).toHaveBeenCalledTimes(1)
    expect(runInboundJobsLive.mock.calls[0][0]).toEqual([
      { kind: "whatsapp_message", source: "whatsapp:g-393331234567", messageIds: ["M1"], tag: "whatsapp:g-393331234567", who: { groupId: "g-393331234567" } },
    ])
  })

  it("nothing happens without the Apple key", async () => {
    expect((await call(live())).status).toBe(200)
    expect(runInboundJobsLive).not.toHaveBeenCalled()
  })

  it("a redelivery (already stored) never alerts", async () => {
    setKey()
    ingestAnswers.push({ data: false, error: null })
    expect((await call(live())).body).toEqual({ ok: true, deduped: true })
    expect(runInboundJobsLive).not.toHaveBeenCalled()
  })

  it("our own reply, an old message and a message with no real time stamp never alert", async () => {
    setKey()
    await call(live({ is_from_me: true }))
    await call(live({ timestamp: isoAgo(2 * 3_600_000) }))
    await call(live({ timestamp: undefined })) // defaulted to "now": looks fresh, must not count
    await call(live({ timestamp: "garbage" }))
    expect(runInboundJobsLive).not.toHaveBeenCalled()
  })

  it("a failing alert never fails the save (GOWA must not retry a message that was saved)", async () => {
    setKey()
    runInboundJobsLive.mockRejectedValue(new Error("boom"))
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined)
    expect(await call(live())).toEqual({ status: 200, body: { ok: true } })
    spy.mockRestore()
  })
})

describe("the bridge route: a live catch-up batch", () => {
  it("one job per chat — the newest fresh message of each — even for many messages", async () => {
    setKey()
    const items = [
      item({ id: "A1", chat: "393330000001", ts: isoAgo(60_000) }),
      item({ id: "A2", chat: "393330000001", ts: isoAgo(30_000) }),
      item({ id: "B1", chat: "393330000002", ts: isoAgo(40_000) }),
      item({ id: "OLD", chat: "393330000003", ts: isoAgo(3 * 3_600_000) }),
      item({ id: "MINE", chat: "393330000004", from_me: true, ts: isoAgo(10_000) }),
    ]
    expect((await call(batch(items, { live: true }))).status).toBe(200)
    expect(runInboundJobsLive).toHaveBeenCalledTimes(1)
    const jobs = runInboundJobsLive.mock.calls[0][0] as Array<{ source: string; messageIds: string[] }>
    expect(jobs.map(j => [j.source, j.messageIds])).toEqual([
      ["whatsapp:g-393330000001", ["A2"]],
      ["whatsapp:g-393330000002", ["B1"]],
    ])
  })

  it("a history download (not marked live) never alerts, however recent the messages look", async () => {
    setKey()
    await call(batch([item({ id: "H9", ts: isoAgo(10_000) })]))
    expect(runInboundJobsLive).not.toHaveBeenCalled()
  })

  it("a message already stored (the Mac retried the batch) never alerts again", async () => {
    setKey()
    ingestAnswers.push({ data: false, error: null })
    await call(batch([item({ id: "R1" })], { live: true }))
    expect(runInboundJobsLive).not.toHaveBeenCalled()
  })

  it("if the batch fails half-way, the messages that WERE saved still alert (the retry will see them as already stored)", async () => {
    setKey()
    ingestAnswers.push({ data: true, error: null }, { data: null, error: { message: "db down" } })
    const r = await call(batch([item({ id: "S1", chat: "393330000001" }), item({ id: "S2", chat: "393330000002" })], { live: true }))
    expect(r.status).toBe(500)
    expect(runInboundJobsLive).toHaveBeenCalledTimes(1)
    expect((runInboundJobsLive.mock.calls[0][0] as Array<{ messageIds: string[] }>).map(j => j.messageIds)).toEqual([["S1"]])
  })

  it("no key: no alert and the response is unchanged", async () => {
    const r = await call(batch([item()], { live: true }))
    expect(r.body).toMatchObject({ ok: true, inserted: 1, deduped: 0, skipped: 0 })
    expect(runInboundJobsLive).not.toHaveBeenCalled()
  })
})

describe("the mail save (indexThread)", () => {
  const dir: CrmDirectory = { contacts: new Map([["client@example.com", { contact_id: "c1", account_id: "a1" }]]), leads: new Map() }
  const gmailMessage = (over: Record<string, unknown> = {}) => ({
    id: "g1", threadId: "t1", snippet: "hello", labelIds: ["INBOX", "UNREAD"], internalDate: String(Date.now() - 60_000),
    payload: { mimeType: "text/plain", headers: [{ name: "From", value: "Client <client@example.com>" }, { name: "To", value: "support@tonydurante.us" }, { name: "Subject", value: "Wire 48,210" }] },
    ...over,
  })

  it("a new unread message from a client reaches the working part as ONE job, after the save", async () => {
    setKey()
    gmailGet.mockResolvedValue({ messages: [gmailMessage()] })
    expect(await indexThread("support", "t1", dir)).toBe(1)
    expect(upsert).toHaveBeenCalledTimes(1)
    expect(runInboundJobsLive).toHaveBeenCalledTimes(1)
    expect(runInboundJobsLive.mock.calls[0][0]).toEqual([
      { kind: "email_message", source: "email:support", messageIds: ["g1"], place: "support", tag: "email:support:t1", who: { contactId: "c1", leadId: null, accountId: "a1" } },
    ])
    // the lock screen never gets the subject
    expect(JSON.stringify(runInboundJobsLive.mock.calls[0][0])).not.toContain("48,210")
  })

  it("re-saving an old thread (a backfill, the 10-minute job, a re-index) sends nothing", async () => {
    setKey()
    gmailGet.mockResolvedValue({ messages: [
      gmailMessage({ id: "o1", internalDate: String(Date.now() - 3 * 86_400_000) }),
      gmailMessage({ id: "o2", labelIds: ["INBOX"] }),
    ] })
    expect(await indexThread("support", "t1", dir)).toBe(2)
    expect(runInboundJobsLive).not.toHaveBeenCalled()
  })

  it("our own sent reply does not alert", async () => {
    setKey()
    gmailGet.mockResolvedValue({ messages: [gmailMessage({
      labelIds: ["SENT"], payload: { mimeType: "text/plain", headers: [{ name: "From", value: "support@tonydurante.us" }, { name: "To", value: "client@example.com" }] },
    })] })
    await indexThread("support", "t1", dir)
    expect(runInboundJobsLive).not.toHaveBeenCalled()
  })

  it("no key: the save is exactly as before and nothing is alerted", async () => {
    gmailGet.mockResolvedValue({ messages: [gmailMessage()] })
    expect(await indexThread("support", "t1", dir)).toBe(1)
    expect(runInboundJobsLive).not.toHaveBeenCalled()
  })

  it("a failed save alerts nobody (nothing was stored, so the next sync will find it)", async () => {
    setKey()
    gmailGet.mockResolvedValue({ messages: [gmailMessage()] })
    upsert.mockResolvedValue({ error: { message: "db down" } })
    await expect(indexThread("support", "t1", dir)).rejects.toThrow("email_index upsert failed")
    expect(runInboundJobsLive).not.toHaveBeenCalled()
  })

  it("a failing alert never fails the save", async () => {
    setKey()
    runInboundJobsLive.mockRejectedValue(new Error("boom"))
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined)
    gmailGet.mockResolvedValue({ messages: [gmailMessage()] })
    await expect(indexThread("support", "t1", dir)).resolves.toBe(1)
    spy.mockRestore()
  })
})
