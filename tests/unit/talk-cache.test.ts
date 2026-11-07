/**
 * TD Talk inside the TD Social phone app — "opens slowly" fix A + B (dev job 2072bc3e, 6 Nov 2026).
 * A: the phone keeps the last chat list and the newest messages of the open chat and shows them at once; the server's answer replaces them.
 * B: with no saved copy, the chat you were in is asked for TOGETHER with the list, not after it.
 * The rules are pure (lib/talk/talk-cache.ts) and the screen is wired by reading its source, as the other app-mode guards do.
 */
import { describe, it, expect } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { readFileSync } from "fs"
import { join } from "path"
import {
  TALK_CACHE_KEY, TALK_CACHE_KEEP_MESSAGES, TALK_CACHE_KEEP_CHATS, TALK_CACHE_MAX_BYTES, TALK_CACHE_CHAT_MAX_AGE_MS, TALK_CACHE_MAX_AGE_MS, TalkSavedStore, afterListChoice, earlyChatChoice, fastOpenEnabled,
  parseSaved, serializeSaved, trimChatPayload, type TalkSaved,
} from "@/lib/talk/talk-cache"
import { TalkViewerProvider, useTalkViewerId } from "@/components/talk/talk-viewer"

const NOW = Date.UTC(2026, 10, 6, 12, 0, 0)
const ME = "user-1"
const list = { threads: [{ id: "t1", thread_type: "dm" }], members: [{ id: "u2", name: "Luca" }], current_user_id: ME }
const msgs = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `m${i}`, message: `hello ${i}`, created_at: new Date(NOW - (n - i) * 1000).toISOString() }))
const saved = (over: Partial<TalkSaved> = {}): TalkSaved => ({ v: 1, userId: ME, savedAt: NOW - 1000, list, chat: null, ...over })

function fakeStorage(opts: { throwOnSet?: boolean; throwOnGet?: boolean } = {}) {
  const data = new Map<string, string>()
  const calls = { set: 0, remove: 0 }
  return {
    data, calls,
    getItem: (k: string) => { if (opts.throwOnGet) throw new Error("blocked"); return data.has(k) ? (data.get(k) as string) : null },
    setItem: (k: string, v: string) => { if (opts.throwOnSet) throw new Error("full"); calls.set++; data.set(k, v) },
    removeItem: (k: string) => { calls.remove++; data.delete(k) },
  }
}

describe("trimChatPayload", () => {
  it("keeps a short chat as it is", () => {
    const p = { messages: msgs(5), has_more: false }
    expect(trimChatPayload(p)).toEqual({ messages: msgs(5), has_more: false })
  })
  it("keeps only the newest messages of a long chat and says there are older ones", () => {
    const out = trimChatPayload({ messages: msgs(TALK_CACHE_KEEP_MESSAGES + 25), has_more: false, peer_read_at: "x" })
    const kept = out.messages as { id: string }[]
    expect(kept).toHaveLength(TALK_CACHE_KEEP_MESSAGES)
    expect(kept[kept.length - 1].id).toBe(`m${TALK_CACHE_KEEP_MESSAGES + 24}`) // the newest is still there
    expect(kept[0].id).toBe("m25")
    expect(out.has_more).toBe(true)
    expect(out.peer_read_at).toBe("x") // everything else the server sent is kept
  })
  it("a damaged answer becomes an empty chat, never a crash", () => {
    expect(trimChatPayload({ messages: "nope" }).messages).toEqual([])
    expect(trimChatPayload({}).messages).toEqual([])
  })
})

