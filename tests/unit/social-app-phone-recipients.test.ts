/**
 * TD Social — who a Marketing phone alert may go to, including Antonio's rule (5 Nov 2026): he is told about a call only when the call involves him.
 * A fake database stands in for the Marketing tables so the real recipient code runs.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const { state } = vi.hoisted(() => ({
  state: {
    members: [] as Array<{ user_id: string; member_role: "owner" | "member"; status: string; bundle: string | null; permissions: string[] | null }>,
    teamStatus: "active",
    ownerEmail: "antonio@x.test" as string | undefined,
    jointLinks: [] as Array<{ team_id: string; lead_id: string; status: string }>,
    jointReadFails: false,
    users: {} as Record<string, { email: string; role: string }>,
  },
}))

vi.mock("@/lib/team/directory", () => ({ listTeamMembers: vi.fn() }))
vi.mock("@/lib/marketing/settings", () => ({ getMarketingSetting: async () => ({}) }))
vi.mock("@/lib/marketing/time-prefs-server", () => ({
  loadPrefsAndRows: async () => ({ prefs: { ownerClock: { zone: "America/New_York", label: "Antonio", email: state.ownerEmail } }, rows: state.members, bundles: {} }),
}))
vi.mock("@/lib/supabase-admin", () => {
  const chain = (table: string) => {
    const filters: Array<[string, string, unknown]> = []
    const c: Record<string, unknown> = {}
    c.select = (_cols: string, opts?: { head?: boolean }) => { c.opts = opts; return c }
    c.eq = (col: string, v: unknown) => { filters.push(["eq", col, v]); return c }
    c.in = (col: string, v: unknown) => { filters.push(["in", col, v]); return c }
    const run = () => {
      if (table === "marketing_team_members") {
        const ids = (filters.find(f => f[1] === "user_id")?.[2] as string[] | undefined) ?? []
        return { data: state.members.filter(m => ids.includes(m.user_id)), error: null }
      }
      if (table === "marketing_teams") return { data: { id: "t1", status: state.teamStatus }, error: null }
      if (table === "marketing_joint_links") {
        if (state.jointReadFails) return { count: null, error: { message: "down" } }
        const lead = filters.find(f => f[1] === "lead_id")?.[2]
        const statuses = (filters.find(f => f[1] === "status")?.[2] as string[] | undefined) ?? []
        return { count: state.jointLinks.filter(l => l.lead_id === lead && statuses.includes(l.status)).length, error: null }
      }
      return { data: [], error: null }
    }
    c.maybeSingle = async () => run()
    c.then = (resolve: (v: unknown) => void) => resolve(run())
    return c
  }
  return {
    supabaseAdmin: {
      from: (t: string) => chain(t),
      auth: { admin: { getUserById: async (id: string) => ({ data: { user: state.users[id] ? { id, email: state.users[id].email, app_metadata: { role: state.users[id].role } } : null }, error: null }) } },
    },
  }
})

import { marketingRecipients, withOwnerForCallAlert, withoutOwnerUnlessInvolved } from "@/lib/app/phone-recipients"

const A = "antonio-id", R = "rocco-id", S = "setter-id"
const member = (user_id: string, over: Partial<(typeof state.members)[number]> = {}) => ({ user_id, member_role: "owner" as const, status: "active", bundle: null, permissions: ["chat"], ...over })

beforeEach(() => {
  state.members = [member(A), member(R), member(S, { member_role: "member", permissions: ["chat", "leads.read", "leads.mark"] })]
  state.teamStatus = "active"
  state.ownerEmail = "antonio@x.test"
  state.jointLinks = []
  state.jointReadFails = false
  state.users = { [A]: { email: "antonio@x.test", role: "admin" }, [R]: { email: "rocco@x.test", role: "marketing" }, [S]: { email: "setter@x.test", role: "marketing" } }
})

const sorted = (xs: string[]) => [...xs].sort()

describe("a call moved by a person (marketing_lead_moved)", () => {
  it("a call that involves only Rocco: Antonio is NOT told; Rocco and the setter are", async () => {
    const out = await marketingRecipients("t1", [A, R, S], { kind: "marketing_lead_moved", leadId: "lead-solo" })
    expect(sorted(out)).toEqual(sorted([R, S]))
  })

  it("a call WITH Antonio (the lead has a booking link, booked): everyone is told, Antonio included", async () => {
    state.jointLinks = [{ team_id: "t1", lead_id: "lead-joint", status: "booked" }]
    expect(sorted(await marketingRecipients("t1", [A, R, S], { kind: "marketing_lead_moved", leadId: "lead-joint" }))).toEqual(sorted([A, R, S]))
  })

  it("a call with Antonio that was cancelled still counts as his", async () => {
    state.jointLinks = [{ team_id: "t1", lead_id: "lead-joint", status: "cancelled" }]
    expect(await marketingRecipients("t1", [A, R], { kind: "marketing_lead_moved", leadId: "lead-joint" })).toContain(A)
  })

  it("a booking link that was only offered and never used (open) does NOT make it his call", async () => {
    state.jointLinks = [{ team_id: "t1", lead_id: "lead-open", status: "open" }]
    expect(await marketingRecipients("t1", [A, R], { kind: "marketing_lead_moved", leadId: "lead-open" })).toEqual([R])
  })

  it("another lead's booking link never makes this lead his", async () => {
    state.jointLinks = [{ team_id: "t1", lead_id: "other-lead", status: "booked" }]
    expect(await marketingRecipients("t1", [A, R], { kind: "marketing_lead_moved", leadId: "lead-solo" })).toEqual([R])
  })

  it("no lead named, or the lookup failing, means Antonio is NOT told (any doubt = not told)", async () => {
    expect(await marketingRecipients("t1", [A, R], { kind: "marketing_lead_moved" })).toEqual([R])
    state.jointLinks = [{ team_id: "t1", lead_id: "lead-joint", status: "booked" }]
    state.jointReadFails = true
    expect(await marketingRecipients("t1", [A, R], { kind: "marketing_lead_moved", leadId: "lead-joint" })).toEqual([R])
  })

  it("holds even when the team's owner-mailbox setting is missing (every CRM admin is treated as the owner)", async () => {
    state.ownerEmail = undefined
    expect(await marketingRecipients("t1", [A, R, S], { kind: "marketing_lead_moved", leadId: "lead-solo" }).then(sorted)).toEqual(sorted([R, S]))
  })
})

describe("a client moved or cancelled a call with Antonio (marketing_call)", () => {
  it("the link's seller (Rocco) is told AND Antonio is added", async () => {
    expect(sorted(await marketingRecipients("t1", [R], { kind: "marketing_call", leadId: "lead-joint" }))).toEqual(sorted([A, R]))
  })

  it("Antonio is not added twice when he is already the seller", async () => {
    expect(sorted(await marketingRecipients("t1", [A], { kind: "marketing_call" }))).toEqual([A])
  })

  it("without a usable owner mailbox nobody is added (the seller is still told)", async () => {
    state.ownerEmail = undefined
    expect(await marketingRecipients("t1", [R], { kind: "marketing_call" })).toEqual([R])
  })

  it("an owner who is paused is not added; the usual membership rules still apply", async () => {
    state.members = [member(A, { status: "paused" }), member(R)]
    expect(await marketingRecipients("t1", [R], { kind: "marketing_call" })).toEqual([R])
  })
})

describe("every other Marketing alert is exactly who the browser alert goes to", () => {
  it("chat, team chat and news: nobody is added or removed because of the call rules", async () => {
    for (const kind of ["marketing_lead_chat", "marketing_team_chat", "marketing_news"]) {
      expect(sorted(await marketingRecipients("t1", [A, R], { kind }))).toEqual(sorted([A, R]))
    }
  })

  it("people outside the list passed in are never added (except the owner for a call with him)", async () => {
    expect(await marketingRecipients("t1", [R], { kind: "marketing_lead_chat" })).toEqual([R])
  })

  it("a paused team, or a person without the chat permission, gets nothing", async () => {
    state.teamStatus = "paused"
    expect(await marketingRecipients("t1", [A, R], { kind: "marketing_lead_chat" })).toEqual([])
    state.teamStatus = "active"
    state.members = [member(R, { member_role: "member", permissions: ["leads.read"] })]
    expect(await marketingRecipients("t1", [R], { kind: "marketing_lead_chat" })).toEqual([])
  })
})

describe("the two pure rules", () => {
  it("withOwnerForCallAlert adds the owner only for a call alert", () => {
    expect(withOwnerForCallAlert("marketing_call", [R], A)).toEqual([R, A])
    expect(withOwnerForCallAlert("marketing_call", [R], null)).toEqual([R])
    expect(withOwnerForCallAlert("marketing_lead_chat", [R], A)).toEqual([R])
  })

  it("withoutOwnerUnlessInvolved removes owners only from a moved-call alert and only when not involved", () => {
    expect(withoutOwnerUnlessInvolved("marketing_lead_moved", [A, R], [A], false)).toEqual([R])
    expect(withoutOwnerUnlessInvolved("marketing_lead_moved", [A, R], [A], true)).toEqual([A, R])
    expect(withoutOwnerUnlessInvolved("marketing_call", [A, R], [A], false)).toEqual([A, R])
  })
})
