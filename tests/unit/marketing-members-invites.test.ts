/**
 * TD Marketing council fixes (2026-10-18): the real acceptInvite / removeMember / updateMemberAccess code driven against a small
 * in-memory database and a fake login system. Each test is a situation that went wrong in the review.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { isEmailTakenError, isOrphanMarketingLogin, isWeakPasswordError, GENERIC_INVITE_ERROR, TRY_AGAIN_ERROR, WEAK_PASSWORD_ERROR, hashInviteToken } from "@/lib/marketing/invite-rules"

type Row = Record<string, unknown>
const tables: Record<string, Row[]> = {}
let seq = 0

function builder(table: string) {
  const filters: Array<(r: Row) => boolean> = []
  let op: "select" | "insert" | "update" = "select"
  let payload: Row = {}
  let opts: { count?: string; head?: boolean } | undefined
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const b: any = {
    select: (_c?: string, o?: { count?: string; head?: boolean }) => { opts = o ?? opts; return b },
    insert: (p: Row) => { op = "insert"; payload = p; return b },
    update: (p: Row) => { op = "update"; payload = p; return b },
    eq: (c: string, v: unknown) => { filters.push(r => r[c] === v); return b },
    is: (c: string, v: unknown) => { filters.push(r => (r[c] ?? null) === v); return b },
    gte: () => b, order: () => b, limit: () => b,
    maybeSingle: () => run().then(r => ({ data: (r.data as Row[])[0] ?? null, error: r.error })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    then: (res: any, rej: any) => run().then(res, rej),
  }
  async function run() {
    const rows = (tables[table] ||= [])
    if (op === "insert") {
      if (table === "marketing_team_members" && failMemberInsert) return { data: null, error: { message: "boom" } }
      rows.push({ id: `id-${++seq}`, created_at: new Date().toISOString(), ...payload })
      return { data: null, error: null }
    }
    const hit = rows.filter(r => filters.every(f => f(r)))
    if (op === "update") { hit.forEach(r => Object.assign(r, payload)); return { data: hit.map(r => ({ id: r.id })), error: null } }
    if (opts?.head) return { data: null, count: hit.length, error: null }
    return { data: hit, error: null }
  }
  return b
}

let failMemberInsert = false
const createUser = vi.fn()
const updateUserById = vi.fn()
const deleteUser = vi.fn()
const getUserById = vi.fn(async () => ({ data: { user: null } }))
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: { from: (t: string) => builder(t), auth: { admin: { createUser: (a: unknown) => createUser(a), updateUserById: (...a: unknown[]) => updateUserById(...a), deleteUser: (a: unknown) => deleteUser(a), getUserById: () => getUserById() } } },
}))
const findMarketing = vi.fn()
vi.mock("@/lib/auth-admin-helpers", () => ({ findMarketingAuthUserByEmail: (e: string) => findMarketing(e) }))
vi.mock("@/lib/config", () => ({ APP_BASE_URL: "https://app.example" }))
vi.mock("@/lib/marketing/settings", () => ({ getMarketingSetting: vi.fn(async () => ({ setter: ["leads.read"], seller: ["leads.read", "leads.pick"] })) }))

import { acceptInvite, createInvite, removeMember, updateMemberAccess, type Actor } from "@/lib/marketing/members"

const TOKEN = "T".repeat(43)
const PASSWORD = "A-long-enough-password-1"
const TEAM = "team-1"
const invite = (extra: Row = {}) => ({
  id: "inv-1", team_id: TEAM, email_lower: "chiara@example.com", member_role: "member", bundle: "setter", permissions: [],
  token_hash: hashInviteToken(TOKEN), expires_at: new Date(Date.now() + 86400000).toISOString(), used_at: null, revoked_at: null,
  created_by: "rocco@td.us", created_by_user_id: "rocco-id", created_at: new Date().toISOString(), ...extra,
})
const member = (userId: string, extra: Row = {}) => ({ team_id: TEAM, user_id: userId, member_role: "owner", status: "active", token_version: 1, bundle: null, permissions: [], ...extra })
const owner: Actor = { kind: "owner", userId: "rocco-id", label: "rocco@td.us", permissions: [] }

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k]
  failMemberInsert = false
  createUser.mockReset(); updateUserById.mockReset(); deleteUser.mockReset(); findMarketing.mockReset()
  createUser.mockResolvedValue({ data: { user: { id: "new-user" } }, error: null })
  updateUserById.mockResolvedValue({ error: null })
  deleteUser.mockResolvedValue({ error: null })
  tables.marketing_invites = [invite()]
  tables.marketing_team_members = [member("rocco-id")]
})

describe("invite rules (pure)", () => {
  it("recognises 'this email already has a login'", () => {
    expect(isEmailTakenError({ code: "email_exists" })).toBe(true)
    expect(isEmailTakenError({ status: 422, message: "A user with this email address has already been registered" })).toBe(true)
    expect(isEmailTakenError({ status: 500, message: "boom" })).toBe(false)
    expect(isEmailTakenError(null)).toBe(false)
  })
  it("recognises a refused password", () => {
    expect(isWeakPasswordError({ code: "weak_password" })).toBe(true)
    expect(isWeakPasswordError({ message: "Password is known to be weak and easy to guess" })).toBe(true)
    expect(isWeakPasswordError({ message: "database timeout" })).toBe(false)
  })
  it("only an unfinished MARKETING login is ours to finish", () => {
    expect(isOrphanMarketingLogin("marketing", 0)).toBe(true)
    expect(isOrphanMarketingLogin(" Marketing ", 0)).toBe(true)
    expect(isOrphanMarketingLogin("marketing", 1)).toBe(false)
    for (const r of ["client", "admin", "team", "partner", undefined, null]) expect(isOrphanMarketingLogin(r, 0)).toBe(false)
  })
})

describe("acceptInvite", () => {
  it("happy path: creates the login and the membership", async () => {
    const r = await acceptInvite({ token: TOKEN, password: PASSWORD })
    expect(r.ok).toBe(true)
    expect(tables.marketing_team_members.some(m => m.user_id === "new-user" && m.status === "active")).toBe(true)
    expect(tables.marketing_invites[0].used_at).toBeTruthy()
  })

  it("the email already belongs to a CLIENT: generic answer, the login is never touched, the invitation is revoked", async () => {
    createUser.mockResolvedValue({ data: null, error: { code: "email_exists", status: 422, message: "already registered" } })
    findMarketing.mockResolvedValue(null) // the finder only returns marketing logins
    const r = await acceptInvite({ token: TOKEN, password: PASSWORD })
    expect(r).toEqual({ ok: false, error: GENERIC_INVITE_ERROR })
    expect(updateUserById).not.toHaveBeenCalled()
    expect(deleteUser).not.toHaveBeenCalled()
    expect(tables.marketing_invites[0].revoked_at).toBeTruthy()
  })

  it("an UNFINISHED marketing login (an earlier acceptance crashed) is finished, not left stuck", async () => {
    createUser.mockResolvedValue({ data: null, error: { code: "email_exists", status: 422, message: "already registered" } })
    findMarketing.mockResolvedValue({ id: "orphan-1", app_metadata: { role: "marketing" }, user_metadata: { full_name: "Old" } })
    const r = await acceptInvite({ token: TOKEN, password: PASSWORD, fullName: "Chiara" })
    expect(r.ok).toBe(true)
    expect(updateUserById).toHaveBeenCalledTimes(1)
    expect((updateUserById.mock.calls[0][1] as { password: string }).password).toBe(PASSWORD)
    expect(tables.marketing_team_members.some(m => m.user_id === "orphan-1")).toBe(true)
  })

  it("a marketing login that ALREADY has a membership is not taken over", async () => {
    createUser.mockResolvedValue({ data: null, error: { code: "email_exists", status: 422, message: "already registered" } })
    findMarketing.mockResolvedValue({ id: "existing-9", app_metadata: { role: "marketing" } })
    tables.marketing_team_members.push(member("existing-9", { member_role: "member" }))
    const r = await acceptInvite({ token: TOKEN, password: PASSWORD })
    expect(r).toEqual({ ok: false, error: GENERIC_INVITE_ERROR })
    expect(updateUserById).not.toHaveBeenCalled()
  })

  it("a refused (weak) password gives the invitation back so the same link can be tried again", async () => {
    createUser.mockResolvedValue({ data: null, error: { code: "weak_password", message: "Password is too weak" } })
    const r = await acceptInvite({ token: TOKEN, password: PASSWORD })
    expect(r).toEqual({ ok: false, error: WEAK_PASSWORD_ERROR })
    expect(tables.marketing_invites[0].used_at ?? null).toBeNull()
    expect(tables.marketing_invites[0].revoked_at ?? null).toBeNull()
  })

  it("a temporary failure gives the invitation back too", async () => {
    createUser.mockResolvedValue({ data: null, error: { status: 500, message: "upstream timeout" } })
    const r = await acceptInvite({ token: TOKEN, password: PASSWORD })
    expect(r).toEqual({ ok: false, error: TRY_AGAIN_ERROR })
    expect(tables.marketing_invites[0].used_at ?? null).toBeNull()
  })

  it("if the membership cannot be saved the new login is deleted and the invitation is given back", async () => {
    failMemberInsert = true
    const r = await acceptInvite({ token: TOKEN, password: PASSWORD })
    expect(r).toEqual({ ok: false, error: TRY_AGAIN_ERROR })
    expect(deleteUser).toHaveBeenCalledWith("new-user")
    expect(tables.marketing_invites[0].used_at ?? null).toBeNull()
  })

  it("an invitation sent by a manager who was REMOVED is refused and revoked", async () => {
    tables.marketing_invites = [invite({ created_by_user_id: "manager-1" })]
    tables.marketing_team_members.push(member("manager-1", { member_role: "member", status: "removed" }))
    const r = await acceptInvite({ token: TOKEN, password: PASSWORD })
    expect(r).toEqual({ ok: false, error: GENERIC_INVITE_ERROR })
    expect(createUser).not.toHaveBeenCalled()
    expect(tables.marketing_invites[0].revoked_at).toBeTruthy()
  })

  it("an invitation sent by Antonio (no membership row) is not blocked", async () => {
    tables.marketing_invites = [invite({ created_by_user_id: "antonio-admin-id" })]
    const r = await acceptInvite({ token: TOKEN, password: PASSWORD })
    expect(r.ok).toBe(true)
  })
})

describe("removeMember", () => {
  const setup = () => {
    tables.marketing_team_members.push(member("manager-1", { member_role: "member", bundle: "seller", permissions: ["team.manage"] }))
    tables.marketing_invites = [invite({ id: "i-mgr", created_by_user_id: "manager-1" }), invite({ id: "i-rocco", token_hash: "other", created_by_user_id: "rocco-id" })]
  }
  it("if the login cannot be ended nothing changes and the person can try again", async () => {
    setup()
    updateUserById.mockResolvedValue({ error: { message: "auth down" } })
    const r = await removeMember({ teamId: TEAM, userId: "manager-1", actor: owner })
    expect(r.ok).toBe(false)
    expect(tables.marketing_team_members.find(m => m.user_id === "manager-1")?.status).toBe("active")
  })
  it("removing a manager ends his login, marks him removed and revokes ONLY his own open invitations", async () => {
    setup()
    const r = await removeMember({ teamId: TEAM, userId: "manager-1", actor: owner })
    expect(r.ok).toBe(true)
    expect(updateUserById).toHaveBeenCalledWith("manager-1", { ban_duration: "876000h" })
    expect(tables.marketing_team_members.find(m => m.user_id === "manager-1")?.status).toBe("removed")
    expect(tables.marketing_invites.find(i => i.id === "i-mgr")?.revoked_at).toBeTruthy()
    expect(tables.marketing_invites.find(i => i.id === "i-rocco")?.revoked_at ?? null).toBeNull()
  })
})

describe("updateMemberAccess", () => {
  it("a permissions value that is not a list is refused, never a crash", async () => {
    tables.marketing_team_members.push(member("chiara-1", { member_role: "member", bundle: "setter" }))
    for (const bad of [null, 5, "leads.read", { a: 1 }]) {
      const r = await updateMemberAccess({ teamId: TEAM, userId: "chiara-1", permissions: bad as unknown as unknown[], actor: owner })
      expect(r).toEqual({ ok: false, error: "Permissions must be a list." })
    }
  })
})

describe("exact ticks per person (the access popup)", () => {
  it("an invitation can carry an exact list with no role; the list is stored as given", async () => {
    tables.marketing_teams = [{ id: TEAM }]
    const r = await createInvite({ teamId: TEAM, email: "ale@example.com", bundle: null, permissions: ["leads.read", "reports.read", "team.notes"], actor: owner })
    expect(r.ok).toBe(true)
    const inv = tables.marketing_invites.find(i => i.email_lower === "ale@example.com")
    expect(inv?.bundle ?? null).toBeNull()
    expect(inv?.permissions).toEqual(["leads.read", "reports.read", "team.notes"])
  })
  it("an invitation with no role and no ticks is refused", async () => {
    tables.marketing_teams = [{ id: TEAM }]
    const r = await createInvite({ teamId: TEAM, email: "x@example.com", bundle: null, permissions: [], actor: owner })
    expect(r).toEqual({ ok: false, error: "Choose what this person can do." })
  })
  it("the gear can REMOVE one thing: sending the exact list without it, and no role, really removes it", async () => {
    tables.marketing_team_members.push(member("p-1", { member_role: "member", bundle: "seller", permissions: [] }))
    const r = await updateMemberAccess({ teamId: TEAM, userId: "p-1", bundle: null, permissions: ["leads.read"], actor: owner })
    expect(r.ok).toBe(true)
    const row = tables.marketing_team_members.find(m => m.user_id === "p-1")
    expect(row?.bundle).toBeNull()
    expect(row?.permissions).toEqual(["leads.read"])
  })
  it("an unknown permission is refused and nothing is saved", async () => {
    tables.marketing_team_members.push(member("p-2", { member_role: "member", bundle: null, permissions: ["leads.read"] }))
    const r = await updateMemberAccess({ teamId: TEAM, userId: "p-2", bundle: null, permissions: ["leads.read", "root.everything"], actor: owner })
    expect(r.ok).toBe(false)
    expect(tables.marketing_team_members.find(m => m.user_id === "p-2")?.permissions).toEqual(["leads.read"])
  })
  it("saving an empty list is refused (use Pause or Remove), never a person with silently no access", async () => {
    tables.marketing_team_members.push(member("p-3", { member_role: "member", bundle: null, permissions: ["leads.read"] }))
    const r = await updateMemberAccess({ teamId: TEAM, userId: "p-3", bundle: null, permissions: [], actor: owner })
    expect(r.ok).toBe(false)
    expect(tables.marketing_team_members.find(m => m.user_id === "p-3")?.permissions).toEqual(["leads.read"])
  })
  it("the new access/activity ticks are real permissions the owner can give", async () => {
    tables.marketing_team_members.push(member("p-4", { member_role: "member", bundle: null, permissions: ["leads.read"] }))
    const r = await updateMemberAccess({ teamId: TEAM, userId: "p-4", bundle: null, permissions: ["leads.read", "team.activity", "team.notes", "leads.worklist"], actor: owner })
    expect(r.ok).toBe(true)
  })
})

describe("a manager (not the owner) changes only what he holds himself", () => {
  const mgr: Actor = { kind: "member", userId: "mgr-1", label: "mgr@td.us", permissions: ["team.manage", "leads.read", "leads.mark", "chat"] }
  it("he can change an unrelated tick on a person who holds something he lacks; what he lacks stays untouched", async () => {
    tables.marketing_team_members.push(member("s-1", { member_role: "member", bundle: null, permissions: ["leads.read", "calls.host"] }))
    const r = await updateMemberAccess({ teamId: TEAM, userId: "s-1", bundle: null, permissions: ["leads.read", "calls.host", "chat"], actor: mgr })
    expect(r.ok).toBe(true)
    expect(tables.marketing_team_members.find(m => m.user_id === "s-1")?.permissions).toEqual(["leads.read", "calls.host", "chat"])
  })
  it("he cannot give what he lacks, and cannot take away what he lacks", async () => {
    tables.marketing_team_members.push(member("s-2", { member_role: "member", bundle: null, permissions: ["leads.read", "calls.host"] }))
    expect((await updateMemberAccess({ teamId: TEAM, userId: "s-2", bundle: null, permissions: ["leads.read", "calls.host", "money.read"], actor: mgr })).ok).toBe(false)
    expect((await updateMemberAccess({ teamId: TEAM, userId: "s-2", bundle: null, permissions: ["leads.read"], actor: mgr })).ok).toBe(false)
    expect(tables.marketing_team_members.find(m => m.user_id === "s-2")?.permissions).toEqual(["leads.read", "calls.host"])
  })
})