describe("parseSaved: only a good copy for THIS person is shown", () => {
  it("round-trips a good copy", () => {
    const s = saved({ chat: { id: "t1", payload: { messages: msgs(3) } } })
    expect(parseSaved(serializeSaved(s), ME, NOW)).toEqual(s)
  })
  it("nothing, garbage, or the wrong shape: null", () => {
    expect(parseSaved(null, ME, NOW)).toBeNull()
    expect(parseSaved("", ME, NOW)).toBeNull()
    expect(parseSaved("{not json", ME, NOW)).toBeNull()
    expect(parseSaved("[]", ME, NOW)).toBeNull()
    expect(parseSaved(JSON.stringify({ v: 2 }), ME, NOW)).toBeNull()
    expect(parseSaved(JSON.stringify({ ...saved(), list: { threads: "x", members: [] } }), ME, NOW)).toBeNull()
    expect(parseSaved(JSON.stringify({ ...saved(), savedAt: "yesterday" }), ME, NOW)).toBeNull()
  })
  it("a copy saved for someone else is never shown", () => {
    expect(parseSaved(serializeSaved(saved({ userId: "user-2" })), ME, NOW)).toBeNull()
    // ...nor a list that says it belongs to someone else, whatever the label says
    expect(parseSaved(serializeSaved(saved({ list: { ...list, current_user_id: "user-2" } })), ME, NOW)).toBeNull()
    expect(parseSaved(serializeSaved(saved()), "", NOW)).toBeNull()
  })
  it("a copy older than 14 days (or dated far in the future) is ignored", () => {
    expect(parseSaved(serializeSaved(saved({ savedAt: NOW - TALK_CACHE_MAX_AGE_MS - 1 })), ME, NOW)).toBeNull()
    expect(parseSaved(serializeSaved(saved({ savedAt: NOW - TALK_CACHE_MAX_AGE_MS + 60_000 })), ME, NOW)).not.toBeNull()
    expect(parseSaved(serializeSaved(saved({ savedAt: NOW + 3 * 24 * 3600 * 1000 })), ME, NOW)).toBeNull()
  })
  it("a damaged chat part is dropped but the list is still used", () => {
    const raw = JSON.stringify({ ...saved(), chat: { id: "t1", payload: { messages: "bad" } } })
    const out = parseSaved(raw, ME, NOW)
    expect(out?.chat).toBeNull()
    expect(out?.list.threads).toHaveLength(1)
  })
})

