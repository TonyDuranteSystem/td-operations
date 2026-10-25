import { describe, it, expect } from "vitest"
import { decideMarketingAccess, type GuardMembership, type GuardTeam } from "@/lib/marketing/guard-rules"
import { isSecureAdmin } from "@/lib/auth"
import { readFileSync } from "node:fs"

const team = (status: string): GuardTeam => ({ id: "t1", name: "Rocco's sales team", status })
const owner = (status = "active"): GuardMembership => ({ team_id: "t1", member_role: "owner", status, bundle: null, permissions: [] })

describe("an admin login that was added to a team as owner", () => {
  it("is let through when the door is asked as 'marketing' (what the guard does for an admin member), as the owner of that team", () => {
    const v = decideMarketingAccess({ signedIn: true, role: "marketing", memberships: [owner()], teams: [team("active")] })
    expect(v).toMatchObject({ ok: true, membership: { member_role: "owner" }, team: { id: "t1" } })
  })
  it("with the admin role itself the door still says no (the admin only gets in through View as or through a membership)", () => {
    expect(decideMarketingAccess({ signedIn: true, role: "admin", memberships: [owner()], teams: [team("active")] })).toMatchObject({ ok: false, status: 403, code: "NOT_MARKETING" })
  })
  it("a paused membership, a paused team and a team not yet switched on all turn him away (he then gets the View-as message)", () => {
    expect(decideMarketingAccess({ signedIn: true, role: "marketing", memberships: [owner("paused")], teams: [team("active")] })).toMatchObject({ ok: false, code: "MEMBER_PAUSED" })
    expect(decideMarketingAccess({ signedIn: true, role: "marketing", memberships: [owner()], teams: [team("paused")] })).toMatchObject({ ok: false, code: "TEAM_PAUSED" })
    expect(decideMarketingAccess({ signedIn: true, role: "marketing", memberships: [owner()], teams: [team("draft")] })).toMatchObject({ ok: false, code: "TEAM_NOT_ACTIVE" })
  })
  it("an admin with no membership at all has no team (View as is his only door)", () => {
    expect(decideMarketingAccess({ signedIn: true, role: "marketing", memberships: [], teams: [] })).toMatchObject({ ok: false, code: "NO_TEAM" })
  })
  it("who counts as an admin login (the one a removal must never ban)", () => {
    expect(isSecureAdmin({ email: "x@y.z", app_metadata: { role: "admin" } } as never)).toBe(true)
    expect(isSecureAdmin({ email: "x@y.z", app_metadata: { role: "marketing" } } as never)).toBe(false)
    expect(isSecureAdmin(null)).toBe(false)
  })
})

describe("the CRM menu: no extra tab, one red number on the Marketing item", () => {
  const sidebar = readFileSync("components/dashboard/sidebar.tsx", "utf8")
  it("has no separate 'Marketing team' item (Antonio: too many tabs)", () => {
    expect(sidebar).not.toMatch(/id: 'marketing-team'/)
    expect(sidebar).not.toMatch(/name: 'Marketing team'/)
  })
  it("puts the waiting-for-him number on the existing Marketing item, fed by the badges endpoint", () => {
    expect(sidebar).toMatch(/item\.id === 'marketing' && liveMarketing > 0/)
    expect(sidebar).toMatch(/data\.marketing === 'number'/)
    const route = readFileSync("app/api/dashboard/badges/route.ts", "utf8")
    expect(route).toMatch(/adminMemberContext/)
    expect(route).toMatch(/marketing,/)
  })
  it("the Marketing Overview has the one button into the workspace", () => {
    const page = readFileSync("app/(dashboard)/marketing-leads/page.tsx", "utf8")
    expect(page).toMatch(/href="\/marketing"[\s\S]*Open the team workspace/)
    expect(page).toMatch(/adminMemberContext/)
  })
})

describe("the admin manages the team as the admin, and always lands in the same team", () => {
  it("every place that builds the actor from the workspace context maps an admin to the admin kind", () => {
    for (const f of ["app/api/marketing/team/members/[userId]/route.ts", "app/api/marketing/team/members/route.ts", "app/api/marketing/team/invites/[id]/route.ts"]) {
      expect(readFileSync(f, "utf8")).toMatch(/ctx\.admin \? "admin"/)
    }
  })
  it("the guard marks both admin doors (View as and his own membership) and orders his memberships", () => {
    const g = readFileSync("lib/marketing/guard.ts", "utf8")
    expect(g.match(/admin: true/g)?.length).toBeGreaterThanOrEqual(2)
    expect(g).toMatch(/\.order\("joined_at"/)
  })
  it("removing a member never bans when the login cannot be looked up (fail closed)", () => {
    expect(readFileSync("lib/marketing/members.ts", "utf8")).toMatch(/target\?\.error \|\| !target\?\.data\?\.user\) return fail/)
  })
})
