/**
 * The red numbers on Portal Chats follow READS, also in a window left open (Antonio, 2026-11-17: "the pages I have open don't refresh by themselves; the one
 * that didn't refresh still has the red dot for a previous message"). Measured before the fix with two isolated browser windows on the sandbox: with a window
 * ON the Portal Chats page the left-menu number NEVER changed (75 s) and the conversation's own dot took ~60 s; both now follow within seconds.
 * Promises under test:
 *   • the light question `?only=portalChats` is staff-only, never touches Gmail, and counts exactly what the full check counts
 *   • the menu keeps following the server on the Portal Chats page, asks again when the window is woken, and learns about a READ (an UPDATE) in realtime
 *   • the conversation list reloads when a client message is read
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const gmailGetMock = vi.fn()
vi.mock("@/lib/gmail", () => ({ gmailGet: (...a: unknown[]) => gmailGetMock(...a) }))

let unreadRows = 0
const portalQueries: Array<Array<[string, ...unknown[]]>> = []
function chain(table?: string): Record<string, unknown> {
  const b: Record<string, unknown> = {}
  const calls: Array<[string, ...unknown[]]> = []
  if (table === "portal_messages") portalQueries.push(calls)
  for (const m of ["select", "eq", "is", "in", "neq", "gt", "limit", "order"]) b[m] = (...a: unknown[]) => { calls.push([m, ...a]); return b }
  b.maybeSingle = async () => ({ data: null, error: null })
  b.then = (resolve: (v: unknown) => void) => resolve({ data: table === "portal_messages" ? Array.from({ length: unreadRows }, (_, i) => ({ id: `m${i}` })) : [], error: null, count: 0 })
  return b
}
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: (t: string) => chain(t), rpc: async () => ({ data: [], error: null }) }),
}))

let lookup: () => Promise<{ data: { user: unknown } }> = async () => ({ data: { user: null } })
vi.mock("@/lib/supabase/server", () => ({ createClient: () => ({ auth: { getUser: () => lookup() } }) }))
vi.mock("@/lib/inbox/whatsapp-unread", () => ({ getWhatsappUnread: async () => 0 }))
vi.mock("@/lib/marketing/guard", () => ({ adminMemberContext: async () => ({ ok: false }) }))
vi.mock("@/lib/marketing/menu-unread", () => ({ marketingChatUnread: async () => 0 }))

import { GET } from "@/app/api/dashboard/badges/route"

const staff = { id: "u1", email: "luca@tonydurante.us", app_metadata: { role: "team" } }
const client = { id: "c1", email: "client@example.com", app_metadata: { role: "client" } }
const ask = (q: string) => GET(new Request(`http://localhost/api/dashboard/badges${q}`))

beforeEach(() => {
  gmailGetMock.mockReset()
  gmailGetMock.mockResolvedValue({ messagesUnread: 1 })
  portalQueries.length = 0
  unreadRows = 0
  lookup = async () => ({ data: { user: staff } })
})

describe("GET /api/dashboard/badges?only=portalChats (the light question)", () => {
  it("answers with the Portal Chats number only, from unread CLIENT messages, and never asks Gmail", async () => {
    unreadRows = 7
    const res = await ask("?only=portalChats")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ portalChats: 7 })
    expect(gmailGetMock).not.toHaveBeenCalled()
    const q = portalQueries[0]
    expect(q).toContainEqual(["eq", "sender_type", "client"])
    expect(q).toContainEqual(["is", "read_at", null])
  })

  it("is for staff only: no login and a client login are both refused", async () => {
    lookup = async () => ({ data: { user: null } })
    expect((await ask("?only=portalChats")).status).toBe(403)
    lookup = async () => ({ data: { user: client } })
    expect((await ask("?only=portalChats")).status).toBe(403)
  })

  it("counts exactly what the full check counts (one definition)", async () => {
    unreadRows = 4
    const light = await (await ask("?only=portalChats")).json()
    const full = await (await ask("")).json()
    expect(full.portalChats).toBe(light.portalChats)
  })

  it("a failed read is 0, not an error page", async () => {
    unreadRows = 0
    expect((await (await ask("?only=portalChats")).json()).portalChats).toBe(0)
  })
})

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

describe("the menu number follows the server (components/dashboard/sidebar.tsx)", () => {
  const sidebar = read("components/dashboard/sidebar.tsx")

  it("keeps following the server on the Portal Chats page — it used to freeze there", () => {
    expect(sidebar).not.toMatch(/typeof data\.portalChats === 'number' && pathnameRef\.current !== '\/portal-chats'/)
    expect(sidebar).toMatch(/if \(typeof data\.portalChats === 'number'\) \{\s*setLivePortalChats\(data\.portalChats\)/)
  })

  it("asks again when the window is woken (it may have been hidden, its timers slowed)", () => {
    expect(sidebar).toContain("useWakeSignal({ onWake: () => fetchBadgesRef.current() })")
    expect(sidebar).toContain("fetchBadgesRef.current = fetchBadges")
  })

  it("learns about a READ in realtime: an UPDATE of a client message asks the LIGHT question", () => {
    expect(sidebar).toContain("fetch('/api/dashboard/badges?only=portalChats')")
    expect(sidebar).toMatch(/event: 'UPDATE',\s*schema: 'public',\s*table: 'portal_messages',\s*filter: 'sender_type=eq\.client'/)
  })

  it("a new client message while ON the Portal Chats page asks the server instead of adding one (the page may have read it already)", () => {
    expect(sidebar).toMatch(/if \(pathnameRef\.current !== '\/portal-chats'\) setLivePortalChats\(prev => prev \+ 1\)\s*else refetchPortalChats\(\)/)
  })
})

describe("the conversation list (app/(dashboard)/portal-chats/page.tsx)", () => {
  const page = read("app/(dashboard)/portal-chats/page.tsx")
  it("reloads when a client message is READ, not only when one arrives, coalesced", () => {
    expect(page).toMatch(/event: 'UPDATE',\s*schema: 'public',\s*table: 'portal_messages',\s*filter: 'sender_type=eq\.client'/)
    expect(page).toContain("readDebounce = setTimeout(() => { queryClient.invalidateQueries({ queryKey: ['portal-chat-threads'] }) }, 1000)")
  })
})
