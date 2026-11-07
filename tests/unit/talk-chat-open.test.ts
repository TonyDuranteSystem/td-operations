/**
 * TD Talk's "open a chat" answer (dev job cf265457, "opening a chat spins every time").
 * Measured on the test copy: a 3-message chat and a 520-message chat both took ~1 s to open, so the time is the number of database round trips.
 * TD Talk asks for `?view=talk` and gets only what its screen uses, the lookups side by side, the newest messages. Everything else keeps the default answer.
 */
import { describe, it, expect, vi } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { CHAT_OPEN_MESSAGES, CHAT_WINDOW_MAX, chatOpenLimit, parseChatView, withChatView } from "@/lib/talk/chat-open-scope"

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: {} }))
import { buildTalkChatAnswer } from "@/lib/team/talk-chat-answer"

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

describe("chat-open-scope (the address TD Talk asks and the server reads)", () => {
  it("opens with the newest 60, never fewer on a refresh than the screen already shows, never more than 500", () => {
    expect(chatOpenLimit(0, false)).toBe(CHAT_OPEN_MESSAGES)
    expect(chatOpenLimit(12, false)).toBe(CHAT_OPEN_MESSAGES)
    expect(chatOpenLimit(61, false)).toBe(61)
    expect(chatOpenLimit(300, false)).toBe(300)
    expect(chatOpenLimit(9999, false)).toBe(CHAT_WINDOW_MAX)
    expect(chatOpenLimit(Number.NaN, false)).toBe(CHAT_OPEN_MESSAGES)
  })
  it("a link to one message (?message=) asks for the whole window because its jump looks for the message in it", () => {
    expect(chatOpenLimit(0, true)).toBe(CHAT_WINDOW_MAX)
  })
  it("adds the view to the address with or without the read-rule query", () => {
    expect(withChatView("", 60)).toBe("?view=talk&limit=60")
    expect(withChatView("?mark_read=0", 60)).toBe("?mark_read=0&view=talk&limit=60")
  })
  it("the server only answers lightly for view=talk, and clamps the limit", () => {
    expect(parseChatView(new URLSearchParams(""))).toBeNull()
    expect(parseChatView(new URLSearchParams("mark_read=0"))).toBeNull()
    expect(parseChatView(new URLSearchParams("view=other&limit=5"))).toBeNull()
    expect(parseChatView(new URLSearchParams("view=talk"))?.limit).toBe(CHAT_OPEN_MESSAGES)
    expect(parseChatView(new URLSearchParams("view=talk&limit=25"))?.limit).toBe(25)
    expect(parseChatView(new URLSearchParams("view=talk&limit=0"))?.limit).toBe(1)
    expect(parseChatView(new URLSearchParams("view=talk&limit=99999"))?.limit).toBe(CHAT_WINDOW_MAX)
    expect(parseChatView(new URLSearchParams("view=talk&limit=abc"))?.limit).toBe(CHAT_OPEN_MESSAGES)
  })
  it("the cap is the default answer's window", () => {
    expect(read("app/api/team/threads/[id]/route.ts")).toContain(`const WINDOW = ${CHAT_WINDOW_MAX}`)
  })
})

describe("wiring", () => {
  const route = read("app/api/team/threads/[id]/route.ts")
  const app = read("components/talk/talk-app.tsx")
  it("the light answer is decided before the default answer's work, and only when ?view=talk", () => {
    const light = route.indexOf("parseChatView(request.nextUrl.searchParams)")
    const defaultStart = route.indexOf("const { data: thread } = await supabaseAdmin")
    expect(light).toBeGreaterThan(0)
    expect(light).toBeLessThan(defaultStart)
    expect(route).toContain("if (talkView && !request.nextUrl.searchParams.get('before'))")
  })
  it("the light answer keeps the read rule: it moves the pointer only without ?mark_read=0", () => {
    expect(route).toContain("markRead: request.nextUrl.searchParams.get('mark_read') !== '0'")
  })
  it("TD Talk asks for its own view, keeps the read-rule line unchanged, and shows a saved chat when one is chosen", () => {
    expect(app).toContain("isBeingViewed() ? '' : '?mark_read=0'")
    expect(app).toContain("withChatView(markReadQuery, limit)")
    expect(app).toContain("getStoreRef.current()?.chatFor(id)")
  })
  it("the CRM Team Chat page and the floating chat do not ask for the view (their answer is unchanged)", () => {
    expect(read("app/(dashboard)/team-chat/page.tsx")).not.toContain("view=talk")
    expect(read("components/team-chat/floating-chat.tsx")).not.toContain("view=talk")
  })
})

