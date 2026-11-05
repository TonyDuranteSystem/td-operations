/**
 * TD Social — the phone leg, with a fake Apple (dev job 2072bc3e, Step 2 pull request C2). Every switch, every answer from Apple, every cap, and the rule that
 * a bad key or a slow Apple can never remove a phone.
 */
import { describe, it, expect, vi } from "vitest"
import crypto from "node:crypto"

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: {} }))
vi.mock("@/lib/app/phone-recipients", () => ({ staffRecipients: vi.fn(), marketingRecipients: vi.fn() }))
vi.mock("@/lib/app/phone-badge", () => ({ badgeForUser: vi.fn() }))

import { CONCURRENCY, LEG_DEADLINE_MS, MAX_PHONES, MAX_RECIPIENTS, SIDE_LOOKUP_MS, sendToPhones, type PhoneDeps, type PhoneRow } from "@/lib/app/send-to-phones"
import type { PhoneAlert } from "@/lib/app/phone-leg"
import type { ApnsAnswer, ApnsRequest } from "@/lib/app/apns"

const pair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" })
const KEY = { keyId: "ABCDE12345", teamId: "TEAM123456", privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString().trim() }
const BUNDLE = "com.tonydurante.tdsocial.sandbox"

const tok = (n: number) => n.toString(16).padStart(64, "0")
const phone = (n: number, user = "u1", env = "production"): PhoneRow => ({ id: `p${n}`, user_id: user, token: tok(n), bundle_id: BUNDLE, apns_env: env })

const alert = (over: Partial<PhoneAlert> = {}): PhoneAlert => ({
  source: "staff", userIds: ["u1", "u2"], kind: "client_chat", title: "Chat: Acme", body: "secret text", url: "/portal-chats", tag: "admin-chat-1", name: "Acme LLC", dm: false, ...over,
})

interface Harness {
  deps: PhoneDeps
  sent: Array<{ host: string; req: ApnsRequest }>
  revoked: Array<{ id: string; reason: string }>
  logs: string[]
  closed: string[]
  calls: Record<string, number>
}

function harness(opts: { answer?: (req: ApnsRequest, host: string) => ApnsAnswer | Promise<ApnsAnswer>; over?: Partial<PhoneDeps>; phones?: PhoneRow[] } = {}): Harness {
  const h: Harness = { deps: undefined as unknown as PhoneDeps, sent: [], revoked: [], logs: [], closed: [], calls: {} }
  const count = (k: string) => { h.calls[k] = (h.calls[k] ?? 0) + 1 }
  const phones = opts.phones ?? [phone(1), phone(2, "u2")]
  h.deps = {
    key: KEY,
    isOn: async () => { count("isOn"); return true },
    bundleId: BUNDLE,
    recipients: async a => { count("recipients"); return a.userIds },
    mutedTabs: async () => { count("mutedTabs"); return [] },
    phones: async (ids, bundle) => { count("phones"); return phones.filter(p => ids.includes(p.user_id) && p.bundle_id === bundle) },
    badge: async id => (id === "u1" ? 4 : 7),
    connect: host => {
      count("connect")
      return {
        send: async req => { h.sent.push({ host, req }); return opts.answer ? opts.answer(req, host) : { status: 200, reason: null } },
        close: () => { h.closed.push(host) },
      }
    },
    revoke: async (id, reason) => { h.revoked.push({ id, reason }) },
    now: () => 1_800_000_000_000,
    log: m => { h.logs.push(m) },
    ...opts.over,
  }
  return h
}

const body = (r: ApnsRequest) => JSON.parse(r.body)