describe("TalkSavedStore keeps several recent chats (dev job cf265457: opening a chat shows its saved messages at once)", () => {
  const fresh = (t = NOW) => { const st = fakeStorage(); const store = new TalkSavedStore(ME, st, () => t); store.saveList(list); return { st, store } }
  it("the chat loaded last is first, the ones before it are kept, each chat once", () => {
    const { st, store } = fresh()
    store.saveChat("a", { messages: msgs(2) }); store.saveChat("b", { messages: msgs(3) }); store.saveChat("a", { messages: msgs(4) })
    const read = new TalkSavedStore(ME, st, () => NOW).read()
    expect(read?.chat?.id).toBe("a")
    expect((read?.chat?.payload.messages as unknown[]).length).toBe(4)
    expect(read?.more?.map(c => c.id)).toEqual(["b"])
  })
  it("keeps at most TALK_CACHE_KEEP_CHATS chats; the least recently opened goes first", () => {
    const { st, store } = fresh()
    for (let i = 0; i < TALK_CACHE_KEEP_CHATS + 3; i++) store.saveChat(`c${i}`, { messages: msgs(1) })
    const read = new TalkSavedStore(ME, st, () => NOW).read()
    const ids = [read?.chat?.id, ...(read?.more ?? []).map(c => c.id)]
    expect(ids).toHaveLength(TALK_CACHE_KEEP_CHATS)
    expect(ids[0]).toBe(`c${TALK_CACHE_KEEP_CHATS + 2}`)
    expect(ids).not.toContain("c0")
  })
  it("chatFor finds any kept chat and nothing else", () => {
    const { store } = fresh()
    store.saveChat("a", { messages: msgs(2) }); store.saveChat("b", { messages: msgs(3) })
    expect(store.chatFor("a")?.id).toBe("a")
    expect(store.chatFor("b")?.id).toBe("b")
    expect(store.chatFor("zzz")).toBeNull()
    expect(store.chatFor("")).toBeNull()
  })
  it("chatFor works on a copy read from the phone's storage, and survives a new chat list", () => {
    const { st, store } = fresh()
    store.saveChat("a", { messages: msgs(2) }); store.saveChat("b", { messages: msgs(3) })
    const next = new TalkSavedStore(ME, st, () => NOW)
    next.read()
    expect(next.chatFor("a")?.id).toBe("a")
    next.saveList({ ...list, threads: [{ id: "t9", thread_type: "dm" }] })
    expect(next.chatFor("a")?.id).toBe("a") // a new list keeps every saved chat, not just the first
    expect(next.chatFor("b")?.id).toBe("b")
  })
  it("a chat not refreshed for days is not shown (it could be days behind)", () => {
    let t = NOW
    const st = fakeStorage()
    const store = new TalkSavedStore(ME, st, () => t)
    store.saveList(list); store.saveChat("a", { messages: msgs(2) })
    t += TALK_CACHE_CHAT_MAX_AGE_MS - 1000
    expect(store.chatFor("a")?.id).toBe("a")
    t += 2000
    expect(store.chatFor("a")).toBeNull()
  })
  it("a copy saved before several chats were kept (one chat, no stamp) still opens", () => {
    const st = fakeStorage()
    st.data.set(TALK_CACHE_KEY, JSON.stringify(saved({ chat: { id: "old", payload: { messages: msgs(2) } } })))
    const store = new TalkSavedStore(ME, st, () => NOW)
    store.read()
    expect(store.chatFor("old")?.id).toBe("old")
  })
  it("a refresh that changed nothing does not rewrite storage; a changed chat does", () => {
    let t = NOW
    const st = fakeStorage()
    const store = new TalkSavedStore(ME, st, () => t)
    store.saveList(list)
    store.saveChat("a", { messages: msgs(3) })
    const writes = st.calls.set
    t += 10_000; store.saveChat("a", { messages: msgs(3) })
    t += 10_000; store.saveChat("a", { messages: msgs(3) })
    expect(st.calls.set).toBe(writes)
    t += 10_000; store.saveChat("a", { messages: msgs(4) })
    expect(st.calls.set).toBe(writes + 1)
  })
  it("stays under the storage budget by dropping the least recently opened chats, never the one opened last", () => {
    const { st, store } = fresh()
    const big = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `m${i}`, message: "x".repeat(4000), created_at: new Date(NOW - i * 1000).toISOString() }))
    for (let i = 0; i < TALK_CACHE_KEEP_CHATS; i++) store.saveChat(`c${i}`, { messages: big(TALK_CACHE_KEEP_MESSAGES) })
    const raw = st.data.get(TALK_CACHE_KEY) as string
    expect(raw.length).toBeLessThanOrEqual(TALK_CACHE_MAX_BYTES)
    const read = new TalkSavedStore(ME, st, () => NOW).read()
    expect(read?.chat?.id).toBe(`c${TALK_CACHE_KEEP_CHATS - 1}`)
    expect((read?.more ?? []).length).toBeLessThan(TALK_CACHE_KEEP_CHATS - 1)
  })
  it("saved chats are only ever shown: the store has no way to mark anything read", () => {
    const src = readFileSync(join(process.cwd(), "lib/talk/talk-cache.ts"), "utf8")
    expect(src).not.toMatch(/fetch\(|mark_read|\/read\b/)
  })
})

