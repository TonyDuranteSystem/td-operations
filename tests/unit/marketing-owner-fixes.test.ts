import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { MARKETING_SETTING_DEFS } from "@/lib/marketing/settings-schema"
import { audienceMatches, ANNOUNCEMENTS } from "@/lib/marketing/news"
import { modulesFor } from "@/lib/marketing/workspace"
import { lanesFor } from "@/lib/marketing/lead-chat"

// Antonio, 29 Oct 2026: "why the setter has Novità and Documenti?" / "I click View as Setter, go back to my dashboard, click Messages and I see the setter's messages".

const bundles = MARKETING_SETTING_DEFS.permission_bundles.fallback as Record<string, string[]>

describe("what the setter gets by default", () => {
  it("has no Documents (nobody decided it): the company presentation and the services description are not hers by default", () => {
    expect(bundles.setter).not.toContain("documents")
    expect(bundles.setter).not.toContain("documents.manage")
    expect(modulesFor(bundles.setter).map(m => m.key)).not.toContain("documents")
  })
  it("keeps What's New (Antonio asked for it so the team learns about new features) and her working screens", () => {
    const keys = modulesFor(bundles.setter).map(m => m.key)
    expect(keys).toContain("news")
    expect(keys).toEqual(expect.arrayContaining(["call-list", "board", "chat", "whatsapp"]))
  })
  it("the roles that work with the material still have Documents", () => {
    for (const b of ["seller", "content", "analyst"]) expect(bundles[b]).toContain("documents")
  })
  it("the 'Documents is live' post is for the people who have the tab, not for the setter", () => {
    const a = ANNOUNCEMENTS.find(x => x.key === "documents")!
    expect(audienceMatches(a.audience, bundles.seller)).toBe(true)
    expect(audienceMatches(a.audience, bundles.setter)).toBe(false)
  })
})

describe("Antonio's own CRM section and his menu number know he is Antonio", () => {
  const guard = readFileSync("lib/marketing/guard.ts", "utf8")
  const fn = guard.slice(guard.indexOf("export async function adminMemberContext"), guard.indexOf("export async function requireMarketing") > 0 ? guard.indexOf("/** For API routes") : undefined)
  it("the context he gets in the CRM (Home panel, menu red number, dashboard badge) carries the admin mark", () => {
    expect(fn).toMatch(/admin: true/)
  })
  it("with that mark he is in the owners chat only; without it he would be handed the setter's chat too (the bug)", () => {
    const perms = [...MARKETING_SETTING_DEFS.permission_bundles.fallback.seller, "team.manage"]
    expect(lanesFor({ permissions: perms, admin: true, viewAs: false })).toEqual(["owners"])
    expect(lanesFor({ permissions: perms, admin: false, viewAs: false })).toEqual(["owners", "setter"])
  })
})

describe("View as ends by itself when he opens his own Marketing section", () => {
  const layout = readFileSync("app/(dashboard)/marketing-leads/layout.tsx", "utf8")
  const comp = readFileSync("components/marketing/clear-view-as.tsx", "utf8")
  it("the CRM Marketing layout reads the View-as cookie and shows the clearing component only while it is on", () => {
    expect(layout).toMatch(/parseViewAs\(cookies\(\)\.get\(VIEW_AS_COOKIE\)\?\.value\) !== null/)
    expect(layout).toMatch(/viewingAs && <ClearViewAs \/>/)
  })
  it("the component switches View as off through the same route the Exit button uses, and renders nothing", () => {
    expect(comp).toMatch(/fetch\('\/api\/marketing-admin\/view-as', \{ method: 'DELETE' \}\)/)
    expect(comp).toMatch(/return null/)
  })
  it("the buttons that START View as leave the CRM section by a full page load, so the clearing can never undo a fresh choice", () => {
    const buttons = readFileSync("app/(dashboard)/marketing-leads/teams/view-as-buttons.tsx", "utf8")
    expect(buttons).toMatch(/window\.location\.href = "\/marketing"/)
    expect(buttons).not.toMatch(/router\.refresh/)
  })
})
