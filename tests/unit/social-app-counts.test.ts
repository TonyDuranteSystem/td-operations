/**
 * TD Social — what is waiting, per tab, and the icon number (dev job 2072bc3e, Step 2 pull request B).
 * The number is honest or absent: a muted tab is not counted, and if any counted tab fails or is too slow the whole number is null
 * (never 0). The CRM's own counters are not touched; the differences are on purpose (no 500 cap, deleted messages skipped, new mail only).
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"

const h = vi.hoisted(() => ({ marketingUnread: 0, marketingThrows: false }))
vi.mock("@/lib/marketing/menu-unread", () => ({
  marketingChatUnread: async () => { if (h.marketingThrows) throw new Error("db"); return h.marketingUnread },
}))
vi.mock("@/lib/app/state", () => ({ markInboxOpened: vi.fn(async () => null) }))

import {
  countTalk, countPortal, countWhatsapp, countNewEmail, countTabs, COUNT_TIMEOUT_MS, type CountDb,
} from "@/lib/app/counts"
import { OWN_MAILBOX_ADDRESSES } from "@/lib/gmail"
import type { AppTab } from "@/lib/app/tabs"

type Call = { table?: string; op: string; args: unknown[] }

/** A recording stand-in for the database: every chained call is kept; awaiting the chain gives the canned answer for that table. */
function mockDb(answers: Record<string, unknown>, rpcAnswers: Record<string, unknown> = {}) {
  const calls: Call[] = []
  const db: CountDb = {
    from: (table: string) => {
      calls.push({ table, op: "from", args: [table] })
      const chain: Record<string, unknown> = {}
      for (const op of ["select", "eq", "is", "gt", "in", "contains", "not", "or"]) {
        chain[op] = (...args: unknown[]) => { calls.push({ table, op, args }); return chain }
      }
      chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
        const a = answers[table]
        return a instanceof Error ? reject(a) : resolve(a)
      }
      return chain
    },
    rpc: (fn: string, args: Record<string, unknown>) => { calls.push({ op: "rpc", args: [fn, args] }); return Promise.resolve(rpcAnswers[fn]) },
  }
  return { db, calls }
}

const tab = (id: string, mailboxes?: string[]): AppTab => ({ id, label: id, ...(mailboxes ? { mailboxes } : {}) }) as AppTab
const NOW = new Date("2026-11-05T12:00:00Z")

beforeEach(() => { h.marketingUnread = 0; h.marketingThrows = false })

describe("countTalk", () => {
  it("counts unread direct and group messages for THIS person (the same rule as the CRM's TD Talk number)", async () => {
    const { db, calls } = mockDb({}, { get_team_threads: { data: [
      { thread_type: "dm", unread_count: 2 }, { thread_type: "group", unread_count: 1 },
      { thread_type: "channel", unread_count: 9 }, { thread_type: "client", unread_count: 4 },
    ], error: null } })
    expect(await countTalk(db, "u1")).toBe(3)
    expect(calls.find(c => c.op === "rpc")?.args).toEqual(["get_team_threads", { p_user_id: "u1" }])
  })

  it("an error is an error, never 0", async () => {
    const { db } = mockDb({}, { get_team_threads: { data: null, error: { code: "x" } } })
    await expect(countTalk(db, "u1")).rejects.toThrow()
  })
})

describe("countPortal", () => {
  it("counts EXACTLY the unread client messages that were not deleted (no 500 cap)", async () => {
    const { db, calls } = mockDb({ portal_messages: { count: 1234, error: null } })
    expect(await countPortal(db)).toBe(1234)
    const ops = calls.filter(c => c.table === "portal_messages")
    expect(ops.find(c => c.op === "select")?.args).toEqual(["id", { count: "exact", head: true }])
    expect(ops.find(c => c.op === "eq")?.args).toEqual(["sender_type", "client"])
    expect(ops.filter(c => c.op === "is").map(c => c.args)).toEqual([["read_at", null], ["deleted_at", null]])
    expect(ops.some(c => c.op === "limit")).toBe(false)
  })

  it("an error is an error", async () => {
    const { db } = mockDb({ portal_messages: { count: null, error: { code: "x" } } })
    await expect(countPortal(db)).rejects.toThrow()
  })
})