describe("TalkSavedStore", () => {
  it("reads nothing at first, then what was saved", () => {
    const st = fakeStorage()
    const store = new TalkSavedStore(ME, st, () => NOW)
    expect(store.read()).toBeNull()
    store.saveList(list)
    const again = new TalkSavedStore(ME, st, () => NOW + 5000).read()
    expect(again?.list.threads).toEqual(list.threads)
    expect(again?.chat).toBeNull()
  })
  it("a chat that arrives before the list (they are asked for together) waits and is saved with the list", () => {
    const st = fakeStorage()
    const store = new TalkSavedStore(ME, st, () => NOW)
    store.saveChat("t1", { messages: msgs(3) })
    expect(st.calls.set).toBe(0) // a chat without its list would open to nothing: nothing is written yet
    store.saveList(list)
    expect(st.calls.set).toBe(1)
    const read = new TalkSavedStore(ME, st, () => NOW).read()
    expect(read?.chat?.id).toBe("t1")
    expect((read?.chat?.payload.messages as unknown[]).length).toBe(3)
  })
  it("saves a chat one at a time, cut to the newest messages", () => {
    const st = fakeStorage()
    const store = new TalkSavedStore(ME, st, () => NOW)
    store.saveList(list)
    store.saveChat("t1", { messages: msgs(TALK_CACHE_KEEP_MESSAGES + 10) })
    const read = new TalkSavedStore(ME, st, () => NOW).read()
    expect(read?.chat?.id).toBe("t1")
    expect((read?.chat?.payload.messages as unknown[]).length).toBe(TALK_CACHE_KEEP_MESSAGES)
    store.saveChat("t2", { messages: msgs(2) })
    expect(new TalkSavedStore(ME, st, () => NOW).read()?.chat?.id).toBe("t2")
  })
  it("a new chat list keeps the saved chat", () => {
    const st = fakeStorage()
    const store = new TalkSavedStore(ME, st, () => NOW)
    store.saveList(list)
    store.saveChat("t1", { messages: msgs(4) })
    store.saveList({ ...list, threads: [{ id: "t1", thread_type: "dm" }, { id: "t9", thread_type: "dm" }] })
    const read = new TalkSavedStore(ME, st, () => NOW).read()
    expect(read?.chat?.id).toBe("t1")
    expect(read?.list.threads).toHaveLength(2)
  })
  it("a list answer that is not a list is not saved", () => {
    const st = fakeStorage()
    new TalkSavedStore(ME, st, () => NOW).saveList({ threads: "x", members: [] })
    expect(st.calls.set).toBe(0)
  })
  it("the 10-second refresh with nothing new does not rewrite the phone's storage, a change does, and an unchanged copy is re-stamped after hours", () => {
    const st = fakeStorage()
    let t = NOW
    const store = new TalkSavedStore(ME, st, () => t)
    store.saveList(list)
    expect(st.calls.set).toBe(1)
    t += 10_000; store.saveList(list)
    expect(st.calls.set).toBe(1)
    t += 10_000; store.saveList({ ...list, members: [] })
    expect(st.calls.set).toBe(2)
    t += 10_000; store.saveList({ ...list, members: [] })
    expect(st.calls.set).toBe(2)
    t += 7 * 3600 * 1000; store.saveList({ ...list, members: [] })
    expect(st.calls.set).toBe(3) // same content, stamped again so a phone opened daily never lets it expire
  })
  it("never throws: a phone that refuses storage just opens the slow way", () => {
    const full = new TalkSavedStore(ME, fakeStorage({ throwOnSet: true }), () => NOW)
    expect(() => { full.saveList(list); full.saveChat("t1", { messages: [] }) }).not.toThrow()
    const blocked = new TalkSavedStore(ME, fakeStorage({ throwOnGet: true }), () => NOW)
    expect(blocked.read()).toBeNull()
    const none = new TalkSavedStore(ME, null, () => NOW)
    expect(none.read()).toBeNull()
    expect(() => { none.saveList(list); none.clear() }).not.toThrow()
  })
  it("a copy saved for someone else is replaced, not shown", () => {
    const st = fakeStorage()
    new TalkSavedStore("user-2", st, () => NOW).saveList({ ...list, current_user_id: "user-2" })
    const mine = new TalkSavedStore(ME, st, () => NOW)
    expect(mine.read()).toBeNull()
    mine.saveList(list)
    expect(JSON.parse(st.data.get(TALK_CACHE_KEY) as string).userId).toBe(ME)
  })
  it("clear removes it", () => {
    const st = fakeStorage()
    const store = new TalkSavedStore(ME, st, () => NOW)
    store.saveList(list)
    store.clear()
    expect(st.data.has(TALK_CACHE_KEY)).toBe(false)
  })
})

