import { describe, it, expect } from "vitest"
import { accessLabel, accessWarnings, describeAccess, permissionsOfRoles, previewMenu, ACCESS_GROUPS, ALL_GROUPED } from "@/lib/marketing/access"
import { canSeeNotes, canSeePhone, withoutPhone, answersWithoutPhone } from "@/lib/marketing/lead-privacy"
import { effectivePermissions, MARKETING_PERMISSIONS } from "@/lib/marketing/permissions"
import { modulesFor, homeFor } from "@/lib/marketing/workspace"
import { defaultForSetting } from "@/lib/marketing/settings-schema"

const bundles = defaultForSetting("permission_bundles") as Record<string, string[]>

describe("roles are presets; a person's access is their exact list", () => {
  it("the starting roles exist: setter, seller, ad person (content), analyst", () => {
    expect(Object.keys(bundles).sort()).toEqual(["analyst", "content", "seller", "setter"])
  })
  it("a list that equals a role is described as that role with no changes", () => {
    const d = describeAccess(bundles.setter, bundles)
    expect(d.roles).toContain("setter")
    expect(d.added).toEqual([])
    expect(d.missing).toEqual([])
    expect(accessLabel(bundles.setter, bundles)).toBe("Setter")
  })
  it("removing one thing from a role is a visible change, not a different role", () => {
    const list = bundles.setter.filter(p => p !== "leads.call")
    const d = describeAccess(list, bundles)
    expect(d.roles).toContain("setter")
    expect(d.missing).toEqual(["leads.call"])
    expect(accessLabel(list, bundles)).toBe("Setter, 1 change")
  })
  it("two roles together read as 'Ad person + Analyst (read only)'", () => {
    const list = permissionsOfRoles(["content", "analyst"], bundles)
    expect(accessLabel(list, bundles)).toBe("Ad person + Analyst (read only)")
  })
  it("a list that matches no role is custom access", () => {
    expect(accessLabel(["chat"], bundles)).toBe("Custom access")
    expect(accessLabel(["leads.read", "money.read", "offers.create"], bundles)).toBe("Custom access")
  })
  it("a seller is not mistaken for 'setter + seller', and a setter is not mistaken for a seller", () => {
    expect(describeAccess(bundles.seller, bundles).roles).toEqual(["seller"])
    expect(describeAccess(bundles.setter, bundles).roles).toEqual(["setter"])
  })
  it("a role that no longer exists adds nothing", () => {
    expect(permissionsOfRoles(["ghost", "analyst"], bundles).sort()).toEqual([...bundles.analyst].sort())
  })
})

describe("a person with no role is exactly their ticks (storage stays as it was)", () => {
  it("effectivePermissions with no role is the stored list, nothing else", () => {
    expect(effectivePermissions({ memberRole: "member", bundle: null, bundles, extra: ["leads.read", "team.notes"] })).toEqual(["leads.read", "team.notes"])
  })
})

describe("the menu preview uses the live menu's own rules", () => {
  const seller = bundles.seller, setter = bundles.setter
  it("setter + seller keeps BOTH Today and the Call list only when 'work the call list' is ticked", () => {
    const both = permissionsOfRoles(["setter", "seller"], bundles)
    const p = previewMenu(both)
    const on = (k: string) => p.items.find(i => i.key === k)?.on
    expect(on("today")).toBe(true)
    expect(on("call-list")).toBe(true)
    expect(on("my-numbers")).toBe(true)
    expect(p.home).toBe("Today")
  })
  it("a seller alone has Today and no Call list; a setter alone has the Call list and no Today", () => {
    expect(modulesFor(seller).map(m => m.key)).toContain("today")
    expect(modulesFor(seller).map(m => m.key)).not.toContain("call-list")
    expect(homeFor(setter)).toBe("/marketing/call-list")
  })
  it("the preview and the real menu are the same function: what is on in the preview is exactly modulesFor", () => {
    const list = permissionsOfRoles(["content", "analyst"], bundles)
    expect(previewMenu(list).items.filter(i => i.on).map(i => i.key)).toEqual(modulesFor(list).filter(m => m.built).map(m => m.key))
  })
  it("Team activity is a menu item for 'See what the team did today', even without picking leads", () => {
    const p = previewMenu(["leads.read", "team.activity"])
    expect(p.items.find(i => i.key === "activity")?.on).toBe(true)
    expect(p.items.find(i => i.key === "today")?.on).toBe(false)
  })
})

describe("warnings are questions about odd combinations", () => {
  it("payment links without the Money pages, picking without phone numbers, activity without notes", () => {
    expect(accessWarnings(["payment_links.create"]).map(w => w.fixPermission)).toEqual(["money.read"])
    expect(accessWarnings(["leads.read", "leads.pick"]).map(w => w.fixPermission)).toContain("leads.call")
    expect(accessWarnings(["team.activity"]).map(w => w.fixPermission)).toEqual(["team.notes"])
  })
  it("a sensible role has no warnings", () => {
    for (const r of ["setter", "seller", "content", "analyst"]) expect(accessWarnings(bundles[r]).map(w => w.text), r).toEqual([])
  })
})

describe("warnings for the Call list", () => {
  it("the Call list without seeing the leads is flagged", () => {
    expect(accessWarnings(["leads.worklist"]).map(w => w.fixPermission)).toContain("leads.read")
  })
})

describe("the checklist covers every permission", () => {
  it("every permission is in exactly one popup tick, except the two kept out on purpose", () => {
    const seen = ACCESS_GROUPS.flatMap(g => g.items.flatMap(i => [...i.keys]))
    for (const p of ALL_GROUPED) expect(seen.filter(k => k === p), p).toHaveLength(1)
    expect(MARKETING_PERMISSIONS.filter(p => !seen.includes(p)).sort()).toEqual(["content.manage", "team.manage"])
  })
})

describe("notes and phone numbers are enforced where the data is read", () => {
  it("'see other people's notes' alone opens the notes (the ad person who is given it reads them)", () => {
    expect(canSeeNotes(["leads.read"])).toBe(false)
    expect(canSeeNotes(["leads.read", "team.notes"])).toBe(true)
    // the tick means what it says: marking or picking leads does NOT open other people's notes by itself
    expect(canSeeNotes(["leads.mark"])).toBe(false)
    expect(canSeeNotes(["leads.pick", "leads.mark"])).toBe(false)
  })
  it("no phone numbers without 'see phone numbers': the number is removed from every row, and phone-looking form answers too", () => {
    const rows = [{ id: "1", phone: "+39 333 1" }, { id: "2", phone: null }]
    expect(canSeePhone(["leads.read"])).toBe(false)
    expect(withoutPhone(rows, ["leads.read"]).map(r => r.phone)).toEqual([null, null])
    expect(withoutPhone(rows, ["leads.read", "leads.call"]).map(r => r.phone)).toEqual(["+39 333 1", null])
    const answers = [{ name: "phone_number", values: ["+39"] }, { name: "city", values: ["Milan"] }, { name: "numero_di_telefono", values: ["1"] }]
    expect(answersWithoutPhone(answers, ["leads.read"]).map(a => a.name)).toEqual(["city"])
    // a question with any name is caught by what the answer looks like
    expect(answersWithoutPhone([{ name: "il_miglior_numero", values: ["+39 333 123 4567"] }, { name: "company", values: ["Acme 2024"] }], ["leads.read"]).map(a => a.name)).toEqual(["company"])
    expect(answersWithoutPhone(answers, ["leads.call"]).map(a => a.name)).toEqual(["phone_number", "city", "numero_di_telefono"])
  })
})
