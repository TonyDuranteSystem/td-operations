/**
 * Pinned messages in TD Talk (dev job b719980f): the pure list rules, the chat answer's older pins, the pin route's explicit target,
 * and guards that the screen is wired the way the rules need.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { NextRequest } from "next/server"
import { allPins, applyPinOverrides, nextPinned, pinnedMessages, syncOlderPin } from "@/lib/talk/pins"
import { buildTalkChatAnswer, OLDER_PINS_LIMIT } from "@/lib/team/talk-chat-answer"

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

type Pin = { id: string; pinned_at?: string | null; deleted_at?: string | null; message?: string }

// ── pure rules ──
describe("syncOlderPin", () => {
  it("a message that became pinned joins the list", () => {
    expect(syncOlderPin<Pin>([], { id: "a", pinned_at: "2026-11-11T10:00:00Z" }).map(x => x.id)).toEqual(["a"])
  })
  it("a message that was unpinned leaves the list", () => {
    const list: Pin[] = [{ id: "a", pinned_at: "2026-11-11T10:00:00Z" }, { id: "b", pinned_at: "2026-11-11T11:00:00Z" }]
    expect(syncOlderPin(list, { id: "a", pinned_at: null }).map(x => x.id)).toEqual(["b"])
  })
  it("a pinned message that was deleted leaves the list", () => {
    const list: Pin[] = [{ id: "a", pinned_at: "2026-11-11T10:00:00Z" }]
    expect(syncOlderPin(list, { id: "a", pinned_at: "2026-11-11T10:00:00Z", deleted_at: "2026-11-11T12:00:00Z" })).toEqual([])
  })
  it("a change to a pin already in the list is merged over it, never doubled", () => {
    const list: Pin[] = [{ id: "a", pinned_at: "2026-11-11T10:00:00Z", message: "hello" }]
    const out = syncOlderPin(list, { id: "a", pinned_at: "2026-11-11T10:00:00Z", message: "hello edited" })
    expect(out).toHaveLength(1)
    expect(out[0].message).toBe("hello edited")
  })
  it("does not change the list it was given", () => {
    const list: Pin[] = [{ id: "a", pinned_at: "2026-11-11T10:00:00Z" }]
    syncOlderPin(list, { id: "a", pinned_at: null })
    expect(list).toHaveLength(1)
  })
})

describe("the bar's list", () => {
  const loaded: Pin[] = [{ id: "m1", pinned_at: "2026-11-11T09:00:00Z" }, { id: "m2" }, { id: "m3", pinned_at: "2026-11-11T11:00:00Z", deleted_at: "2026-11-11T12:00:00Z" }]
  const older: Pin[] = [{ id: "o1", pinned_at: "2026-11-10T09:00:00Z" }, { id: "m1", pinned_at: "2026-11-11T09:00:00Z" }]
  it("shows pins from the loaded messages and the older ones, newest pin first, without doubles, without deleted ones", () => {
    expect(allPins(loaded, older).map(p => p.id)).toEqual(["m1", "o1"])
    expect(pinnedMessages(loaded).map(p => p.id)).toEqual(["m1"])
  })
  it("steps through the pins and wraps round", () => {
    const pins = allPins(loaded, older)
    expect(nextPinned(pins, null)?.id).toBe("m1")
    expect(nextPinned(pins, "m1")?.id).toBe("o1")
    expect(nextPinned(pins, "o1")?.id).toBe("m1")
  })
  it("a pin I just did wins over an answer that was already on its way", () => {
    const stale: Pin[] = [{ id: "m2", pinned_at: null }]
    const overrides = new Map([["m2", { at: "2026-11-11T13:00:00Z", until: 1000 }]])
    expect(applyPinOverrides(stale, overrides, 500)[0].pinned_at).toBe("2026-11-11T13:00:00Z")
    expect(applyPinOverrides(stale, overrides, 2000)[0].pinned_at).toBeNull() // remembered only for a few seconds
  })
})

// ── the chat answer carries the pins that are older than the newest messages ──
type Row = Record<string, unknown>
function pinFake(opts: { messages: Row[]; pinned: Row[]; thread: Row }) {
  const calls: string[] = []
  const from = (table: string) => {
    const state = { pinnedQuery: false, threadId: null as unknown }
    const b: Record<string, unknown> = {}
    b.select = () => b
    b.eq = (col: string, v: unknown) => { if (col === "thread_id") state.threadId = v; return b }
    b.in = () => b
    b.is = () => b
    b.order = () => b
    b.limit = (n: number) => { (b as { _limit?: number })._limit = n; return b }
    b.not = (col: string) => { if (col === "pinned_at") state.pinnedQuery = true; return b }
    b.single = () => Promise.resolve({ data: table === "internal_threads" ? opts.thread : null, error: null })
    b.maybeSingle = () => Promise.resolve({ data: null, error: null })
    b.upsert = () => Promise.resolve({ data: null, error: null })
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
      if (table === "internal_messages") calls.push(state.pinnedQuery ? `pins:${String(state.threadId)}` : `messages:${String(state.threadId)}`)
      const data = table === "internal_messages" ? (state.pinnedQuery ? opts.pinned : opts.messages) : []
      return Promise.resolve({ data, error: null }).then(res, rej)
    }
    return b
  }
  return { client: { from }, calls }
}
const base = { threadId: "t1", userId: "me", userName: "Me", isAdmin: false, limit: 60, markRead: true, deniedMessage: "denied", listGroupMemberIds: async () => [] as string[] }
const dm = { id: "t1", thread_type: "dm", dm_key: "me:peer" }

describe("buildTalkChatAnswer older_pins", () => {
  it("returns this chat's pins that are not among the newest messages, and asks for them in this chat only", async () => {
    const f = pinFake({
      thread: dm,
      messages: [{ id: "m2", created_at: "2026-11-11T10:02:00Z", reply_to_id: null }, { id: "m1", created_at: "2026-11-11T10:01:00Z", reply_to_id: null }],
      pinned: [{ id: "m2", pinned_at: "2026-11-11T10:03:00Z" }, { id: "old", pinned_at: "2026-11-01T10:00:00Z" }],
    })
    const r = await buildTalkChatAnswer(f.client, base)
    expect(r.status).toBe(200)
    const b = (r as { body: Record<string, unknown> }).body
    expect((b.older_pins as Row[]).map(p => p.id)).toEqual(["old"]) // m2 is already among the messages, so it is not repeated
    expect(f.calls).toContain("pins:t1")
    expect(f.calls.filter(c => c.startsWith("pins:") && c !== "pins:t1")).toEqual([])
  })
  it("never returns more than the limit", async () => {
    const pinned = Array.from({ length: OLDER_PINS_LIMIT + 5 }, (_, i) => ({ id: `p${i}`, pinned_at: `2026-11-01T10:${String(i).padStart(2, "0")}:00Z` }))
    const f = pinFake({ thread: dm, messages: [], pinned })
    const b = ((await buildTalkChatAnswer(f.client, base)) as { body: Record<string, unknown> }).body
    expect((b.older_pins as Row[]).length).toBe(OLDER_PINS_LIMIT)
  })
  it("a chat that is not the caller's answers 403 and returns no pins", async () => {
    const f = pinFake({ thread: { id: "t1", thread_type: "dm", dm_key: "a:b" }, messages: [], pinned: [{ id: "x", pinned_at: "2026-11-01T10:00:00Z" }] })
    const r = await buildTalkChatAnswer(f.client, base)
    expect(r.status).toBe(403)
    expect(JSON.stringify(r)).not.toContain("older_pins")
    expect(JSON.stringify(r)).not.toContain('"x"')
  })
})

// ── the pin route: an explicit target never flips a pin back; no body keeps the CRM's toggle ──
const ME = "00000000-0000-0000-0000-00000000000a"
const store: { row: Row | null; updates: Row[] } = { row: null, updates: [] }
vi.mock("server-only", () => ({}))
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b: any = {
        select: () => b, eq: () => b,
        update: (payload: Row) => { store.updates.push(payload); store.row = { ...(store.row ?? {}), ...payload }; return b },
        single: () => Promise.resolve({ data: store.row, error: null }),
      }
      return b
    },
  },
}))
vi.mock("@/lib/supabase/server", () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: ME } } }) } }) }))
vi.mock("@/lib/auth", () => ({ isDashboardUser: () => true }))
vi.mock("@/lib/team/groups", () => ({ assertThreadAccess: async () => ({ allowed: true }), THREAD_DENIED_MESSAGE: "denied" }))

const params = { params: Promise.resolve({ id: "m1" }) }
const post = (body?: unknown) => new NextRequest("http://x/api/team/messages/m1/pin", { method: "POST", body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } })

describe("POST /api/team/messages/[id]/pin", () => {
  beforeEach(() => { store.row = { id: "m1", thread_id: "t1", pinned_at: null, pinned_by: null, deleted_at: null }; store.updates = [] })

  it("without a body it toggles, exactly as the CRM Team Chat page expects", async () => {
    const { POST } = await import("@/app/api/team/messages/[id]/pin/route")
    const on = await (await POST(post(), params)).json()
    expect(on.pinned).toBe(true)
    expect(store.updates).toHaveLength(1)
    const off = await (await POST(post(), params)).json()
    expect(off.pinned).toBe(false)
    expect(store.updates[1]).toMatchObject({ pinned_at: null, pinned_by: null })
  })
  it("{ pinned: true } pins; the same request again changes nothing and keeps who pinned it and when", async () => {
    const { POST } = await import("@/app/api/team/messages/[id]/pin/route")
    const first = await (await POST(post({ pinned: true }), params)).json()
    expect(first.pinned).toBe(true)
    expect(first.message.pinned_by).toBe(ME)
    const at = first.message.pinned_at
    const second = await (await POST(post({ pinned: true }), params)).json()
    expect(second.pinned).toBe(true)
    expect(second.message.pinned_at).toBe(at)
    expect(store.updates).toHaveLength(1) // the second request wrote nothing
  })
  it("{ pinned: false } on a message that is not pinned changes nothing", async () => {
    const { POST } = await import("@/app/api/team/messages/[id]/pin/route")
    const res = await (await POST(post({ pinned: false }), params)).json()
    expect(res.pinned).toBe(false)
    expect(res.message.pinned_at).toBeNull()
    expect(store.updates).toHaveLength(0)
  })
  it("{ pinned: false } on a pinned message unpins it", async () => {
    store.row = { id: "m1", thread_id: "t1", pinned_at: "2026-11-11T10:00:00Z", pinned_by: ME, deleted_at: null }
    const { POST } = await import("@/app/api/team/messages/[id]/pin/route")
    const res = await (await POST(post({ pinned: false }), params)).json()
    expect(res.pinned).toBe(false)
    expect(store.updates).toEqual([{ pinned_at: null, pinned_by: null }])
  })
  it("a body that is not a yes/no target is treated as no target (toggle)", async () => {
    const { POST } = await import("@/app/api/team/messages/[id]/pin/route")
    const res = await (await POST(post({ pinned: "yes" }), params)).json()
    expect(res.pinned).toBe(true)
  })
  it("a deleted message cannot be pinned", async () => {
    store.row = { id: "m1", thread_id: "t1", pinned_at: null, pinned_by: null, deleted_at: "2026-11-11T09:00:00Z" }
    const { POST } = await import("@/app/api/team/messages/[id]/pin/route")
    const res = await POST(post({ pinned: true }), params)
    expect(res.status).toBe(400)
    expect(store.updates).toHaveLength(0)
  })
})

// ── the screen is wired the way these rules need ──
describe("TD Talk screen wiring", () => {
  const app = read("components/talk/talk-app.tsx")
  it("the message menu gets Pin / Unpin, and the pin is sent with an explicit target", () => {
    expect(app).toContain("onTogglePin={() => void togglePin(sheetMsg)}")
    expect(app).toContain("JSON.stringify({ pinned: pin })")
  })
  it("a refresh cannot flip a pin I just did, and the bar is drawn", () => {
    expect(app).toContain("applyPinOverrides((d.messages ?? []) as TalkMessage[], pinOverrides.current")
    expect(app).toContain("<TalkPinnedBar")
  })
  it("the bar's key is its own: the message box already uses the chat id as its key, and two siblings with one key were drawn over and over (found in the browser)", () => {
    expect(app).toMatch(/<TalkPinnedBar key=\{`pinned-\$\{selected\.id\}`\}/)
    expect(app).toMatch(/<TalkComposer\s+key=\{selected\.id\}/)
  })
  it("the Marketing chat does not use TD Talk's bar", () => {
    expect(read("components/marketing/lead-chat.tsx")).not.toContain("talk-pinned-bar")
  })
  it("the CRM Team Chat page still sends the pin without a body (the old toggle)", () => {
    const page = read("app/(dashboard)/team-chat/page.tsx")
    expect(page).toMatch(/fetch\(`\/api\/team\/messages\/\$\{m\.id\}\/pin`, \{ method: 'POST' \}\)/)
  })
})
