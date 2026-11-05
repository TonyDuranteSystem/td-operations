/**
 * TD Social — the working part of the WhatsApp / email phone alerts (dev job 2072bc3e, Step 2 pull request D): the order of work, the claim, each person's own
 * switches, the CRM name, and the cap on how many conversations one batch may alert.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const { rpc, from, listAllAuthUsers, readState, isSocialAppEnabled, sendToPhonesLive, rows } = vi.hoisted(() => {
  const rows: Record<string, Record<string, unknown> | null> = {}
  const from = vi.fn((table: string) => {
    const chain: { id?: string; select: () => typeof chain; eq: (c: string, id: string) => typeof chain; maybeSingle: () => Promise<{ data: unknown }> } = {
      select: () => chain,
      eq: (_c: string, id: string) => { chain.id = id; return chain },
      maybeSingle: async () => ({ data: rows[`${table}:${chain.id}`] ?? null }),
    }
    return chain
  })
  return { rpc: vi.fn(), from, listAllAuthUsers: vi.fn(), readState: vi.fn(), isSocialAppEnabled: vi.fn(), sendToPhonesLive: vi.fn(), rows }
})

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: { rpc, from } }))
vi.mock("@/lib/auth-admin-helpers", () => ({ listAllAuthUsers }))
vi.mock("@/lib/app/state", () => ({ readState }))
vi.mock("@/lib/app/enabled", () => ({ isSocialAppEnabled }))
vi.mock("@/lib/app/send-to-phones", () => ({ MAX_RECIPIENTS: 25, SIDE_LOOKUP_MS: 50, sendToPhonesLive }))

import {
  MAX_CLAIMS_PER_JOB, MAX_JOBS_PER_BATCH, claimLive, nameLive, recipientsLive, runInboundJob, runInboundJobsLive, wantsInboundAlert, type InboundDeps,
} from "@/lib/app/inbound-alerts-live"
import type { InboundJob } from "@/lib/app/inbound-alerts"
import type { AppTab } from "@/lib/app/tabs"

const emailJob = (over: Partial<InboundJob> = {}): InboundJob => ({
  kind: "email_message", source: "email:support", messageIds: ["m1"], place: "support", tag: "email:support:t1", who: { contactId: "c1" }, ...over,
})
const waJob = (over: Partial<InboundJob> = {}): InboundJob => ({
  kind: "whatsapp_message", source: "whatsapp:g1", messageIds: ["w1"], tag: "whatsapp:g1", who: { groupId: "g1" }, ...over,
})

function fakeDeps(over: Partial<InboundDeps> = {}): InboundDeps & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    isOn: async () => { calls.push("isOn"); return true },
    claim: async (s, id) => { calls.push(`claim:${s}:${id}`); return "send" },
    recipients: async () => { calls.push("recipients"); return ["u1", "u2"] },
    nameFor: async () => { calls.push("nameFor"); return "Acme LLC" },
    send: async () => { calls.push("send") },
    ...over,
  }
}

beforeEach(() => {
  rpc.mockReset(); readState.mockReset(); listAllAuthUsers.mockReset(); isSocialAppEnabled.mockReset(); sendToPhonesLive.mockReset(); from.mockClear()
  for (const k of Object.keys(rows)) delete rows[k]
})

describe("the order of work", () => {
  it("switched off: NOTHING else happens, in particular nothing is claimed (a claim made now would block the real alert later)", async () => {
    const d = fakeDeps({ isOn: async () => false })
    expect(await runInboundJob(emailJob(), d)).toBe("off")
    expect(d.calls).toEqual([])
  })

  it("on: switch → claim → who → name → send, and the alert says what the lock screen needs and nothing from the message", async () => {
    const sent: unknown[] = []
    const d = fakeDeps({ send: async a => { sent.push(a) } })
    expect(await runInboundJob(emailJob(), d)).toBe("sent")
    expect(d.calls).toEqual(["isOn", "claim:email:support:m1", "recipients", "nameFor"])
    expect(sent).toEqual([{ source: "staff", userIds: ["u1", "u2"], kind: "email_message", title: "", body: "", name: "Acme LLC", dm: false, place: "support", tag: "email:support:t1" }])
  })

  it("a WhatsApp alert carries no mailbox", async () => {
    const sent: { place?: unknown; kind?: unknown }[] = []
    await runInboundJob(waJob(), fakeDeps({ send: async a => { sent.push(a) } }))
    expect(sent[0]).toMatchObject({ kind: "whatsapp_message", place: null })
  })

  it("already alerted (duplicate) or over the flood cap (silent): no one is looked up and nothing is sent", async () => {
    for (const answer of ["duplicate", "silent"] as const) {
      const d = fakeDeps({ claim: async () => answer })
      expect(await runInboundJob(emailJob(), d)).toBe("not sent")
      expect(d.calls).toEqual(["isOn"])
    }
  })

  it("a thread with several new messages: all are claimed, ONE alert is sent if any of them could send", async () => {
    const claimed: string[] = []
    const sent: unknown[] = []
    const d = fakeDeps({
      claim: async (_s, id) => { claimed.push(id); return id === "b" ? "send" : "duplicate" },
      send: async a => { sent.push(a) },
    })
    expect(await runInboundJob(emailJob({ messageIds: ["a", "b", "c"] }), d)).toBe("sent")
    expect(claimed).toEqual(["a", "b", "c"])
    expect(sent).toHaveLength(1)
  })

  it("at most MAX_CLAIMS_PER_JOB messages of one thread are claimed", async () => {
    const claimed: string[] = []
    await runInboundJob(emailJob({ messageIds: Array.from({ length: 40 }, (_, i) => `m${i}`) }), fakeDeps({ claim: async (_s, id) => { claimed.push(id); return "duplicate" } }))
    expect(claimed).toHaveLength(MAX_CLAIMS_PER_JOB)
  })

  it("nobody wants it: nothing is sent", async () => {
    const d = fakeDeps({ recipients: async () => [] })
    expect(await runInboundJob(emailJob(), d)).toBe("nobody")
    expect(d.calls).not.toContain("send")
  })

  it("never more than 25 people", async () => {
    const sent: { userIds: string[] }[] = []
    await runInboundJob(emailJob(), fakeDeps({ recipients: async () => Array.from({ length: 60 }, (_, i) => `u${i}`), send: async a => { sent.push(a as unknown as { userIds: string[] }) } }))
    expect(sent[0].userIds).toHaveLength(25)
  })

  it("a slow or failing name lookup does not hold the alert: it goes with generic words", async () => {
    const sent: { name?: unknown }[] = []
    await runInboundJob(emailJob(), fakeDeps({ nameFor: () => new Promise(() => undefined), send: async a => { sent.push(a) } }))
    expect(sent[0].name).toBeNull()
    sent.length = 0
    await runInboundJob(emailJob(), fakeDeps({ nameFor: async () => { throw new Error("down") }, send: async a => { sent.push(a) } }))
    expect(sent[0].name).toBeNull()
  })
})

describe("each person's own switches decide who is told", () => {
  const tab = (id: string, mailboxes?: string[]): AppTab => ({ id, label: id, ...(mailboxes ? { mailboxes } : {}) } as AppTab)
  const luca = [tab("talk"), tab("portal"), tab("whatsapp"), tab("inbox", ["support"])]
  const antonio = [tab("talk"), tab("portal"), tab("whatsapp"), tab("inbox", ["support", "antonio"])]

  it("WhatsApp is on by default for anyone who has the WhatsApp tab, and off once they switch it off", () => {
    expect(wantsInboundAlert("whatsapp_message", undefined, luca, null)).toBe(true)
    expect(wantsInboundAlert("whatsapp_message", undefined, luca, { alerts: { whatsapp: false } })).toBe(false)
    expect(wantsInboundAlert("whatsapp_message", undefined, [tab("talk")], null)).toBe(false)
  })

  it("email: on by default only for a person's ONLY mailbox (Luca gets support@; Antonio and Jodi, who see two, get none until they switch one on)", () => {
    expect(wantsInboundAlert("email_message", "support", luca, null)).toBe(true)
    expect(wantsInboundAlert("email_message", "antonio", luca, null)).toBe(false)
    expect(wantsInboundAlert("email_message", "support", antonio, null)).toBe(false)
    expect(wantsInboundAlert("email_message", "antonio", antonio, null)).toBe(false)
    expect(wantsInboundAlert("email_message", "antonio", antonio, { alerts: { "email:antonio": true } })).toBe(true)
    expect(wantsInboundAlert("email_message", "support", antonio, { alerts: { "email:antonio": true } })).toBe(false)
    expect(wantsInboundAlert("email_message", "support", luca, { alerts: { "email:support": false } })).toBe(false)
  })

  it("a person who cannot open a mailbox is never told about it, whatever is stored", () => {
    expect(wantsInboundAlert("email_message", "antonio", luca, { alerts: { "email:antonio": true } })).toBe(false)
    expect(wantsInboundAlert("email_message", undefined, luca, null)).toBe(false)
    expect(wantsInboundAlert("email_message", "support", [tab("talk")], null)).toBe(false)
  })
})

describe("recipientsLive (the real staff list, read now)", () => {
  const user = (id: string, role: string, extra: Record<string, unknown> = {}) => ({ id, email: `${id}@example.com`, app_metadata: { role }, banned_until: null, ...extra })

  it("staff who want it are returned; clients, partners, marketing logins and banned logins never are", async () => {
    listAllAuthUsers.mockResolvedValue([
      user("luca", "team"), user("antonio", "admin"), user("client1", "client"), user("partner1", "partner"), user("rocco", "marketing"),
      user("gone", "team", { banned_until: "2099-01-01T00:00:00Z" }),
    ])
    readState.mockResolvedValue(null)
    // email in support: Luca (only mailbox) yes; Antonio (two mailboxes, nothing switched on) no
    expect(await recipientsLive(emailJob())).toEqual(["luca"])
    // WhatsApp: both staff, nobody else
    expect(await recipientsLive(waJob())).toEqual(["luca", "antonio"])
  })

  it("a stored switch is honoured", async () => {
    listAllAuthUsers.mockResolvedValue([user("antonio", "admin")])
    readState.mockResolvedValue({ alerts: { "email:antonio": true }, muted_tabs: [] })
    expect(await recipientsLive(emailJob({ place: "antonio" }))).toEqual(["antonio"])
    expect(await recipientsLive(emailJob({ place: "support" }))).toEqual([])
  })

  it("a person whose switches cannot be read is left out (any doubt means nobody), and the others still get it", async () => {
    listAllAuthUsers.mockResolvedValue([user("a", "team"), user("b", "team")])
    readState.mockImplementation(async (id: string) => { if (id === "a") throw new Error("table missing"); return null })
    expect(await recipientsLive(waJob())).toEqual(["b"])
  })

  it("a failing staff list is nobody, never a throw", async () => {
    listAllAuthUsers.mockRejectedValue(new Error("auth down"))
    expect(await recipientsLive(waJob())).toEqual([])
  })
})

describe("claimLive (the memory table)", () => {
  it("passes the answer through only when it is one of the two known ones", async () => {
    rpc.mockResolvedValueOnce({ data: "send", error: null })
    expect(await claimLive("email:support", "m1")).toBe("send")
    expect(rpc).toHaveBeenCalledWith("social_app_claim_alert", { p_source: "email:support", p_message_id: "m1" })
    rpc.mockResolvedValueOnce({ data: "silent", error: null })
    expect(await claimLive("email:support", "m2")).toBe("silent")
  })

  it("anything else — duplicate, a database error, a thrown error, a strange value — means no alert", async () => {
    rpc.mockResolvedValueOnce({ data: "duplicate", error: null })
    expect(await claimLive("s", "m")).toBe("duplicate")
    rpc.mockResolvedValueOnce({ data: "send", error: { message: "boom" } })
    expect(await claimLive("s", "m")).toBe("duplicate")
    rpc.mockRejectedValueOnce(new Error("network"))
    expect(await claimLive("s", "m")).toBe("duplicate")
    rpc.mockResolvedValueOnce({ data: "SEND ME", error: null })
    expect(await claimLive("s", "m")).toBe("duplicate")
    rpc.mockResolvedValueOnce({ data: null, error: null })
    expect(await claimLive("s", "m")).toBe("duplicate")
  })
})

describe("nameLive (the CRM name, never anything the sender typed)", () => {
  it("an email: the person first, then the lead, then the company", async () => {
    rows["contacts:c1"] = { full_name: "Maria Rossi" }
    rows["leads:l1"] = { full_name: "Lead Person" }
    rows["accounts:a1"] = { company_name: "Acme LLC" }
    expect(await nameLive(emailJob({ who: { contactId: "c1", leadId: "l1", accountId: "a1" } }))).toBe("Maria Rossi")
    expect(await nameLive(emailJob({ who: { contactId: null, leadId: "l1", accountId: "a1" } }))).toBe("Lead Person")
    expect(await nameLive(emailJob({ who: { contactId: null, leadId: null, accountId: "a1" } }))).toBe("Acme LLC")
  })

  it("a WhatsApp chat: the link is read NOW from the chat (the bridge may have linked it a moment ago)", async () => {
    rows["messaging_groups:g1"] = { contact_id: null, lead_id: "l1", account_id: null }
    rows["leads:l1"] = { full_name: "Lead Person" }
    expect(await nameLive(waJob())).toBe("Lead Person")
  })

  it("not linked, a blank name, a missing row or a failing read is no name (generic words)", async () => {
    expect(await nameLive(waJob())).toBeNull()
    rows["messaging_groups:g1"] = { contact_id: "c1", lead_id: null, account_id: null }
    rows["contacts:c1"] = { full_name: "   " }
    expect(await nameLive(waJob())).toBeNull()
    expect(await nameLive(emailJob({ who: {} }))).toBeNull()
    from.mockImplementationOnce(() => { throw new Error("down") })
    expect(await nameLive(emailJob({ who: { contactId: "c1" } }))).toBeNull()
  })
})

describe("a batch", () => {
  it("alerts at most MAX_JOBS_PER_BATCH conversations (a huge catch-up cannot buzz a phone dozens of times)", async () => {
    const d = fakeDeps()
    const jobs = Array.from({ length: 12 }, (_, i) => waJob({ source: `whatsapp:g${i}`, messageIds: [`w${i}`], tag: `whatsapp:g${i}` }))
    await runInboundJobsLive(jobs, d)
    expect(d.calls.filter(c => c === "send")).toHaveLength(MAX_JOBS_PER_BATCH)
  })

  it("one job failing does not stop the next", async () => {
    let n = 0
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const d = fakeDeps({ claim: async () => { n++; if (n === 1) throw new Error("boom"); return "send" } })
    await runInboundJobsLive([waJob({ messageIds: ["a"] }), waJob({ source: "whatsapp:g2", messageIds: ["b"] })], d)
    expect(d.calls.filter(c => c === "send")).toHaveLength(1)
    spy.mockRestore()
  })
})
