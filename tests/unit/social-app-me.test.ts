/**
 * TD Social — the "what may I see, and what is waiting?" answer (dev job 2072bc3e, Step 2 pull requests A and B).
 * Failures degrade and never lie: unreadable switches -> rule defaults and no count; a failed count -> a null number.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => ({
  state: null as unknown,
  stateThrows: false,
  countsCalls: [] as unknown[],
  countsResult: { counts: { talk: 1 }, badge: 1 } as { counts: Record<string, number | null>; badge: number | null },
}))

vi.mock("@/lib/supabase/server", () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }) }))
vi.mock("@/lib/app/state", () => ({
  readState: async () => { if (h.stateThrows) throw new Error("social_app_user_state read failed: 42P01"); return h.state },
  markInboxOpened: vi.fn(),
}))
vi.mock("@/lib/app/counts", () => ({
  countTabs: async (input: unknown) => { h.countsCalls.push(input); return h.countsResult },
}))

import { buildMe } from "@/lib/app/me"
import type { ResolvedAppIdentity } from "@/lib/app/identity"

const person = (identity: Partial<ResolvedAppIdentity["identity"]>, extra: Partial<ResolvedAppIdentity> = {}): ResolvedAppIdentity => ({
  user: { id: "u1", email: "x@y.z", name: "X" },
  identity: { authRole: "team", isAdmin: false, isStaff: true, marketingChat: false, ...identity },
  ...extra,
})
const NOW = new Date("2026-11-05T12:00:00Z")

beforeEach(() => { h.state = null; h.stateThrows = false; h.countsCalls = []; h.countsResult = { counts: { talk: 1 }, badge: 1 } })

describe("buildMe", () => {
  it("a login with no tab: nothing to switch, nothing to count, no database read", async () => {
    const me = await buildMe(person({ authRole: "client", isStaff: false }), NOW)
    expect(me).toMatchObject({ notSetUp: true, tabs: [], loginKind: "none", prefs: { mutedTabs: [] }, counts: {}, badge: 0 })
    expect(h.countsCalls).toHaveLength(0)
  })

  it("staff: the tabs, the rule-default switches, the counts and the number", async () => {
    h.countsResult = { counts: { talk: 3, portal: 2 }, badge: 5 }
    const me = await buildMe(person({}), NOW)
    expect(me.tabs.map(t => t.id)).toEqual(["talk", "portal", "whatsapp", "inbox"])
    expect(me.prefs).toEqual({ mutedTabs: [], whatsapp: true, email: { support: true } })
    expect(me.counts).toEqual({ talk: 3, portal: 2 })
    expect(me.badge).toBe(5)
  })

  it("hands the counter this person's id, tabs, muted tabs, stored 'opened' times and Marketing context", async () => {
    h.state = { muted_tabs: ["portal"], alerts: { whatsapp: false }, inbox_opened: { support: "2026-11-05T10:00:00Z" } }
    const marketing = { permissions: ["chat"] } as never
    const me = await buildMe(person({ authRole: "admin", isAdmin: true, marketingChat: true }, { marketing }), NOW)
    expect(me.prefs.mutedTabs).toEqual(["portal"])
    expect(me.prefs.whatsapp).toBe(false)
    const input = h.countsCalls[0] as Record<string, unknown>
    expect(input.userId).toBe("u1")
    expect(input.mutedTabs).toEqual(["portal"])
    expect(input.inboxOpened).toEqual({ support: "2026-11-05T10:00:00Z" })
    expect(input.marketing).toBe(marketing)
    expect(input.now).toBe(NOW)
    expect((input.tabs as Array<{ id: string }>).map(t => t.id)).toContain("marketing")
  })

  it("a stored value that is not an object is not passed on as 'opened' times", async () => {
    h.state = { muted_tabs: [], alerts: {}, inbox_opened: "oops" }
    await buildMe(person({}), NOW)
    expect((h.countsCalls[0] as Record<string, unknown>).inboxOpened).toEqual({})
  })

  it("switches that cannot be read: rule defaults, NO count and NO number (an honest count needs the stored times)", async () => {
    h.stateThrows = true
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const me = await buildMe(person({}), NOW)
    spy.mockRestore()
    expect(me.prefs).toEqual({ mutedTabs: [], whatsapp: true, email: { support: true } })
    expect(me.counts).toBeNull()
    expect(me.badge).toBeNull()
    expect(me.tabs).toHaveLength(4) // the tabs themselves never depend on the switches
    expect(h.countsCalls).toHaveLength(0)
  })

  it("a count that failed stays null, never 0", async () => {
    h.countsResult = { counts: { talk: 3, portal: null }, badge: null }
    const me = await buildMe(person({}), NOW)
    expect(me.counts).toEqual({ talk: 3, portal: null })
    expect(me.badge).toBeNull()
  })
})
