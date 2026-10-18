import { describe, it, expect } from "vitest"
import {
  MARKETING_PERMISSIONS, effectivePermissions, canGrant, validatePermissionList, hasPermission, cleanPermissions,
} from "@/lib/marketing/permissions"
import { decideMarketingAccess, type GuardMembership, type GuardTeam } from "@/lib/marketing/guard-rules"
import { defaultForSetting } from "@/lib/marketing/settings-schema"

const bundles = defaultForSetting("permission_bundles") as Record<string, string[]>

describe("effective permissions", () => {
  it("the owner has every permission", () => {
    expect(effectivePermissions({ memberRole: "owner", bundles }).length).toBe(MARKETING_PERMISSIONS.length)
  })
  it("a setter can call and mark leads but never touch money, export, offers or the team", () => {
    const p = effectivePermissions({ memberRole: "member", bundle: "setter", bundles })
    for (const ok of ["leads.read", "leads.call", "leads.mark", "whatsapp", "chat"]) expect(p, ok).toContain(ok)
    for (const no of ["payment_links.create", "money.read", "leads.export", "offers.create", "team.manage", "leads.pick"]) expect(p, no).not.toContain(no)
  })
  it("a member's extra grants add to his bundle; unknown extras are dropped", () => {
    const p = effectivePermissions({ memberRole: "member", bundle: "setter", bundles, extra: ["money.read", "bogus"] })
    expect(p).toContain("money.read")
    expect(p).not.toContain("bogus")
  })
  it("a bundle that no longer exists grants nothing (fails closed)", () => {
    expect(effectivePermissions({ memberRole: "member", bundle: "deleted", bundles })).toEqual([])
    expect(effectivePermissions({ memberRole: "member", bundles })).toEqual([])
  })
  it("every default bundle uses only known permissions", () => {
    for (const [k, list] of Object.entries(bundles)) expect(cleanPermissions(list).length, k).toBe(list.length)
  })
  it("hasPermission", () => {
    expect(hasPermission(["chat"], "chat")).toBe(true)
    expect(hasPermission(["chat"], "money.read")).toBe(false)
  })
})

describe("granting access", () => {
  const owner = { granterRole: "owner" as const, granterPermissions: [] as string[], granterUserId: "rocco", targetUserId: "ale" }
  it("the owner may give anything that exists", () => {
    expect(canGrant({ ...owner, requested: ["money.read", "offers.create", "leads.export"] }).ok).toBe(true)
  })
  it("nobody changes his own access", () => {
    expect(canGrant({ ...owner, targetUserId: "rocco", requested: ["chat"] }).ok).toBe(false)
  })
  it("an unknown permission is refused, not ignored", () => {
    const r = canGrant({ ...owner, requested: ["chat", "root"] })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/root/)
  })
  it("a member without team.manage cannot grant at all; with it, only what he has", () => {
    const m = { granterRole: "member" as const, granterUserId: "chiara", targetUserId: "new" }
    expect(canGrant({ ...m, granterPermissions: ["chat"], requested: ["chat"] }).ok).toBe(false)
    expect(canGrant({ ...m, granterPermissions: ["team.manage", "chat"], requested: ["chat"] }).ok).toBe(true)
    expect(canGrant({ ...m, granterPermissions: ["team.manage", "chat"], requested: ["money.read"] }).ok).toBe(false)
  })
  it("a non-empty ceiling caps even the owner; an empty one means no ceiling", () => {
    expect(canGrant({ ...owner, requested: ["money.read"], ceiling: ["chat"] }).ok).toBe(false)
    expect(canGrant({ ...owner, requested: ["chat"], ceiling: ["chat"] }).ok).toBe(true)
    expect(canGrant({ ...owner, requested: ["money.read"], ceiling: [] }).ok).toBe(true)
    expect(canGrant({ ...owner, requested: ["money.read"], ceiling: null }).ok).toBe(true)
  })
  it("validatePermissionList refuses non-lists", () => {
    expect(validatePermissionList("chat").ok).toBe(false)
    expect(validatePermissionList(["chat"]).ok).toBe(true)
  })
})

describe("the guard decision (checked on every request)", () => {
  const mem = (over: Partial<GuardMembership> = {}): GuardMembership => ({ team_id: "t1", member_role: "member", status: "active", bundle: "setter", permissions: [], ...over })
  const team = (over: Partial<GuardTeam> = {}): GuardTeam => ({ id: "t1", name: "Rocco's team", status: "active", ...over })
  const base = { signedIn: true, role: "marketing", memberships: [mem()], teams: [team()] }
  it("an active member of an active team gets in", () => {
    const v = decideMarketingAccess(base)
    expect(v.ok).toBe(true)
  })
  it("signed out → 401; a non-marketing login → 403", () => {
    expect(decideMarketingAccess({ ...base, signedIn: false })).toMatchObject({ ok: false, status: 401 })
    for (const role of ["team", "admin", "client", "partner", "", undefined]) expect(decideMarketingAccess({ ...base, role }), String(role)).toMatchObject({ ok: false, status: 403, code: "NOT_MARKETING" })
  })
  it("a removed member is out on the very next request", () => {
    expect(decideMarketingAccess({ ...base, memberships: [mem({ status: "removed" })] })).toMatchObject({ ok: false, code: "NO_TEAM" })
  })
  it("a paused member is told so", () => {
    expect(decideMarketingAccess({ ...base, memberships: [mem({ status: "paused" })] })).toMatchObject({ ok: false, code: "MEMBER_PAUSED" })
  })
  it("a team that is still a draft or is paused turns everyone away, owner included", () => {
    expect(decideMarketingAccess({ ...base, teams: [team({ status: "draft" })] })).toMatchObject({ ok: false, code: "TEAM_NOT_ACTIVE" })
    expect(decideMarketingAccess({ ...base, teams: [team({ status: "paused" })], memberships: [mem({ member_role: "owner" })] })).toMatchObject({ ok: false, code: "TEAM_PAUSED" })
  })
  it("no membership, or a membership pointing at a team that is gone → no team", () => {
    expect(decideMarketingAccess({ ...base, memberships: [] })).toMatchObject({ ok: false, code: "NO_TEAM" })
    expect(decideMarketingAccess({ ...base, teams: [] })).toMatchObject({ ok: false, code: "NO_TEAM" })
  })
  it("an unknown team status fails closed", () => {
    expect(decideMarketingAccess({ ...base, teams: [team({ status: "weird" })] }).ok).toBe(false)
  })
})
