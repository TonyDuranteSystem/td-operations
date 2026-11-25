/**
 * A TD Talk chat that could not be loaded is never drawn as an empty chat (Antonio, 2026-11-24: tapping a lock-screen alert opened TD Talk with
 * "No messages yet. Say hello."). Three layers: the load rules (lib/talk/chat-load.ts), the server's answer (a failed lookup is a fault and does NOT
 * move the read pointer) and the screen's wiring.
 */
import { describe, it, expect, vi } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import {
  BAD_ANSWER, CHAT_LOAD_TIMEOUT_MS, LOAD_STEPS, SIGNED_OUT_MESSAGE, buildLoadReport, canRetryAfter, classifyFailure, failureMessage, fetchChatAnswer,
  isRetryable, isSignedOut, runChatLoad, sameLoad, type ChatFetchResult, type ChatLoadFailure, type RunChatLoadArgs,
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

describe("sign-in, damaged answers and what a failure means for the screen", () => {
  it("an ended sign-in is said as such, and has no Try again (a second try can never fix it)", () => {
    for (const f of [fail({ kind: "http", status: 401 }), fail({ kind: "http", status: 403, error: "Unauthorized" })]) {
      expect(isSignedOut(f)).toBe(true)
      expect(failureMessage(f)).toBe(SIGNED_OUT_MESSAGE)
      expect(canRetryAfter(f)).toBe(false)
    }
    expect(isSignedOut(fail({ kind: "http", status: 403, error: "You are not in this group." }))).toBe(false)
  })
  it("Try again only where a second try can help", () => {
    expect(canRetryAfter(fail({ kind: "network" }))).toBe(true)
    expect(canRetryAfter(fail({ kind: "timeout" }))).toBe(true)
    expect(canRetryAfter(fail({ kind: "http", status: 500 }))).toBe(true)
    expect(canRetryAfter(fail({ kind: "http", status: 404, error: "Thread not found" }))).toBe(false)
    expect(canRetryAfter(fail({ kind: "http", status: 403, error: "denied" }))).toBe(false)
  })
  it("a damaged answer has its own line", () => {
    expect(failureMessage(fail({ kind: "network", error: BAD_ANSWER }))).toMatch(/could not be read/i)
  })
  it("before the chat list is in, a refused or missing chat is only a guess; an ended sign-in never is", () => {
    expect(classifyFailure(fail({ kind: "http", status: 404 }), false)).toBe("guess")
    expect(classifyFailure(fail({ kind: "http", status: 403, error: "denied" }), false)).toBe("guess")
    expect(classifyFailure(fail({ kind: "http", status: 403, error: "Unauthorized" }), false)).toBe("failed")
    expect(classifyFailure(fail({ kind: "http", status: 401 }), false)).toBe("failed")
    expect(classifyFailure(fail({ kind: "http", status: 404 }), true)).toBe("failed")
    expect(classifyFailure(fail({ kind: "network" }), false)).toBe("failed")
    expect(classifyFailure(fail({ kind: "http", status: 500 }), false)).toBe("failed")
  })
  it("two loads are the same one only when chat, choice, silent mode and read mode all match", () => {
    const k = { threadId: "a", seq: 1, silent: true, viewed: false }
    expect(sameLoad(k, { ...k })).toBe(true)
    expect(sameLoad(k, { ...k, threadId: "b" })).toBe(false)
    expect(sameLoad(k, { ...k, seq: 2 })).toBe(false)
    expect(sameLoad(k, { ...k, silent: false })).toBe(false)
    // "I am looking at it now" must not be swallowed by a request made while the person was away
    expect(sameLoad(k, { ...k, viewed: true })).toBe(false)
  })
})

// ── the ladder, run for real over fake parts ──
const okAnswer = (data: unknown = { messages: [{ id: "m1" }] }): ChatFetchResult => ({ ok: true, data, elapsedMs: 3 })
const failed = (f: Partial<ChatLoadFailure> & { kind: ChatLoadFailure["kind"] }): ChatFetchResult => ({ ok: false, elapsedMs: 4, ...f })

function ladder(script: ChatFetchResult[], over: Partial<RunChatLoadArgs> = {}) {
  const urls: string[] = []
  const waits: number[] = []
  const applied: Array<{ data: unknown; viewed: boolean }> = []
  const lights: boolean[] = []
  let beforeCount = 0
  const args: RunChatLoadArgs = {
    silent: false,
    isCurrent: () => true,
    newerGoodAnswer: () => false,
    viewedNow: () => true,
    limitFor: light => { lights.push(light); return light ? 60 : 500 },
    urlFor: (q, limit) => `/chat${q}${q ? "&" : "?"}limit=${limit}`,
    fetchAnswer: async url => { urls.push(url); return script[Math.min(urls.length - 1, script.length - 1)] },
    apply: (data, viewed) => { applied.push({ data, viewed }); return true },
    wait: async ms => { waits.push(ms) },
    beforeAttempt: () => { beforeCount += 1 },
    ...over,
  }
  return { run: () => runChatLoad(args), urls, waits, applied, lights, before: () => beforeCount }
}

describe("runChatLoad: the open-a-chat ladder", () => {
  it("an answer on the first try is applied at once, with no waiting", async () => {
    const l = ladder([okAnswer()])
    const out = await l.run()
    expect(out).toMatchObject({ kind: "applied", attempts: 1, first: null })
    expect(l.waits).toEqual([])
    expect(l.applied).toHaveLength(1)
    expect(l.urls).toEqual(["/chat?limit=500"])
  })
  it("a first request that fails is tried again by itself and the person never sees a failure", async () => {
    const l = ladder([failed({ kind: "network" }), okAnswer()])
    const out = await l.run()
    expect(out).toMatchObject({ kind: "applied", attempts: 2 })
    expect((out as { first: ChatLoadFailure }).first.kind).toBe("network")
    expect(l.waits).toEqual([500])
  })
  it("a server fault twice then an answer: three tries, the third is the light request", async () => {
    const l = ladder([failed({ kind: "http", status: 500 }), failed({ kind: "http", status: 500 }), okAnswer()])
    const out = await l.run()
    expect(out).toMatchObject({ kind: "applied", attempts: 3 })
    expect(l.waits).toEqual([500, 1500])
    expect(l.lights).toEqual([false, false, true])
    expect(l.urls[2]).toBe("/chat?limit=60")
  })
  it("every try failing ends as failed, with the first and the last failure", async () => {
    const l = ladder([failed({ kind: "timeout" }), failed({ kind: "http", status: 502 }), failed({ kind: "network" })])
    const out = await l.run()
    expect(out.kind).toBe("failed")
    const f = out as { attempts: number; first: ChatLoadFailure; last: ChatLoadFailure }
    expect(f.attempts).toBe(3)
    expect(f.first.kind).toBe("timeout")
    expect(f.last.kind).toBe("network")
    expect(l.applied).toHaveLength(0)
  })
  it("a refusal or a missing chat stops at once (no waiting, no second try)", async () => {
    const l = ladder([failed({ kind: "http", status: 404, error: "Thread not found" })])
    const out = await l.run()
    expect(out).toMatchObject({ kind: "failed", attempts: 1 })
    expect(l.waits).toEqual([])
    expect(l.urls).toHaveLength(1)
  })
  it("the READ RULE is asked before EVERY try: a retry after the person left the screen does not mark the chat read", async () => {
    const seen = [true, false, false]
    let i = 0
    const l = ladder([failed({ kind: "network" }), okAnswer()], { viewedNow: () => seen[i++] })
    const out = await l.run()
    expect(out.kind).toBe("applied")
    expect(l.urls[0]).toBe("/chat?limit=500") // looking at it: the server may mark it read
    expect(l.urls[1]).toBe("/chat?mark_read=0&limit=500") // gone by the second try: reads without marking
    expect(l.applied[0].viewed).toBe(false) // so the list's number is not cleared either
  })
  it("a load that was overtaken by another chat does nothing more: no request after the wait, no apply after the answer", async () => {
    let current = true
    const l = ladder([failed({ kind: "network" }), okAnswer()], { isCurrent: () => current, wait: async () => { current = false } })
    expect((await l.run()).kind).toBe("ignored")
    expect(l.urls).toHaveLength(1) // the second try never went out
    const l2 = ladder([okAnswer()], { isCurrent: () => false })
    expect((await l2.run()).kind).toBe("ignored")
    expect(l2.applied).toHaveLength(0)
    // chosen away while the request was on its way
    let live = true
    const l3 = ladder([okAnswer()], { isCurrent: () => live, fetchAnswer: async () => { live = false; return okAnswer() } })
    expect((await l3.run()).kind).toBe("ignored")
    expect(l3.applied).toHaveLength(0)
  })
  it("when a background refresh got through while the open was still trying, the open stops and is NOT reported failed", async () => {
    let good = false
    const l = ladder([failed({ kind: "network" })], { newerGoodAnswer: () => good, fetchAnswer: async () => { good = true; return failed({ kind: "network" }) } })
    expect((await l.run()).kind).toBe("ignored")
    const l2 = ladder([okAnswer()], { newerGoodAnswer: () => true })
    expect((await l2.run()).kind).toBe("ignored")
    expect(l2.urls).toHaveLength(0)
  })
  it("an answer the screen cannot use is tried again like any failure, and a good one then works", async () => {
    let n = 0
    const l = ladder([okAnswer(null), okAnswer()], { apply: (data, viewed) => { n += 1; if (n === 1) throw new TypeError("null"); l.applied.push({ data, viewed }); return true } })
    const out = await l.run()
    expect(out).toMatchObject({ kind: "applied", attempts: 2 })
    expect((out as { first: ChatLoadFailure }).first).toMatchObject({ kind: "network", error: BAD_ANSWER })
  })
  it("an answer that is unusable every time ends as failed (never as an empty chat)", async () => {
    const l = ladder([okAnswer(null)], { apply: () => { throw new TypeError("null") } })
    const out = await l.run()
    expect(out.kind).toBe("failed")
    expect(failureMessage((out as { last: ChatLoadFailure }).last)).toMatch(/could not be read/i)
  })
  it("an answer the caller chooses to ignore ends the load quietly", async () => {
    const l = ladder([okAnswer()], { apply: () => false })
    expect((await l.run()).kind).toBe("ignored")
  })
  it("a background refresh makes ONE try and never waits", async () => {
    const l = ladder([failed({ kind: "network" })], { silent: true })
    const out = await l.run()
    expect(out).toMatchObject({ kind: "failed", attempts: 1 })
    expect(l.waits).toEqual([])
    expect(l.urls).toHaveLength(1)
  })
  it("a background refresh ignores the 'newer answer' rule (it is the newer answer)", async () => {
    const l = ladder([okAnswer()], { silent: true, newerGoodAnswer: () => true })
    expect((await l.run()).kind).toBe("applied")
  })
  it("the screen is told before each try (a tapped message link is kept alive while its chat loads)", async () => {
    const l = ladder([failed({ kind: "network" }), failed({ kind: "network" }), okAnswer()])
    await l.run()
    expect(l.before()).toBe(3)
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
    // an id that is not even a uuid (a mistyped link) is "no such chat" too, not a fault
    const notUuid = await buildTalkChatAnswer(fakeDb({}, { errors: { internal_threads: { code: "22P02", message: 'invalid input syntax for type uuid: "x"' } } }).client, base)
    expect(notUuid.status).toBe(404)
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
  it("the screen loads a chat through the ladder, asks the read rule per try, and reports failures", () => {
    expect(app).toContain("await runChatLoad({")
    expect(app).toContain("viewedNow: () => isBeingViewed()")
    expect(app).toContain("fetchAnswer: fetchChatAnswer")
    expect(app).toContain("reportTalkLoad({ event: 'failed'")
    expect(app).toContain("reportTalkLoad({ event: 'recovered'")
    expect(read("lib/talk/chat-load.ts")).toContain("viewed ? '' : '?mark_read=0'")
  })
  it("a caller holding the previous chat's id can never load it into the chat just chosen", () => {
    expect(app).toContain("if (lastSelectedRef.current !== threadId) return Promise.resolve()")
    expect(app).toContain("if (lastSelectedRef.current) void loadMessages(lastSelectedRef.current, { silent: true })")
    expect(app).toContain("const isCurrent = () => selectSeqRef.current === seq && lastSelectedRef.current === threadId")
  })
  it("choosing the chat that is already chosen changes nothing, and the address change compares with what select() chose", () => {
    expect(app).toContain("if (id !== null && id === lastSelectedRef.current) return")
    expect(app).toContain("urlThread === lastSelectedRef.current")
    expect(app).toContain("if (lastSelectedRef.current === urlThread) return")
  })
  it("a guessed chat that the list still has is shown as a failure once the list has answered (or failed)", () => {
    expect(app).toContain("guessRef.current = shown")
    expect(app).toContain("resolveGuess()")
    expect(app).toContain("if (cancelled || !list) { resolveGuess(); setBooting(false); return }")
  })
  it("one chat load and one chat-list load at a time; the list after Back is always fresh", () => {
    expect(app).toContain("if (running && sameLoad(running.key, key)) return running.promise")
    expect(app).toContain("if (!fresh && listInflightRef.current) return listInflightRef.current")
    expect(app).toContain("if (id === null) void loadThreads(true)")
    expect(app).toContain("setBootError(null)")
  })
  it("coming back online tries again; the browser-cache page show only when the page came from the cache", () => {
    expect(app).toContain("window.addEventListener('online', onVisible)")
    expect(app).toContain("if (e.persisted) onVisible()")
    expect(app).not.toContain("window.addEventListener('pageshow', onVisible)")
  })
  it("a chat that failed to load keeps its unread number (the server did not mark it read)", () => {
    expect(app).toContain("unreadTotal(chats, selectedId, isBeingViewed() && !loadFailed)")
    expect(app).toContain("isBeingViewed() && !(loadFailed && loadFailed.threadId === t.id)")
  })
  it("Try again says it is working, and an ended sign-in has no Try again", () => {
    expect(app).toContain("setRetrying(true)")
    expect(app).toContain("onRetry: loadFailed.canRetry ? retryLoad : undefined")
    expect(view).toContain('data-testid="talk-retrying"')
    expect(view).toContain("{loadError.onRetry && <button")
  })
  it("the screen draws a failed load as 'Could not load this chat', never as an empty chat, and only when TD Talk asks for it", () => {
    expect(app).toContain("loadError={loadFailed && loadFailed.threadId === selected.id")
    const failedBlock = view.indexOf("groups.length === 0 && loadError")
    const emptyBlock = view.indexOf("groups.length === 0 ? (\n")
    expect(failedBlock).toBeGreaterThan(0)
    expect(failedBlock).toBeLessThan(emptyBlock)
    expect(view).toContain('data-testid="talk-load-retry"')
    expect(read("components/marketing/lead-chat.tsx")).not.toContain("loadError={") // TD Marketing has its own load error; it passes nothing to the shared screen
    expect(view).toContain("loadError?:") // optional
  })
})