// ── the server's answer, with a recording fake of the database ──
type Row = Record<string, unknown>
function fakeDb(tables: Record<string, Row[] | Row | null>, opts: { gate?: Promise<void> } = {}) {
  const log: string[] = []
  const upserts: Row[] = []
  const builder = (table: string) => {
    let op = "select"
    let single = false
    let limit: number | null = null
    let upsertRow: Row | null = null
    const b: Record<string, unknown> = {}
    const chain = (name: string) => (...args: unknown[]) => { if (name === "limit") limit = args[0] as number; return b }
    for (const n of ["select", "eq", "in", "is", "order", "not"]) b[n] = chain(n)
    b.limit = chain("limit")
    b.single = () => { single = true; return b }
    b.maybeSingle = () => { single = true; return b }
    b.upsert = (row: Row) => { op = "upsert"; upsertRow = row; return b }
    b.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
      log.push(`start:${table}:${op}`)
      const run = async () => {
        if (table === "internal_threads" && opts.gate) await opts.gate
        if (op === "upsert") { upserts.push(upsertRow as Row); return { data: null, error: null } }
        const t = tables[table]
        if (single) return { data: Array.isArray(t) ? (t[0] ?? null) : (t ?? null), error: null }
        const rows = (Array.isArray(t) ? t : t ? [t] : []) as Row[]
        return { data: limit ? rows.slice(0, limit) : rows, error: null }
      }
      return run().then(v => { log.push(`end:${table}:${op}`); return v }).then(resolve, reject)
    }
    return b
  }
  return { client: { from: (t: string) => builder(t) }, log, upserts }
}

const base = { threadId: "t1", userId: "me", userName: "Me", isAdmin: false, limit: 60, markRead: true, deniedMessage: "denied", listGroupMemberIds: async () => [] as string[] }
const newestFirst = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `m${n - i}`, message: `hi ${n - i}`, created_at: `2026-11-07T10:${String(59 - i).padStart(2, "0")}:00Z`, reply_to_id: null }))

