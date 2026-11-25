/**
 * A TD Talk chat that could not be loaded is never drawn as an empty chat (Antonio, 2026-11-24: tapping a lock-screen alert opened TD Talk with
 * "No messages yet. Say hello."). Three layers: the load rules (lib/talk/chat-load.ts), the server's answer (a failed lookup is a fault and does NOT
 * move the read pointer) and the screen's wiring.
 */
import { describe, it, expect, vi } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import {
  CHAT_LOAD_TIMEOUT_MS, LOAD_STEPS, buildLoadReport, failureMessage, fetchChatAnswer, isRetryable, type ChatLoadFailure,
} from "@/lib/talk/chat-load"

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: {} }))
import { TALK_CHAT_LOAD_FAILED, buildTalkChatAnswer } from "@/lib/team/talk-chat-answer"

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

const fail = (o: Partial<ChatLoadFailure> & { kind: ChatLoadFailure["kind"] }): ChatLoadFailure => ({ elapsedMs: 5, ...o })

describe("which failures are worth trying again", () => {
  it("no connection, no answer in time, a server fault, busy and slow-down: yes", () => {
    expect(isRetryable(fail({ kind: "network" }))).toBe(true)
    expect(isRetryable(fail({ kind: "timeout" }))).toBe(true)
    for (const status of [500, 502, 503, 504, 408, 429]) expect(isRetryable(fail({ kind: "http", status }))).toBe(true)
  })
  it("a refusal or a chat that is gone: no (trying again cannot change it)", () => {
    for (const status of [400, 401, 403, 404]) expect(isRetryable(fail({ kind: "http", status }))).toBe(false)
  })
  it("a person's own open tries the same request, the same again, then the light one", () => {
    expect(LOAD_STEPS.map(s => s.light)).toEqual([false, false, true])
    expect(LOAD_STEPS[0].delayMs).toBe(0)
    expect(LOAD_STEPS[1].delayMs).toBeLessThan(LOAD_STEPS[2].delayMs)
  })
})

describe("what the screen says", () => {
  it("a refusal or a missing chat says the server's own words", () => {
    expect(failureMessage(fail({ kind: "http", status: 403, error: "You are not in this group." }))).toBe("You are not in this group.")
    expect(failureMessage(fail({ kind: "http", status: 404, error: "Thread not found" }))).toBe("Thread not found")
  })
  it("a fault, a dead connection and a slow one each get their own plain line (never the empty-chat wording)", () => {
    const lines = [
      failureMessage(fail({ kind: "http", status: 500, error: TALK_CHAT_LOAD_FAILED })),
      failureMessage(fail({ kind: "network" })),
      failureMessage(fail({ kind: "timeout" })),
    ]
    expect(new Set(lines).size).toBe(3)
    for (const l of lines) expect(l).not.toMatch(/no messages/i)
  })
})

describe("fetchChatAnswer", () => {
  const okRes = (data: unknown) => ({ ok: true, status: 200, json: async () => data })
  it("an answer comes back as data", async () => {
    const r = await fetchChatAnswer("/x", async () => okRes({ messages: [] }))
    expect(r).toMatchObject({ ok: true, data: { messages: [] } })
  })
  it("a server refusal keeps its status and its own words", async () => {
    const r = await fetchChatAnswer("/x", async () => ({ ok: false, status: 403, json: async () => ({ error: "denied" }) }))
    expect(r).toMatchObject({ ok: false, kind: "http", status: 403, error: "denied" })
  })
  it("a server fault with a body that is not JSON is still a fault", async () => {
    const r = await fetchChatAnswer("/x", async () => ({ ok: false, status: 502, json: async () => { throw new Error("html") } }))
    expect(r).toMatchObject({ ok: false, kind: "http", status: 502 })
  })
  it("a dropped connection is a network failure, not an empty chat", async () => {
    const r = await fetchChatAnswer("/x", async () => { throw new TypeError("Load failed") })
    expect(r).toMatchObject({ ok: false, kind: "network" })
  })
  it("a 200 that is not the server's JSON (a Wi-Fi sign-in page) is a failure too", async () => {
    const r = await fetchChatAnswer("/x", async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("<html>") } }))
    expect(r).toMatchObject({ ok: false, kind: "network" })
  })
  it("no answer in time is a timeout", async () => {
    const r = await fetchChatAnswer("/x", (_u, init) => new Promise((_res, rej) => { init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))) }), 20)
    expect(r).toMatchObject({ ok: false, kind: "timeout" })
    expect(CHAT_LOAD_TIMEOUT_MS).toBeGreaterThan(5000)
  })
})