describe("the opening choices", () => {
  it("the chat shown before the server answers: a tapped link wins, then the chat open last time, else none", () => {
    expect(earlyChatChoice("a", "b")).toBe("a")
    expect(earlyChatChoice(null, "b")).toBe("b")
    expect(earlyChatChoice("", "")).toBeNull()
    expect(earlyChatChoice(undefined, undefined)).toBeNull()
  })
  it("after the real list: keep the chat if it is still right, switch if not, clear if there is no chat at all", () => {
    expect(afterListChoice("a", "a")).toBe("keep")
    expect(afterListChoice(null, null)).toBe("keep")
    expect(afterListChoice("a", "b")).toBe("select")
    expect(afterListChoice(null, "b")).toBe("select")
    expect(afterListChoice("a", null)).toBe("clear")
  })
  it("fast opening is for the phone app's TD Talk only", () => {
    expect(fastOpenEnabled(true, true)).toBe(true)
    expect(fastOpenEnabled(false, true)).toBe(false) // a normal browser / the computer
    expect(fastOpenEnabled(true, false)).toBe(false) // the CRM's TD Talk tab
  })
})

describe("who is signed in, for the saved copy", () => {
  function Probe() { return createElement("span", null, String(useTalkViewerId())) }
  it("is null outside /talk and the user's id inside it", () => {
    expect(renderToStaticMarkup(createElement(Probe))).toContain("null")
    expect(renderToStaticMarkup(createElement(TalkViewerProvider, { userId: "abc-123" }, createElement(Probe)))).toContain("abc-123")
  })
})

const root = join(__dirname, "..", "..")
const src = (p: string) => readFileSync(join(root, p), "utf8")
const app = src("components/talk/talk-app.tsx")

describe("the TD Talk screen is wired as promised", () => {
  it("the layout hands the signed-in user's id to the screen", () => {
    const layout = src("app/talk/layout.tsx")
    expect(layout).toContain("<TalkViewerProvider userId={user.id}>")
  })
  it("the saved copy and the early chat are used only when fast opening is on", () => {
    expect(app).toContain("const fastOpen = fastOpenEnabled(appMode, base === TALK_BASE)")
    expect(app).toContain("if (fastOpen) {")
    expect(app).toContain("} else if (first) select(first)") // everyone else opens exactly as before
    expect(app).toContain("if (!fastOpen || !viewerId) return null") // no saved copy without a signed-in user's id
  })
  it("showing the saved list never tells a sender 'delivered' and never sets the icon number", () => {
    const savedBranch = app.slice(app.indexOf("const saved = getStore()?.read()"), app.indexOf("const list = await loadThreads()"))
    expect(savedBranch).not.toContain("reportDelivered")
    expect(app).toContain("if (base === TALK_BASE && !showingSaved) applyUnreadIndicators(unreadAll)")
    // the delivered report stays with the real answer
    expect(app).toMatch(/applyList\(d\)\n\s+reportDelivered\(d\.threads \?\? \[\]\)/)
  })
  it("a failed refresh cannot wipe what is on screen, and a guess that is gone raises no error pop-up", () => {
    expect(app).toContain("initialisedRef.current = true // a failed refresh must not wipe what is on screen")
    expect(app).toContain("if (!opts.silent && listConfirmedRef.current) toast.error(")
  })
  it("a message link (?message=) loads the normal way", () => {
    expect(app).toContain("if (savedChat && !pendingJumpRef.current) applyChat(")
  })
  it("both answers are saved when they arrive from the server, and only then", () => {
    expect(app).toContain("getStore()?.saveList(d)")
    expect(app).toContain("getStore()?.saveChat(threadId, d)")
    expect((app.match(/getStore\(\)\?\.save/g) ?? []).length).toBe(2)
  })
})