describe("countWhatsapp", () => {
  it("sums unread messages in ACTIVE WhatsApp chats only (Telegram is not WhatsApp)", async () => {
    const { db, calls } = mockDb({
      messaging_channels: { data: [{ id: "c1" }, { id: "c2" }], error: null },
      messaging_groups: { data: [{ unread_count: 3 }, { unread_count: null }, { unread_count: 4 }], error: null },
    })
    expect(await countWhatsapp(db)).toBe(7)
    expect(calls.find(c => c.table === "messaging_channels" && c.op === "eq")?.args).toEqual(["platform", "whatsapp"])
    expect(calls.find(c => c.table === "messaging_groups" && c.op === "in")?.args).toEqual(["channel_id", ["c1", "c2"]])
    expect(calls.find(c => c.table === "messaging_groups" && c.op === "eq")?.args).toEqual(["is_active", true])
  })

  it("no WhatsApp channel means 0 without a second query", async () => {
    const { db, calls } = mockDb({ messaging_channels: { data: [], error: null } })
    expect(await countWhatsapp(db)).toBe(0)
    expect(calls.some(c => c.table === "messaging_groups")).toBe(false)
  })
})

describe("countNewEmail", () => {
  it("the FIRST time (no stored time) sets the baseline to now and counts 0: the number starts clean", async () => {
    const { db, calls } = mockDb({})
    const set = vi.fn(async () => null)
    expect(await countNewEmail(db, "u1", ["support", "antonio"], {}, NOW, set)).toBe(0)
    expect(set.mock.calls).toEqual([["u1", "support", NOW, true], ["u1", "antonio", NOW, true]])
    expect(calls.some(c => c.table === "email_index")).toBe(false)
  })

  it("counts only mail that is NEW, in the Inbox, unread, not ours, not spam / trash / draft", async () => {
    const { db, calls } = mockDb({ email_index: { count: 5, error: null } })
    const opened = { support: "2026-11-05T10:00:00Z" }
    expect(await countNewEmail(db, "u1", ["support"], opened, NOW, vi.fn())).toBe(5)
    const ops = calls.filter(c => c.table === "email_index")
    expect(ops.find(c => c.op === "eq" && c.args[0] === "mailbox")?.args).toEqual(["mailbox", "support"])
    expect(ops.find(c => c.op === "eq" && c.args[0] === "is_unread")?.args).toEqual(["is_unread", true])
    expect(ops.find(c => c.op === "contains")?.args).toEqual(["label_ids", ["INBOX"]])
    expect(ops.filter(c => c.op === "not").map(c => c.args)).toEqual([["label_ids", "cs", "{SPAM}"], ["label_ids", "cs", "{TRASH}"], ["label_ids", "cs", "{DRAFT}"]])
    expect(ops.find(c => c.op === "gt")?.args).toEqual(["internal_date", "2026-11-05T10:00:00Z"])
    const or = String(ops.find(c => c.op === "or")?.args[0])
    for (const a of OWN_MAILBOX_ADDRESSES) expect(or).toContain(a)
    expect(or.startsWith("from_email.is.null,from_email.not.in.(")).toBe(true)
  })

  it("only asks about mailboxes the person may open, and adds them up", async () => {
    const { db, calls } = mockDb({ email_index: { count: 2, error: null } })
    const opened = { support: "2026-11-05T10:00:00Z", antonio: "2026-11-05T09:00:00Z" }
    expect(await countNewEmail(db, "u1", ["support", "antonio"], opened, NOW, vi.fn())).toBe(4)
    expect(calls.filter(c => c.table === "email_index" && c.op === "eq" && c.args[0] === "mailbox").map(c => c.args[1])).toEqual(["support", "antonio"])
    const justSupport = mockDb({ email_index: { count: 2, error: null } })
    await countNewEmail(justSupport.db, "u1", ["support"], opened, NOW, vi.fn())
    expect(justSupport.calls.filter(c => c.op === "eq" && c.args[0] === "mailbox").map(c => c.args[1])).toEqual(["support"])
  })

  it("a stored time that is not a time counts as missing (never trusted)", async () => {
    const { db } = mockDb({})
    const set = vi.fn(async () => null)
    expect(await countNewEmail(db, "u1", ["support"], { support: "garbage" }, NOW, set)).toBe(0)
    expect(set).toHaveBeenCalledTimes(1)
  })

  it("an error is an error", async () => {
    const { db } = mockDb({ email_index: { count: null, error: { code: "x" } } })
    await expect(countNewEmail(db, "u1", ["support"], { support: "2026-11-05T10:00:00Z" }, NOW, vi.fn())).rejects.toThrow()
  })
})