describe("buildTalkChatAnswer", () => {
  const dm = { id: "t1", thread_type: "dm", dm_key: "me:peer" }

  it("a direct message: newest messages oldest-first, the other person's read and delivered marks, and the caller's pointer moves", async () => {
    const f = fakeDb({
      internal_threads: dm, internal_messages: newestFirst(3),
      internal_thread_reads: { last_read_at: "R" }, internal_thread_delivery: { delivered_at: "D" },
    })
    const r = await buildTalkChatAnswer(f.client, base)
    expect(r.status).toBe(200)
    const b = (r as { body: Record<string, unknown> }).body
    expect((b.messages as { id: string }[]).map(m => m.id)).toEqual(["m1", "m2", "m3"])
    expect(b.has_more).toBe(false)
    expect(b.peer_read_at).toBe("R")
    expect(b.peer_delivered_at).toBe("D")
    expect(b.members).toBeNull()
    expect(b.current_user_id).toBe("me")
    expect(f.upserts).toHaveLength(1)
    expect(f.upserts[0]).toMatchObject({ thread_id: "t1", user_id: "me", manual_unread: false })
  })

  it("more messages than asked for: only the newest `limit`, and has_more says older ones exist", async () => {
    const f = fakeDb({ internal_threads: dm, internal_messages: newestFirst(11) })
    const r = await buildTalkChatAnswer(f.client, { ...base, limit: 10 })
    const b = (r as { body: Record<string, unknown> }).body
    const ids = (b.messages as { id: string }[]).map(m => m.id)
    expect(ids).toHaveLength(10)
    expect(ids[ids.length - 1]).toBe("m11") // the newest is kept
    expect(ids).not.toContain("m1") // the oldest was cut
    expect(b.has_more).toBe(true)
  })

  it("?mark_read=0 reads without moving the pointer", async () => {
    const f = fakeDb({ internal_threads: dm, internal_messages: newestFirst(2) })
    await buildTalkChatAnswer(f.client, { ...base, markRead: false })
    expect(f.upserts).toHaveLength(0)
    expect(f.log.some(l => l.includes("upsert"))).toBe(false)
  })

  it("a direct message that is not the caller's is refused, with nothing returned and no pointer written", async () => {
    const f = fakeDb({ internal_threads: { id: "t1", thread_type: "dm", dm_key: "a:b" }, internal_messages: newestFirst(2) })
    const r = await buildTalkChatAnswer(f.client, base)
    expect(r).toEqual({ status: 403, body: { error: "denied" } })
    expect(f.upserts).toHaveLength(0)
  })

  it("a group is for its members: a non-member is refused with no pointer written; a member gets the members and their marks", async () => {
    const group = { id: "t1", thread_type: "group", dm_key: null }
    const tables = { internal_threads: group, internal_messages: newestFirst(2), internal_thread_reads: [{ user_id: "other", last_read_at: "R" }], internal_thread_delivery: [{ user_id: "other", delivered_at: "D" }] }
    const no = fakeDb(tables)
    const refused = await buildTalkChatAnswer(no.client, { ...base, listGroupMemberIds: async () => ["other", "someone"] })
    expect(refused).toEqual({ status: 403, body: { error: "You are not in this group." } })
    expect(no.upserts).toHaveLength(0)

    const yes = fakeDb(tables)
    const ok = await buildTalkChatAnswer(yes.client, { ...base, listGroupMemberIds: async () => ["me", "other"] })
    const b = (ok as { body: Record<string, unknown> }).body
    expect(b.members).toEqual(["me", "other"])
    expect(b.member_reads).toEqual([{ user_id: "other", last_read_at: "R" }])
    expect(b.member_delivered).toEqual([{ user_id: "other", delivered_at: "D" }])
    expect(b.peer_read_at).toBeNull()
  })

  it("a chat that does not exist is a 404", async () => {
    const f = fakeDb({ internal_threads: null, internal_messages: [] })
    expect(await buildTalkChatAnswer(f.client, base)).toEqual({ status: 404, body: { error: "Thread not found" } })
  })

  it("quoted replies get their preview", async () => {
    const msgs = [{ id: "m2", message: "yes", created_at: "2026-11-07T10:02:00Z", reply_to_id: "m1" }, { id: "m1", message: "question?", created_at: "2026-11-07T10:01:00Z", reply_to_id: null }]
    const f = fakeDb({ internal_threads: dm, internal_messages: msgs })
    const r = await buildTalkChatAnswer(f.client, base)
    const out = (r as unknown as { body: { messages: { id: string; reply_to_preview: unknown }[] } }).body.messages
    expect(out.find(m => m.id === "m2")?.reply_to_preview).toMatchObject({ id: "m1", message: "question?" })
    expect(out.find(m => m.id === "m1")?.reply_to_preview).toBeNull()
  })

  it("the messages are asked for at the same time as the chat row (not after it), and the read pointer only after access is decided", async () => {
    let open!: () => void
    const gate = new Promise<void>(res => { open = res })
    const f = fakeDb({ internal_threads: dm, internal_messages: newestFirst(2) }, { gate })
    const pending = buildTalkChatAnswer(f.client, base)
    await new Promise(r => setTimeout(r, 20))
    // the chat row is still on its way, yet the messages have already been asked for
    expect(f.log).toContain("start:internal_threads:select")
    expect(f.log).toContain("start:internal_messages:select")
    expect(f.log).not.toContain("end:internal_threads:select")
    expect(f.log.some(l => l.includes("upsert"))).toBe(false)
    open()
    await pending
    const lastReadAsk = f.log.findIndex(l => l === "start:internal_thread_reads:upsert")
    expect(lastReadAsk).toBeGreaterThan(f.log.indexOf("end:internal_threads:select"))
  })
})
