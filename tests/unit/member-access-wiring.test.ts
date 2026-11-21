/**
 * The wiring of the per-member "portal access" tick (dev job beb43385, delivery B). The rules themselves are tested in
 * member-access-switch / apply-form-portal-access / member-logins / wizard-members; this pins that the screens and the two
 * saving paths are connected to them, and that nothing shows while the switch is off.
 */
import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"

const root = process.cwd()
const read = (p: string) => readFileSync(join(root, p), "utf8")
const count = (s: string, needle: string) => s.split(needle).length - 1

describe("no button for Antonio", () => {
  it("the switch is a known app setting with its three states, and the Maintenance screen has no toggle for it", () => {
    const settings = read("lib/settings.ts")
    expect(settings).toContain('"member_portal_access_enabled"')
    expect(settings).toMatch(/"test" = test records only/)
    expect(read("components/dashboard/maintenance-panel.tsx")).not.toContain("member_portal_access_enabled")
  })
})

describe("the wizard asks the server, per record", () => {
  const page = read("app/portal/wizard/page.tsx")
  const client = read("app/portal/wizard/wizard-client.tsx")

  it("the page decides on the server and only for formation and onboarding", () => {
    expect(page).toContain("memberPortalAccessOn({ accountId, leadId: formationLeadId, contactId })")
    expect(page).toMatch(/\(wizardType === 'formation' \|\| wizardType === 'onboarding'\) &&\s+\(await memberPortalAccessOn/)
    expect(page).toContain("memberAccessTick={memberAccessTick}")
  })

  it("the tick field is added to the Members step only when the switch is on", () => {
    expect(client).toContain("const memberTickOn = memberAccessTick && (wizardType === 'formation' || wizardType === 'onboarding')")
    expect(client).toContain("if (memberTickOn && Array.isArray(f.members)) f.members = [...f.members, MEMBER_PORTAL_ACCESS_FIELD]")
    expect(client).toContain("if (itinCount <= 0 && !memberTickOn) return baseFields")
  })

  it("the SS-4 notice and the orange line under each choice show only while the switch is on", () => {
    expect(client).toContain("{memberTickOn && requiresSs4Signer && (")
    expect(count(client, "why={memberTickOn ?")).toBe(2)
    expect(client).toContain("{memberTickOn && (\n              <div className=\"mb-2\">\n                <Ss4EinLetterNotice")
  })

  it("a new member row starts ticked", () => {
    expect(client).toMatch(/if \(memberTickOn\) handleFieldChange\(`member_\$\{memberCount\}_member_portal_access`, true\)/)
  })
})

describe("both saving paths apply the answer after the link is written", () => {
  for (const [name, file] of [
    ["formation", "lib/operations/formation-materialize.ts"],
    ["onboarding", "lib/jobs/handlers/onboarding-setup.ts"],
  ] as const) {
    it(`${name}: an individual member and a company member's representative each get applyFormPortalAccess, never for the owner`, () => {
      const src = read(file)
      expect(src).toContain('import { applyFormPortalAccess } from "@/lib/members/apply-form-portal-access"')
      expect(count(src, "applyFormPortalAccess({")).toBe(2)
      expect(count(src, "ticked: m.member_portal_access")).toBe(2)
      expect(src).toMatch(/ownerContactId: (params\.contact_id|contact_id)/)
    })
  }
})

describe("the welcome-package login loop", () => {
  const src = read("lib/jobs/handlers/welcome-package-setup.ts")
  it("goes through the shared loop (marked links skipped) and asks the switch for the welcome email", () => {
    expect(src).toContain("createLoginsForLinkedMembers")
    expect(src).toContain("memberPortalAccessOn({ accountId: p.account_id })")
    expect(src).not.toContain("autoCreatePortalUser(")
  })

  it("the default link read leaves out a link with the no-access mark", () => {
    expect(read("lib/portal/member-logins.ts")).toMatch(/\.is\('access_revoked_at', null\)/)
  })

  it("a login picked from a company alone never lands on a no-access member", () => {
    expect(read("lib/portal/auto-create.ts")).toContain(".is('access_revoked_at', null) // a member with the no-access mark never gets a login picked for them")
  })
})