describe("the report that makes a real phone's cause visible", () => {
  it("names the event, the first failure and the situation — and carries no message text or names", () => {
    const rep = buildLoadReport({
      event: "recovered", threadId: "t1", attempts: 2, firstFailure: { kind: "http", status: 500, elapsedMs: 1200 },
      limit: 500, hadMessageLink: true, hadSavedCopy: true, visibility: "visible", online: true,
    })
    expect(rep.message).toBe("talk_chat_load_recovered")
    expect(rep.level).toBe("warning")
    expect(rep.tags.failure).toBe("http_500")
    expect(Object.keys(rep.extra).sort()).toEqual(["attempts", "event", "firstFailure", "hadMessageLink", "hadSavedCopy", "limit", "online", "threadId", "visibility"])
    expect(buildLoadReport({ event: "failed", threadId: "t", attempts: 3, limit: 60, hadMessageLink: false, hadSavedCopy: false, visibility: "hidden", online: false }).level).toBe("error")
  })
})

// ── the server's answer, with a fake database that can fail ──
type Row = Record<string, unknown>
function fakeDb(tables: Record<string, Row[] | Row | null>, o: { errors?: Record<string, { code?: string; message: string }>; pinsError?: boolean } = {}) {
  const upserts: Row[] = []
  const builder = (table: string) => {
    let op = "select"
    let single = false
    let limit: number | null = null
    let usedNot = false
    let upsertRow: Row | null = null
    const b: Record<string, unknown> = {}
    for (const n of ["select", "eq", "in", "is", "order"]) b[n] = () => b
    b.not = () => { usedNot = true; return b }
    b.limit = (n: number) => { limit = n; return b }
    b.single = () => { single = true; return b }
    b.maybeSingle = () => { single = true; return b }
    b.upsert = (row: Row) => { op = "upsert"; upsertRow = row; return b }
    b.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
      const run = async () => {
        if (op === "upsert") { upserts.push(upsertRow as Row); return { data: null, error: null } }
        if (o.errors?.[table] && !(table === "internal_messages" && usedNot)) return { data: null, error: o.errors[table] }
        if (o.pinsError && table === "internal_messages" && usedNot) return { data: null, error: { message: "pins down" } }
        const t = tables[table]
        if (single) return { data: Array.isArray(t) ? (t[0] ?? null) : (t ?? null), error: null }
        const rows = (Array.isArray(t) ? t : t ? [t] : []) as Row[]
        return { data: limit ? rows.slice(0, limit) : rows, error: null }
      }
      return run().then(resolve, reject)
    }
    return b
  }
  return { client: { from: (t: string) => builder(t) }, upserts }
}
const base = { threadId: "t1", userId: "me", userName: "Me", isAdmin: false, limit: 60, markRead: true, deniedMessage: "denied", listGroupMemberIds: async () => [] as string[] }
const msgs = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `m${n - i}`, message: `hi ${n - i}`, created_at: `2026-11-24T10:${String(59 - i).padStart(2, "0")}:00Z`, reply_to_id: null }))
const dm = { id: "t1", thread_type: "dm", dm_key: "me:peer" }
const group = { id: "t1", thread_type: "group", dm_key: null }

