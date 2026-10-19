/**
 * TD Marketing job J-B: a direct message is private to its two people on EVERY route that takes a thread or message id
 * from the browser. Before this, only groups were checked, so any staff member could read, write into, react to, pin on,
 * or rename another pair's direct message by id. Drives the real routes with a fake database.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const ME = "00000000-0000-0000-0000-00000000000a"
const OTHER = "00000000-0000-0000-0000-00000000000b"
const THIRD = "00000000-0000-0000-0000-00000000000c"

const db: Record<string, Record<string, unknown> | null> = {}
const writes: { table: string; op: string }[] = []

function builder(table: string) {
  const row = () => db[table] ?? null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const b: any = {
    select: () => b, eq: () => b, in: () => b, is: () => b, not: () => b, order: () => b, limit: () => b,
    insert: () => { writes.push({ table, op: "insert" }); return b },
    update: () => { writes.push({ table, op: "update" }); return b },
    upsert: () => { writes.push({ table, op: "upsert" }); return b },
    single: () => Promise.resolve({ data: row(), error: null }),
    maybeSingle: () => Promise.resolve({ data: row(), error: null }),
    then: (res: (v: unknown) => unknown) => Promise.resolve({ data: row() ? [row()] : [], error: null }).then(res),
  }
  return b
}

vi.mock("server-only", () => ({}))
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: { from: (t: string) => builder(t), rpc: vi.fn(async () => ({ data: null, error: null })) },
}))
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: ME, email: "me@x.us" } } }) } }),
}))
vi.mock("@/lib/auth", () => ({
  isDashboardUser: () => true,
  isAdmin: () => false,
  getUserDisplayName: () => "Me",
}))
vi.mock("@/lib/team/directory", () => ({ listTeamMembers: vi.fn(async () => []) }))
const dmWith = (a: string, b: string) => ({ id: "t1", thread_type: "dm", dm_key: [a, b].sort().join(":") })
const params = { params: Promise.resolve({ id: "t1" }) }
const req = (url = "http://x/api", method = "GET", body?: unknown) =>
  new NextRequest(url, { method, body: body ? JSON.stringify(body) : undefined, headers: { "content-type": "application/json" } })

beforeEach(() => {
  for (const k of Object.keys(db)) delete db[k]
  writes.length = 0
})

describe("isDmParticipant", async () => {
  const { isDmParticipant } = await import("@/lib/team/groups-rules")
  it("matches a whole id only", () => {
    expect(isDmParticipant(`${ME}:${OTHER}`, ME)).toBe(true)
    expect(isDmParticipant(`${ME}:${OTHER}`, OTHER)).toBe(true)
    expect(isDmParticipant(`${ME}:${OTHER}`, THIRD)).toBe(false)
    expect(isDmParticipant(`${ME}:${OTHER}`, ME.slice(0, 30))).toBe(false) // a partial id is not a participant
  })
  it("missing key or user is never a participant", () => {
    expect(isDmParticipant(null, ME)).toBe(false)
    expect(isDmParticipant("", ME)).toBe(false)
    expect(isDmParticipant(`${ME}:${OTHER}`, null)).toBe(false)
    expect(isDmParticipant(`${ME}:${OTHER}`, "")).toBe(false)
  })
})

describe("GET /api/team/threads/[id]", () => {
  it("refuses someone else's direct message and returns no messages", async () => {
    db.internal_threads = dmWith(OTHER, THIRD)
    db.internal_messages = { id: "m1", message: "private words", thread_id: "t1" }
    const { GET } = await import("@/app/api/team/threads/[id]/route")
    const res = await GET(req(), params)
    expect(res.status).toBe(403)
    expect(JSON.stringify(await res.json())).not.toContain("private words")
  })
  it("still opens my own direct message", async () => {
    db.internal_threads = dmWith(ME, OTHER)
    db.internal_messages = { id: "m1", message: "hello", thread_id: "t1", created_at: "2026-01-01" }
    const { GET } = await import("@/app/api/team/threads/[id]/route")
    const res = await GET(req(), params)
    expect(res.status).toBe(200)
  })
  it("a channel stays open to staff", async () => {
    db.internal_threads = { id: "t1", thread_type: "channel", dm_key: null }
    const { GET } = await import("@/app/api/team/threads/[id]/route")
    const res = await GET(req(), params)
    expect(res.status).toBe(200)
  })
})

describe("PATCH /api/team/threads/[id] (rename / archive)", () => {
  it("refuses someone else's direct message and writes nothing", async () => {
    db.internal_threads = dmWith(OTHER, THIRD)
    const { PATCH } = await import("@/app/api/team/threads/[id]/route")
    const res = await PATCH(req("http://x/api", "PATCH", { archived: true }), params)
    expect(res.status).toBe(403)
    expect(writes.length).toBe(0)
  })
})

describe("GET .../thread-messages (replies)", () => {
  it("refuses someone else's direct message", async () => {
    db.internal_threads = dmWith(OTHER, THIRD)
    db.internal_messages = { id: "root", message: "secret reply", thread_id: "t1" }
    const { GET } = await import("@/app/api/team/threads/[id]/thread-messages/route")
    const res = await GET(req("http://x/api?root=root"), params)
    expect(res.status).toBe(403)
    expect(JSON.stringify(await res.json())).not.toContain("secret reply")
  })
  it("allows my own direct message", async () => {
    db.internal_threads = dmWith(ME, OTHER)
    db.internal_messages = { id: "root", message: "hi", thread_id: "t1" }
    const { GET } = await import("@/app/api/team/threads/[id]/thread-messages/route")
    const res = await GET(req("http://x/api?root=root"), params)
    expect(res.status).toBe(200)
  })
})

describe("POST .../messages (send into a thread)", () => {
  it("refuses sending into someone else's direct message and writes nothing", async () => {
    db.internal_threads = dmWith(OTHER, THIRD)
    const { POST } = await import("@/app/api/team/threads/[id]/messages/route")
    const res = await POST(req("http://x/api", "POST", { message: "intruder" }), params)
    expect(res.status).toBe(403)
    expect(writes.filter(w => w.table === "internal_messages").length).toBe(0)
  })
})

describe("message-id routes (react, pin)", () => {
  it("react is refused on a message in someone else's direct message", async () => {
    db.internal_messages = { id: "m1", thread_id: "t1" }
    db.internal_threads = dmWith(OTHER, THIRD)
    const { POST } = await import("@/app/api/team/messages/[id]/react/route")
    const res = await POST(req("http://x/api", "POST", { emoji: "👍" }), params)
    expect(res.status).toBe(403)
  })
  it("pin is refused and changes nothing on a message in someone else's direct message", async () => {
    db.internal_messages = { id: "m1", thread_id: "t1", pinned_at: null, deleted_at: null }
    db.internal_threads = dmWith(OTHER, THIRD)
    const { POST } = await import("@/app/api/team/messages/[id]/pin/route")
    const res = await POST(req("http://x/api", "POST", {}), params)
    expect(res.status).toBe(403)
    expect(writes.length).toBe(0)
  })
  it("pin works on my own direct message", async () => {
    db.internal_messages = { id: "m1", thread_id: "t1", pinned_at: null, deleted_at: null }
    db.internal_threads = dmWith(ME, OTHER)
    const { POST } = await import("@/app/api/team/messages/[id]/pin/route")
    const res = await POST(req("http://x/api", "POST", {}), params)
    expect(res.status).toBe(200)
  })
})