describe("the switches, in order", () => {
  it("no key: nothing is asked, read or connected", async () => {
    const h = harness({ over: { key: null } })
    const r = await sendToPhones(alert(), h.deps)
    expect(r.skipped).toBe("no key")
    expect(h.calls).toEqual({})
  })

  it("switch off: stops before it reads any recipient or phone", async () => {
    const h = harness({ over: { isOn: async () => false } })
    const r = await sendToPhones(alert(), h.deps)
    expect(r.skipped).toBe("switched off")
    expect(h.calls.recipients).toBeUndefined()
    expect(h.calls.phones).toBeUndefined()
    expect(h.calls.connect).toBeUndefined()
  })

  it("a server that cannot tell which app it belongs to sends nothing", async () => {
    const h = harness({ over: { bundleId: null } })
    expect((await sendToPhones(alert(), h.deps)).skipped).toBe("unknown server")
    expect(h.calls.connect).toBeUndefined()
  })

  it("a kind that does not go to phones ends the leg before anyone is looked up", async () => {
    for (const a of [alert({ kind: "talk_room_message" }), alert({ kind: "claude_reply", dm: false }), alert({ kind: "shared_item", dm: false })]) {
      const h = harness()
      expect((await sendToPhones(a, h.deps)).skipped).toBe("kind not for phones")
      expect(h.calls.recipients).toBeUndefined()
    }
  })

  it("nobody left after the recipient re-check = nothing sent", async () => {
    const h = harness({ over: { recipients: async () => [] } })
    expect((await sendToPhones(alert(), h.deps)).skipped).toBe("no recipients")
    expect(h.calls.phones).toBeUndefined()
  })

  it("a person with no phone registered gets nothing, and nothing is connected", async () => {
    const h = harness({ phones: [] })
    expect((await sendToPhones(alert(), h.deps)).skipped).toBe("no phones")
    expect(h.calls.connect).toBeUndefined()
  })
})

describe("mutes", () => {
  it("a person who muted this alert's tab is skipped; the other still gets it", async () => {
    const h = harness({ over: { mutedTabs: async id => (id === "u1" ? ["portal"] : []) } })
    const r = await sendToPhones(alert(), h.deps)
    expect(r.sent).toBe(1)
    expect(h.sent.map(s => s.req.path)).toEqual([`/3/device/${tok(2)}`])
  })

  it("muting another tab changes nothing", async () => {
    const h = harness({ over: { mutedTabs: async () => ["whatsapp", "inbox"] } })
    expect((await sendToPhones(alert(), h.deps)).sent).toBe(2)
  })

  it("everybody muted = nothing sent", async () => {
    const h = harness({ over: { mutedTabs: async () => ["portal"] } })
    expect((await sendToPhones(alert(), h.deps)).skipped).toBe("all muted")
  })

  it("an alert with no tab (a staff note) never consults the mutes", async () => {
    const h = harness()
    await sendToPhones(alert({ kind: "staff_note" }), h.deps)
    expect(h.calls.mutedTabs).toBeUndefined()
  })
})

