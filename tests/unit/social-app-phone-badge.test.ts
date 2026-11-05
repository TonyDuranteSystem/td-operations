/**
 * TD Social — the icon number for one person looked up by id (dev job 2072bc3e, Step 2 pull request C2). Honest or absent: any failure means no number, never 0.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const { getUserById, memberContextForUser, readState, countTabs } = vi.hoisted(() => ({
  getUserById: vi.fn(), memberContextForUser: vi.fn(), readState: vi.fn(), countTabs: vi.fn(),
}))

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: { auth: { admin: { getUserById } } } }))
vi.mock("@/lib/marketing/guard", () => ({ memberContextForUser }))
vi.mock("@/lib/app/state", () => ({ readState }))
vi.mock("@/lib/app/counts", () => ({ countTabs }))

import { badgeForUser } from "@/lib/app/phone-badge"

const user = (role: string, extra: Record<string, unknown> = {}) => ({ data: { user: { id: "u1", email: "x@example.com", app_metadata: { role }, ...extra } }, error: null })

beforeEach(() => {
  getUserById.mockReset(); memberContextForUser.mockReset(); readState.mockReset(); countTabs.mockReset()
  readState.mockResolvedValue({ muted_tabs: ["whatsapp"], inbox_opened: { support: "2026-11-05T00:00:00Z" } })
  countTabs.mockResolvedValue({ counts: { talk: 2 }, badge: 5 })
})

describe("badgeForUser", () => {
  it("a staff login: the tabs and the stored mutes go to the counters, and the number comes back", async () => {
    getUserById.mockResolvedValue(user("team"))
    expect(await badgeForUser("u1")).toBe(5)
    const input = countTabs.mock.calls[0][0]
    expect(input.userId).toBe("u1")
    expect(input.tabs.map((t: { id: string }) => t.id)).toEqual(["talk", "portal", "whatsapp", "inbox"])
    expect(input.mutedTabs).toEqual(["whatsapp"])
    expect(input.inboxOpened).toEqual({ support: "2026-11-05T00:00:00Z" })
    expect(input.marketing).toBeUndefined()
    expect(memberContextForUser).not.toHaveBeenCalled()
  })

  it("a marketing login gets the Marketing tab only through an active membership with the chat permission", async () => {
    getUserById.mockResolvedValue(user("marketing"))
    memberContextForUser.mockResolvedValue({ ok: true, ctx: { permissions: ["chat"], user: { id: "u1", email: null }, team: { id: "t", name: "T", status: "active" }, role: "member", membership: {} } })
    await badgeForUser("u1")
    expect(countTabs.mock.calls[0][0].tabs.map((t: { id: string }) => t.id)).toEqual(["marketing"])
    expect(countTabs.mock.calls[0][0].marketing).toBeDefined()
  })

  it("a marketing login who is not a member (or has no chat) has no tabs, so no number", async () => {
    getUserById.mockResolvedValue(user("marketing"))
    memberContextForUser.mockResolvedValue({ ok: false, status: 403, code: "NO_TEAM", message: "" })
    expect(await badgeForUser("u1")).toBeNull()
    memberContextForUser.mockResolvedValue({ ok: true, ctx: { permissions: ["leads.read"] } })
    expect(await badgeForUser("u1")).toBeNull()
    expect(countTabs).not.toHaveBeenCalled()
  })

  it("a login that is not staff or marketing (a client, a partner) has no tabs and no number", async () => {
    for (const role of ["client", "partner", ""]) {
      getUserById.mockResolvedValue(user(role))
      expect(await badgeForUser("u1")).toBeNull()
    }
    expect(countTabs).not.toHaveBeenCalled()
  })

  it("an unknown person or an auth error is no number", async () => {
    getUserById.mockResolvedValue({ data: { user: null }, error: null })
    expect(await badgeForUser("u1")).toBeNull()
    getUserById.mockResolvedValue({ data: { user: null }, error: { message: "x" } })
    expect(await badgeForUser("u1")).toBeNull()
    getUserById.mockRejectedValue(new Error("down"))
    expect(await badgeForUser("u1")).toBeNull()
  })

  it("unreadable switches fall back to the rule defaults (nothing muted), the number still works", async () => {
    getUserById.mockResolvedValue(user("team"))
    readState.mockRejectedValue(new Error("table missing"))
    await badgeForUser("u1")
    expect(countTabs.mock.calls[0][0].mutedTabs).toEqual([])
    expect(countTabs.mock.calls[0][0].inboxOpened).toEqual({})
  })

  it("a counter that could not count gives null, never 0", async () => {
    getUserById.mockResolvedValue(user("team"))
    countTabs.mockResolvedValue({ counts: { talk: null }, badge: null })
    expect(await badgeForUser("u1")).toBeNull()
    countTabs.mockRejectedValue(new Error("boom"))
    expect(await badgeForUser("u1")).toBeNull()
  })
})