describe("the server: a failed lookup is a fault, never an empty chat", () => {
  it("a failed messages lookup answers 500 and does NOT mark the chat read", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const f = fakeDb({ internal_threads: dm, internal_messages: msgs(3) }, { errors: { internal_messages: { message: "timeout" } } })
    const r = await buildTalkChatAnswer(f.client, base)
    expect(r.status).toBe(500)
    expect((r.body as { error: string }).error).toBe(TALK_CHAT_LOAD_FAILED)
    expect(f.upserts).toHaveLength(0) // the unread signal stays
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
  it("a failed chat-row lookup is a fault (500), but a chat that really is not there stays 404", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const down = await buildTalkChatAnswer(fakeDb({}, { errors: { internal_threads: { code: "57014", message: "statement timeout" } } }).client, base)
    expect(down.status).toBe(500)
    const gone = await buildTalkChatAnswer(fakeDb({}, { errors: { internal_threads: { code: "PGRST116", message: "no rows" } } }).client, base)
    expect(gone.status).toBe(404)
    const missing = await buildTalkChatAnswer(fakeDb({ internal_threads: null }).client, base)
    expect(missing.status).toBe(404)
    spy.mockRestore()
  })
  it("a failed members lookup on a group is a fault, not 'You are not in this group'", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const f = fakeDb({ internal_threads: group, internal_messages: msgs(2) })
    const r = await buildTalkChatAnswer(f.client, { ...base, listGroupMemberIds: async () => { throw new Error("members down") } })
    expect(r.status).toBe(500)
    expect(f.upserts).toHaveLength(0)
    spy.mockRestore()
  })
  it("a person who is refused is still refused (403), even when the messages lookup also failed", async () => {
    const f = fakeDb({ internal_threads: { id: "t1", thread_type: "dm", dm_key: "a:b" }, internal_messages: msgs(2) }, { errors: { internal_messages: { message: "x" } } })
    const r = await buildTalkChatAnswer(f.client, base)
    expect(r.status).toBe(403)
    expect(f.upserts).toHaveLength(0)
  })
  it("a failed pins lookup leaves older_pins OUT (an empty list would clear the pinned bar)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const f = fakeDb({ internal_threads: dm, internal_messages: msgs(2) }, { pinsError: true })
    const r = await buildTalkChatAnswer(f.client, base)
    expect(r.status).toBe(200)
    expect("older_pins" in (r.body as Record<string, unknown>)).toBe(false)
    spy.mockRestore()
  })
  it("a good answer still carries older_pins and still marks the chat read", async () => {
    const f = fakeDb({ internal_threads: dm, internal_messages: msgs(2) })
    const r = await buildTalkChatAnswer(f.client, base)
    expect(r.status).toBe(200)
    expect(Array.isArray((r.body as Record<string, unknown>).older_pins)).toBe(true)
    expect(f.upserts).toHaveLength(1)
  })
  it("a chat that really has no messages is a normal empty answer (so 'No messages yet' is still true for it)", async () => {
    const f = fakeDb({ internal_threads: dm, internal_messages: [] })
    const r = await buildTalkChatAnswer(f.client, base)
    expect(r.status).toBe(200)
    expect((r.body as { messages: unknown[] }).messages).toEqual([])
  })
})

describe("wiring", () => {
  const app = read("components/talk/talk-app.tsx")
  const view = read("components/talk/talk-messages.tsx")
  const route = read("app/api/team/threads/[id]/route.ts")
  it("TD Talk's chat answer uses the lookup that throws on a fault", () => {
    expect(route).toContain("listGroupMemberIds: listGroupMemberIdsStrict")
    expect(read("lib/team/groups.ts")).toContain("if (error) throw error")
  })
  it("the chat is loaded through the retrying, time-limited fetch, and a failure is reported", () => {
    expect(app).toContain("await fetchChatAnswer(")
    expect(app).toContain("withChatView(markReadQuery, limitUsed)")
    expect(app).toContain("const steps = silent ? [LOAD_STEPS[0]] : LOAD_STEPS")
    expect(app).toContain("reportTalkLoad({ event: 'failed'")
    expect(app).toContain("reportTalkLoad({ event: 'recovered'")
  })
  it("the read-rule line is unchanged", () => {
    expect(app).toContain("isBeingViewed() ? '' : '?mark_read=0'")
  })
  it("choosing the chat that is already chosen changes nothing, and the address change compares with what select() chose", () => {
    expect(app).toContain("if (id !== null && id === lastSelectedRef.current) return")
    expect(app).toContain("urlThread === lastSelectedRef.current")
    expect(app).toContain("if (lastSelectedRef.current === urlThread) return")
  })
  it("a load that was overtaken by another chat is ignored, and only the current load ends the 'Loading…'", () => {
    expect(app).not.toContain("if (selectedIdRef.current !== threadId) return // switched chats while loading") // the old thread-id check (it let A → B → A through)
    expect(app).toContain("selectSeqRef.current !== seq")
    expect(app).toContain("if (!silent && !guessGone && selectSeqRef.current === seq) setLoadingMsgs(false)")
  })
  it("one load per chat at a time, and coming back online or from the cache tries again", () => {
    expect(app).toContain("running.threadId === threadId && running.seq === seq && running.silent === silent")
    expect(app).toContain("window.addEventListener('online', onVisible)")
    expect(app).toContain("window.addEventListener('pageshow', onVisible)")
  })
  it("the screen draws a failed load as 'Could not load this chat' with Retry, never as an empty chat, and only when TD Talk asks for it", () => {
    expect(app).toContain("loadError={loadFailed && loadFailed.threadId === selected.id")
    const failedBlock = view.indexOf("groups.length === 0 && loadError")
    const emptyBlock = view.indexOf("groups.length === 0 ? (\n")
    expect(failedBlock).toBeGreaterThan(0)
    expect(failedBlock).toBeLessThan(emptyBlock) // the failure is decided before the empty wording
    expect(view).toContain("data-testid=\"talk-load-retry\"")
    expect(read("components/marketing/lead-chat.tsx")).not.toContain("loadError={") // TD Marketing has its own load error; it passes nothing to the shared screen
    expect(view).toContain("loadError?:") // optional: anything that does not pass it (TD Marketing's chats) is drawn exactly as before
  })
})
