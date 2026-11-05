/**
 * postTeamMessage — `late_attachments` (dev job f34c915d, bug-hunt on PR #960).
 *
 * The hook makes the attachments (for team_chat_send: a public copy of a My files file) ONLY once the post is certain to go ahead: after the
 * message, the ready links, the target and the root have all been checked, and right before the insert. This is the real function with a
 * fake database, so the ORDER is what is proved: a mistyped channel, a bad root, an empty message or an off-site link must never reach the hook.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("server-only", () => ({}))
// post-message.ts reads the Storage host once, when it is loaded: set it before the import below
vi.hoisted(() => { process.env.NEXT_PUBLIC_SUPABASE_URL = "https://proj.supabase.co" })

const state: { threads: Record<string, unknown>; inserted: Array<Record<string, unknown>>; roots: Record<string, unknown> } = { threads: {}, inserted: [], roots: {} }

vi.mock("@/lib/team/dm", () => ({ findOrCreateDm: vi.fn() }))
vi.mock("@/lib/team/directory", () => ({
  listTeamMembers: vi.fn(async () => []),
  resolveMentions: vi.fn(async () => ({ userIds: [], claude: false, matchedHandles: [] })),
}))
vi.mock("@/lib/supabase-admin", () => {
  // a chain that answers every filter, then returns what the test prepared for the table asked
  const chain = (table: string) => {
    const c: Record<string, unknown> = {}
    const self = () => c
    for (const m of ["select", "eq", "ilike", "limit", "is", "neq", "in", "order"]) c[m] = self
    c.maybeSingle = async () => {
      if (table === "internal_threads") return { data: state.threads.channel ?? null, error: null }
      if (table === "internal_messages") return { data: state.roots.root ?? null, error: null }
      return { data: null, error: null }
    }
    c.insert = (row: Record<string, unknown>) => { state.inserted.push(row); return { select: () => ({ single: async () => ({ data: { id: "msg-1", ...row }, error: null }) }) } }
    c.update = () => ({ eq: async () => ({ data: null, error: null }) })
    c.upsert = async () => ({ data: null, error: null })
    return c
  }
  return { supabaseAdmin: { from: (t: string) => chain(t) } }
})
vi.mock("@/lib/portal/web-push", () => ({ sendPushToAdminUsers: vi.fn(async () => {}) }))
vi.mock("@/lib/team/notify", () => ({ sendPushToStaffExcept: vi.fn(async () => {}) }))
vi.mock("@/lib/team/channel-notify", () => ({ channelNotifiesStaff: () => false, conversationNotifiesParticipants: () => false }))

import { postTeamMessage } from "@/lib/team/post-message"

const HOST = "https://proj.supabase.co/storage/v1/object/public/assets"
const LINK = { url: `${HOST}/x.pdf`, name: "x.pdf" }
const COPY = { url: `${HOST}/team-chat/claude/abc.pdf`, name: "mockup.pdf", mime_type: "application/pdf", size: 10 }
const CHANNEL_ROW = { id: "thread-1", thread_type: "channel", channel_slug: "td-bug", channel_name: "td-bug", dm_key: null, account_id: null, contact_id: null, lead_id: null }

beforeEach(() => {
  state.threads = { channel: CHANNEL_ROW }
  state.roots = {}
  state.inserted = []
})

describe("postTeamMessage — late attachments are made last", () => {
  it("the hook runs once, after the target is resolved, and its files are posted after the ready links", async () => {
    const late = vi.fn(async () => [COPY])
    const r = await postTeamMessage({ channel: "td-bug", message: "hi", attachments: [LINK], late_attachments: late })
    expect(late).toHaveBeenCalledTimes(1)
    expect(r.message_id).toBe("msg-1")
    expect(state.inserted).toHaveLength(1)
    expect(state.inserted[0].attachments).toEqual([LINK, COPY])
  })

  it("a channel that does not exist never reaches the hook, and nothing is inserted", async () => {
    state.threads = {}
    const late = vi.fn(async () => [COPY])
    await expect(postTeamMessage({ channel: "td_dev", message: "hi", late_attachments: late })).rejects.toThrow(/Target thread not found/)
    expect(late).not.toHaveBeenCalled()
    expect(state.inserted).toHaveLength(0)
  })

  it("a root id that does not exist never reaches the hook", async () => {
    const late = vi.fn(async () => [COPY])
    await expect(postTeamMessage({ channel: "td-bug", root_id: "11111111-1111-1111-1111-111111111111", message: "hi", late_attachments: late })).rejects.toThrow(/root_id not found/)
    expect(late).not.toHaveBeenCalled()
  })

  it("a root that belongs to another channel never reaches the hook", async () => {
    state.roots = { root: { id: "r1", thread_id: "some-other-thread", root_id: null } }
    const late = vi.fn(async () => [COPY])
    await expect(postTeamMessage({ channel: "td-bug", root_id: "11111111-1111-1111-1111-111111111111", message: "hi", late_attachments: late })).rejects.toThrow(/different channel/)
    expect(late).not.toHaveBeenCalled()
  })

  it("an empty message, two targets, or an off-site ready link never reach the hook", async () => {
    const late = vi.fn(async () => [COPY])
    await expect(postTeamMessage({ channel: "td-bug", message: "   ", late_attachments: late })).rejects.toThrow(/message is required/)
    await expect(postTeamMessage({ channel: "td-bug", thread_id: "t1", message: "hi", late_attachments: late })).rejects.toThrow(/exactly ONE target/i)
    await expect(postTeamMessage({ channel: "td-bug", message: "hi", attachments: [{ url: "https://evil.example.com/f.pdf", name: "f.pdf" }], late_attachments: late })).rejects.toThrow(/own Storage/)
    expect(late).not.toHaveBeenCalled()
    expect(state.inserted).toHaveLength(0)
  })

  it("if the hook refuses or fails, the post stops with its message and nothing is inserted", async () => {
    await expect(postTeamMessage({ channel: "td-bug", message: "hi", late_attachments: async () => { throw new Error("\"a.pdf\" is not inside the \"From Claude\" folder.") } })).rejects.toThrow(/not inside the "From Claude" folder/)
    expect(state.inserted).toHaveLength(0)
  })

  it("what the hook returns is checked like any other attachment: an off-site link from it is refused and nothing is inserted", async () => {
    await expect(postTeamMessage({ channel: "td-bug", message: "hi", late_attachments: async () => [{ url: "https://evil.example.com/f.pdf", name: "f.pdf" }] })).rejects.toThrow(/own Storage/)
    expect(state.inserted).toHaveLength(0)
  })

  it("without the hook nothing changes: the ready links are stored as given, or null when there are none", async () => {
    await postTeamMessage({ channel: "td-bug", message: "hi", attachments: [LINK] })
    await postTeamMessage({ channel: "td-bug", message: "hi again" })
    expect(state.inserted[0].attachments).toEqual([LINK])
    expect(state.inserted[1].attachments).toBeNull()
  })
})