describe("what is sent", () => {
  it("one request per phone with the lock-screen words, the link, the group and each person's own number", async () => {
    const h = harness()
    const r = await sendToPhones(alert(), h.deps)
    expect(r).toMatchObject({ attempted: 2, sent: 2, gone: 0, failed: 0, stopped: false })
    const [a, b] = h.sent
    expect(a.host).toBe("api.push.apple.com")
    expect(a.req.headers["apns-topic"]).toBe(BUNDLE)
    expect(body(a.req)).toEqual({ aps: { alert: { title: "Chat: Acme LLC" }, sound: "default", "thread-id": "admin-chat-1", badge: 4 }, url: "/portal-chats" })
    expect(body(b.req).aps.badge).toBe(7)
  })

  it("the web title and body of a client alert never reach the phone", async () => {
    const h = harness()
    await sendToPhones(alert({ title: "Chat: Acme", body: "my EIN is 12-3456789" }), h.deps)
    for (const s of h.sent) expect(s.req.body).not.toContain("12-3456789")
  })

  it("the typed-text kind carries its text", async () => {
    const h = harness()
    await sendToPhones(alert({ kind: "talk_direct_message", title: "Luca", body: "see you at 3", dm: true }), h.deps)
    expect(body(h.sent[0].req).aps.alert).toEqual({ title: "Luca", body: "see you at 3" })
  })

  it("when the number cannot be counted the alert goes WITHOUT one (never a made-up 0)", async () => {
    const h = harness({ over: { badge: async () => null } })
    await sendToPhones(alert(), h.deps)
    for (const s of h.sent) expect("badge" in body(s.req).aps).toBe(false)
  })

  it("a number lookup that throws also just omits the number", async () => {
    const h = harness({ over: { badge: async () => { throw new Error("db down") } } })
    const r = await sendToPhones(alert(), h.deps)
    expect(r.sent).toBe(2)
    for (const s of h.sent) expect("badge" in body(s.req).aps).toBe(false)
  })

  it("sandbox-environment phones go to Apple's development address and live ones to the production address; each connection is closed", async () => {
    const h = harness({ phones: [phone(1, "u1", "development"), phone(2, "u2", "production")] })
    await sendToPhones(alert(), h.deps)
    expect(h.sent.map(s => s.host).sort()).toEqual(["api.push.apple.com", "api.sandbox.push.apple.com"])
    expect(h.closed.sort()).toEqual(["api.push.apple.com", "api.sandbox.push.apple.com"])
    expect(h.calls.connect).toBe(2)
  })

  it("a phone row that names any other environment is never sent to and never connected", async () => {
    const h = harness({ phones: [phone(1, "u1", "https://evil.example")] })
    const r = await sendToPhones(alert(), h.deps)
    expect(h.sent).toHaveLength(0)
    expect(h.calls.connect).toBeUndefined()
    expect(r.failed).toBe(1)
  })

  it("a phone row with a hostile token is never sent", async () => {
    const h = harness({ phones: [{ ...phone(1), token: "../../etc/passwd" }] })
    const r = await sendToPhones(alert(), h.deps)
    expect(h.sent).toHaveLength(0)
    expect(r.failed).toBe(1)
  })

  it("a phone of ANOTHER app is dropped even if the lookup returned it", async () => {
    const h = harness({ over: { phones: async () => [{ ...phone(1), bundle_id: "com.tonydurante.tdsocial" }, phone(2, "u2")] } })
    const r = await sendToPhones(alert(), h.deps)
    expect(r.sent).toBe(1)
  })

  it("an unreadable key stops before any connection, removes nothing", async () => {
    // a key id nobody signed with yet in this run, so the half-hour token cache cannot answer for it
    const h = harness({ over: { key: { keyId: "ZZZZZ99999", teamId: "ZZZZZ99999", privateKey: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----" } } })
    const r = await sendToPhones(alert(), h.deps)
    expect(r.skipped).toBe("signing failed")
    expect(h.calls.connect).toBeUndefined()
    expect(h.revoked).toEqual([])
  })
})

describe("caps", () => {
  it("at most MAX_RECIPIENTS people are looked up", async () => {
    let asked: string[] = []
    const h = harness({ over: { recipients: async a => a.userIds, phones: async ids => { asked = ids; return [] } } })
    await sendToPhones(alert({ userIds: Array.from({ length: 80 }, (_, i) => `u${i}`) }), h.deps)
    expect(asked).toHaveLength(MAX_RECIPIENTS)
  })

  it("at most MAX_PHONES requests go out", async () => {
    const many = Array.from({ length: MAX_PHONES + 40 }, (_, i) => phone(i + 1, "u1"))
    const h = harness({ phones: many, over: { recipients: async () => ["u1"] } })
    const r = await sendToPhones(alert(), h.deps)
    expect(r.attempted).toBe(MAX_PHONES)
  })

  it("never more than CONCURRENCY requests are in flight", async () => {
    let inFlight = 0, peak = 0
    const many = Array.from({ length: 30 }, (_, i) => phone(i + 1, "u1"))
    const h = harness({
      phones: many, over: { recipients: async () => ["u1"] },
      answer: async () => { inFlight++; peak = Math.max(peak, inFlight); await new Promise(r => setTimeout(r, 2)); inFlight--; return { status: 200, reason: null } },
    })
    await sendToPhones(alert(), h.deps)
    expect(peak).toBeLessThanOrEqual(CONCURRENCY)
    expect(peak).toBeGreaterThan(1)
  })
})

describe("Apple's answers: only 'gone' removes a phone", () => {
  const answers = (by: Record<string, ApnsAnswer>) => (req: ApnsRequest) => by[req.path.split("/").pop()!] ?? { status: 200, reason: null }

  it("410 removes it (marked revoked with Apple's reason); the other phone is still sent", async () => {
    const h = harness({ answer: answers({ [tok(1)]: { status: 410, reason: "Unregistered" } }) })
    const r = await sendToPhones(alert(), h.deps)
    expect(r).toMatchObject({ sent: 1, gone: 1, failed: 0 })
    expect(h.revoked).toEqual([{ id: "p1", reason: "apple_Unregistered" }])
  })

  it("400 BadDeviceToken and DeviceTokenNotForTopic remove it", async () => {
    for (const reason of ["BadDeviceToken", "DeviceTokenNotForTopic"]) {
      const h = harness({ answer: answers({ [tok(1)]: { status: 400, reason } }) })
      await sendToPhones(alert(), h.deps)
      expect(h.revoked).toEqual([{ id: "p1", reason: `apple_${reason}` }])
    }
  })

  it("any other 400, a 413, a 404 or a 500 keeps the phone", async () => {
    for (const a of [{ status: 400, reason: "BadTopic" }, { status: 400, reason: null }, { status: 413, reason: "PayloadTooLarge" }, { status: 404, reason: "BadPath" }, { status: 500, reason: "InternalServerError" }, { status: 503, reason: "ServiceUnavailable" }]) {
      const h = harness({ answer: () => a })
      const r = await sendToPhones(alert(), h.deps)
      expect(h.revoked, JSON.stringify(a)).toEqual([])
      expect(r.failed, JSON.stringify(a)).toBe(2)
      expect(r.stopped, JSON.stringify(a)).toBe(false)
    }
  })

  it("a refused key (403) stops the batch and removes NOTHING, even with many phones", async () => {
    const many = Array.from({ length: 40 }, (_, i) => phone(i + 1, "u1"))
    const h = harness({ phones: many, over: { recipients: async () => ["u1"] }, answer: async () => ({ status: 403, reason: "InvalidProviderToken" }) })
    const r = await sendToPhones(alert(), h.deps)
    expect(h.revoked).toEqual([])
    expect(r.stopped).toBe(true)
    expect(r.attempted).toBeLessThan(40)
  })

  it("'too many requests' (429) also stops and removes nothing", async () => {
    const many = Array.from({ length: 40 }, (_, i) => phone(i + 1, "u1"))
    const h = harness({ phones: many, over: { recipients: async () => ["u1"] }, answer: async () => ({ status: 429, reason: "TooManyProviderTokenUpdates" }) })
    const r = await sendToPhones(alert(), h.deps)
    expect(h.revoked).toEqual([])
    expect(r.stopped).toBe(true)
  })

  it("a dropped connection or a timeout keeps every phone, and the connection is still closed", async () => {
    const h = harness({ answer: () => { throw new Error("timeout") } })
    const r = await sendToPhones(alert(), h.deps)
    expect(r).toMatchObject({ sent: 0, gone: 0, failed: 2 })
    expect(h.revoked).toEqual([])
    expect(h.closed).toEqual(["api.push.apple.com"])
  })

  it("a failure to mark a phone revoked does not break the batch", async () => {
    const h = harness({ answer: answers({ [tok(1)]: { status: 410, reason: "Unregistered" } }), over: { revoke: async () => { throw new Error("db") } } })
    const r = await sendToPhones(alert(), h.deps)
    expect(r.sent).toBe(1)
  })
})

describe("logging", () => {
  it("holds only the phone's row id and Apple's reason: never the token, the key or the signing token", async () => {
    const h = harness({ answer: () => ({ status: 403, reason: "InvalidProviderToken" }) })
    await sendToPhones(alert(), h.deps)
    const all = h.logs.join("\n")
    expect(all).toContain("p1")
    expect(all).toContain("InvalidProviderToken")
    expect(all).not.toContain(tok(1))
    expect(all).not.toContain("PRIVATE KEY")
    expect(all).not.toContain(KEY.keyId)
    expect(all).not.toMatch(/bearer/i)
  })
})

describe("Marketing", () => {
  it("goes through the same leg with the Italian wording and the marketing tab's mute", async () => {
    const h = harness({ over: { mutedTabs: async id => (id === "u1" ? ["marketing"] : []) } })
    const r = await sendToPhones(alert({ source: "marketing", teamId: "t1", kind: "marketing_lead_chat", name: "Giulia" }), h.deps)
    expect(r.sent).toBe(1)
    expect(body(h.sent[0].req).aps.alert).toEqual({ title: "Nuovo messaggio · Giulia" })
  })
})

describe("slow side lookups never hold an alert back", () => {
  it("a slow icon-number lookup: the alert goes WITHOUT a number", async () => {
    vi.useFakeTimers()
    try {
      const h = harness({ over: { badge: () => new Promise<number | null>(() => { /* never answers */ }) } })
      const p = sendToPhones(alert(), h.deps)
      await vi.advanceTimersByTimeAsync(SIDE_LOOKUP_MS + 100)
      const r = await p
      expect(r.sent).toBe(2)
      for (const x of h.sent) expect("badge" in body(x.req).aps).toBe(false)
    } finally { vi.useRealTimers() }
  })

  it("a slow lookup of someone's mutes: they are treated as not muted (a mute is a convenience)", async () => {
    vi.useFakeTimers()
    try {
      const h = harness({ over: { mutedTabs: () => new Promise<string[]>(() => { /* never answers */ }) } })
      const p = sendToPhones(alert(), h.deps)
      await vi.advanceTimersByTimeAsync(SIDE_LOOKUP_MS + 100)
      expect((await p).sent).toBe(2)
    } finally { vi.useRealTimers() }
  })
})

describe("a refused key stops only THAT Apple address", () => {
  it("403 on the production address leaves the test address working, and removes nothing", async () => {
    const phones = [phone(1, "u1", "production"), phone(2, "u1", "production"), phone(3, "u2", "development"), phone(4, "u2", "development")]
    const h = harness({ phones, answer: (_req, host) => (host === "api.push.apple.com" ? { status: 403, reason: "InvalidProviderToken" } : { status: 200, reason: null }) })
    const r = await sendToPhones(alert(), h.deps)
    expect(h.sent.filter(x => x.host === "api.sandbox.push.apple.com")).toHaveLength(2)
    expect(r.sent).toBe(2)
    expect(r.stopped).toBe(true)
    expect(h.revoked).toEqual([])
  })
})

describe("the leg's own deadline", () => {
  it("past the deadline nothing more is sent (a late alert is worse than none), and nothing is removed", async () => {
    let t = 1_800_000_000_000
    const many = Array.from({ length: 20 }, (_, i) => phone(i + 1, "u1"))
    const h = harness({
      phones: many,
      over: { recipients: async () => ["u1"], now: () => t },
      answer: async () => { t += LEG_DEADLINE_MS + 1000; return { status: 200, reason: null } },
    })
    const r = await sendToPhones(alert(), h.deps)
    // the first answer moves the clock past the deadline: nothing after it is sent
    expect(r.sent).toBeGreaterThanOrEqual(1)
    expect(r.sent).toBeLessThan(many.length)
    expect(h.sent).toHaveLength(r.sent)
    expect(r.stopped).toBe(true)
    expect(h.revoked).toEqual([])
  })
})

describe("the alert's facts reach the recipient check", () => {
  it("the kind and the lead of a Marketing alert are handed to it unchanged", async () => {
    let seen: PhoneAlert | undefined
    const h = harness({ over: { recipients: async a => { seen = a; return a.userIds } } })
    const a = alert({ source: "marketing", teamId: "t1", kind: "marketing_lead_moved", leadId: "lead-1", name: "Giulia" })
    await sendToPhones(a, h.deps)
    expect(seen).toMatchObject({ kind: "marketing_lead_moved", leadId: "lead-1", teamId: "t1" })
  })
})
