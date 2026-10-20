/** TD Marketing Slice 2b: the Team page's rules — plain labels, who may hand out what, listing and cancelling invitations (real code, in-memory database). */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { MARKETING_PERMISSIONS } from "@/lib/marketing/permissions"
import { PERMISSION_LABELS, describePermissions, grantablePermissions, permissionLabel, roleLabel } from "@/lib/marketing/permission-labels"

type Row = Record<string, unknown>
const tables: Record<string, Row[]> = {}
function builder(table: string) {
  const filters: Array<(r: Row) => boolean> = []
  let op: "select" | "update" = "select"
  let payload: Row = {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const b: any = {
    select: () => b,
    update: (p: Row) => { op = "update"; payload = p; return b },
    eq: (c: string, v: unknown) => { filters.push(r => r[c] === v); return b },
    is: (c: string, v: unknown) => { filters.push(r => (r[c] ?? null) === v); return b },
    gt: (c: string, v: string) => { filters.push(r => String(r[c]) > v); return b },
    order: () => b, limit: () => b,
    maybeSingle: () => run().then(r => ({ data: (r.data as Row[])[0] ?? null, error: r.error })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    then: (res: any, rej: any) => run().then(res, rej),
  }
  async function run() {
    const hit = (tables[table] ||= []).filter(r => filters.every(f => f(r)))
    if (op === "update") { hit.forEach(r => Object.assign(r, payload)); return { data: hit.map(r => ({ id: r.id })), error: null } }
    return { data: hit, error: null }
  }
  return b
}
vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: { from: (t: string) => builder(t), auth: { admin: {} } } }))
vi.mock("@/lib/auth-admin-helpers", () => ({ findMarketingAuthUserByEmail: vi.fn() }))
vi.mock("@/lib/config", () => ({ APP_BASE_URL: "https://app.example" }))
vi.mock("@/lib/marketing/settings", () => ({ getMarketingSetting: vi.fn(async () => ({})) }))

import { listOpenInvites, revokeInvite, type Actor } from "@/lib/marketing/members"

const TEAM = "team-1", OTHER = "team-2"
const ID = (n: number) => `00000000-0000-4000-8000-00000000000${n}`
const future = () => new Date(Date.now() + 86400000).toISOString()
const past = () => new Date(Date.now() - 86400000).toISOString()
const inv = (n: number, extra: Row = {}) => ({ id: ID(n), team_id: TEAM, email_lower: `p${n}@example.com`, member_role: "member", bundle: "setter", permissions: [], expires_at: future(), used_at: null, revoked_at: null, created_by: "rocco@td.us", created_at: new Date(Date.now() + n).toISOString(), ...extra })
const owner: Actor = { kind: "owner", userId: "rocco-id", label: "rocco@td.us", permissions: [] }
const admin: Actor = { kind: "admin", userId: null, label: "antonio", permissions: [] }
const plainMember: Actor = { kind: "member", userId: "m1", label: "m1@td.us", permissions: ["leads.read"] }
const manager: Actor = { kind: "member", userId: "m2", label: "m2@td.us", permissions: ["team.manage"] }

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k]
  tables.marketing_invites = [inv(1), inv(2, { used_at: new Date().toISOString() }), inv(3, { revoked_at: new Date().toISOString() }), inv(4, { expires_at: past() }), inv(5, { team_id: OTHER }), inv(6, { member_role: "owner" })]
})

describe("labels", () => {
  it("every permission has a plain-English label", () => {
    for (const p of MARKETING_PERMISSIONS) expect(PERMISSION_LABELS[p]).toMatch(/^[A-Z]/)
    expect(new Set(Object.values(PERMISSION_LABELS)).size).toBe(MARKETING_PERMISSIONS.length)
  })
  it("an unknown permission is shown as itself, a role key is made readable", () => {
    expect(permissionLabel("made.up")).toBe("made.up")
    expect(roleLabel("content_creator")).toBe("Content creator")
    expect(roleLabel("setter")).toBe("Setter")
    expect(roleLabel(null)).toBe("No role")
  })
  it("describes a role in the order the permissions are defined, and an empty one honestly", () => {
    expect(describePermissions(["leads.mark", "leads.read"])).toBe("See the leads, Mark leads Good, Not in target or Call back")
    expect(describePermissions([])).toBe("Nothing yet")
    expect(describePermissions(["leads.read", "zzz"])).toBe("See the leads, zzz")
  })
  it("an owner may hand out everything, a member only what he holds", () => {
    expect(grantablePermissions(true, [])).toHaveLength(MARKETING_PERMISSIONS.length)
    expect(grantablePermissions(false, ["leads.read", "team.manage", "nonsense"])).toEqual(["leads.read", "team.manage"])
  })
})

describe("listOpenInvites", () => {
  it("only this team's invitations that are still open, newest first", async () => {
    const r = await listOpenInvites(TEAM)
    expect(r.map(x => x.id).sort()).toEqual([ID(1), ID(6)].sort())
    expect(JSON.stringify(r)).not.toMatch(/token/)
  })
})

describe("revokeInvite", () => {
  it("the owner cancels an open invitation of his team", async () => {
    expect(await revokeInvite({ teamId: TEAM, inviteId: ID(1), actor: owner })).toEqual({ ok: true })
    expect(tables.marketing_invites[0].revoked_at).toBeTruthy()
    expect((await listOpenInvites(TEAM)).map(x => x.id)).toEqual([ID(6)])
  })
  it("a member with 'manage the team' can; one without cannot", async () => {
    expect((await revokeInvite({ teamId: TEAM, inviteId: ID(1), actor: manager })).ok).toBe(true)
    tables.marketing_invites[0].revoked_at = null
    expect(await revokeInvite({ teamId: TEAM, inviteId: ID(1), actor: plainMember })).toMatchObject({ ok: false, error: "You cannot manage the team." })
    expect(tables.marketing_invites[0].revoked_at).toBeNull()
  })
  it("another team's invitation is 'not found' and stays open", async () => {
    expect(await revokeInvite({ teamId: TEAM, inviteId: ID(5), actor: owner })).toMatchObject({ ok: false, error: "That invitation was not found." })
    expect(tables.marketing_invites[4].revoked_at).toBeNull()
  })
  it("a used, already-cancelled or malformed id is 'not found'", async () => {
    for (const id of [ID(2), ID(3), "not-a-uuid", "' or 1=1 --"]) expect(await revokeInvite({ teamId: TEAM, inviteId: id, actor: owner })).toMatchObject({ ok: false, error: "That invitation was not found." })
  })
  it("an owner invitation can only be cancelled by Antonio", async () => {
    expect(await revokeInvite({ teamId: TEAM, inviteId: ID(6), actor: owner })).toMatchObject({ ok: false, error: "Only Antonio can cancel an owner invitation." })
    expect(tables.marketing_invites[5].revoked_at).toBeNull()
    expect((await revokeInvite({ teamId: TEAM, inviteId: ID(6), actor: admin })).ok).toBe(true)
  })
})