describe("countTabs: the number on the icon", () => {
  const base = {
    userId: "u1", inboxOpened: { support: "2026-11-05T10:00:00Z" }, now: NOW,
    tabs: [tab("talk"), tab("portal"), tab("whatsapp"), tab("inbox", ["support"])],
  }
  const answers = () => mockDb({
    portal_messages: { count: 10, error: null },
    messaging_channels: { data: [{ id: "c1" }], error: null },
    messaging_groups: { data: [{ unread_count: 5 }], error: null },
    email_index: { count: 2, error: null },
  }, { get_team_threads: { data: [{ thread_type: "dm", unread_count: 3 }], error: null } })

  it("adds up every tab that is not muted", async () => {
    const { db } = answers()
    const r = await countTabs({ ...base, mutedTabs: [], db })
    expect(r.counts).toEqual({ talk: 3, portal: 10, whatsapp: 5, inbox: 2 })
    expect(r.badge).toBe(20)
  })

  it("a MUTED tab is not counted and not even asked about", async () => {
    const { db, calls } = answers()
    const r = await countTabs({ ...base, mutedTabs: ["portal", "whatsapp"], db })
    expect(r.counts).toEqual({ talk: 3, inbox: 2 })
    expect(r.badge).toBe(5)
    expect(calls.some(c => c.table === "portal_messages" || c.table === "messaging_groups")).toBe(false)
  })

  it("if ANY counted tab fails the number is null, never 0, and the other counts are kept", async () => {
    const { db } = mockDb({
      portal_messages: new Error("db down"),
      messaging_channels: { data: [], error: null },
      email_index: { count: 2, error: null },
    }, { get_team_threads: { data: [{ thread_type: "dm", unread_count: 3 }], error: null } })
    const r = await countTabs({ ...base, mutedTabs: [], db })
    expect(r.counts).toEqual({ talk: 3, portal: null, whatsapp: 0, inbox: 2 })
    expect(r.badge).toBeNull()
  })

  it("a tab that is too slow makes the number absent instead of making the alert wait", async () => {
    const slow: CountDb = { from: () => { throw new Error("unused") }, rpc: () => new Promise(() => {}) }
    const t0 = Date.now()
    const r = await countTabs({ userId: "u1", tabs: [tab("talk")], mutedTabs: [], inboxOpened: {}, db: slow, timeoutMs: 40 })
    expect(r.counts).toEqual({ talk: null })
    expect(r.badge).toBeNull()
    expect(Date.now() - t0).toBeLessThan(1000)
  })

  it("the cap is about a second and a half", () => {
    expect(COUNT_TIMEOUT_MS).toBe(1500)
  })

  it("a person whose tabs are all muted has a number of 0 (nothing is waiting by their own choice)", async () => {
    const { db } = answers()
    const r = await countTabs({ ...base, mutedTabs: ["talk", "portal", "whatsapp", "inbox"], db })
    expect(r.counts).toEqual({})
    expect(r.badge).toBe(0)
  })

  it("Marketing uses the person's own Marketing context", async () => {
    h.marketingUnread = 7
    const ctx = { permissions: ["chat"], team: { id: "t", name: "n", status: "active" }, user: { id: "u1", email: null }, role: "member" as const, membership: { team_id: "t", member_role: "member" as const, status: "active", bundle: null, permissions: [] } }
    const r = await countTabs({ userId: "u1", tabs: [tab("marketing")], mutedTabs: [], inboxOpened: {}, marketing: ctx as never, db: mockDb({}).db })
    expect(r).toEqual({ counts: { marketing: 7 }, badge: 7 })
  })

  it("Marketing without a context, or whose count fails, makes the number absent", async () => {
    const noCtx = await countTabs({ userId: "u1", tabs: [tab("marketing")], mutedTabs: [], inboxOpened: {}, db: mockDb({}).db })
    expect(noCtx.badge).toBeNull()
    h.marketingThrows = true
    const ctx = { permissions: ["chat"], team: { id: "t", name: "n", status: "active" }, user: { id: "u1", email: null }, role: "member" as const, membership: { team_id: "t", member_role: "member" as const, status: "active", bundle: null, permissions: [] } }
    const failing = await countTabs({ userId: "u1", tabs: [tab("marketing")], mutedTabs: [], inboxOpened: {}, marketing: ctx as never, db: mockDb({}).db })
    expect(failing.badge).toBeNull()
  })

  it("a tab this file cannot count makes the number absent (a sixth tab cannot be added in silently)", async () => {
    const r = await countTabs({ userId: "u1", tabs: [tab("calendar")], mutedTabs: [], inboxOpened: {}, db: mockDb({}).db })
    expect(r).toEqual({ counts: { calendar: null }, badge: null })
  })
})

describe("the CRM's own counters are not touched", () => {
  const read = (p: string) => readFileSync(join(__dirname, "..", "..", p), "utf8")
  it("the app's counters live in their own file and do not import the CRM routes", () => {
    const counts = read("lib/app/counts.ts")
    expect(counts).not.toMatch(/^import .*(dashboard\/badges|inbox\/stats)/m)
    expect(counts).not.toContain(".limit(")
  })
})
