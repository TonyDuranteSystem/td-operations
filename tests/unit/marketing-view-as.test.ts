import { describe, it, expect } from "vitest"
import { parseViewAs, serializeViewAs, viewAsLabel, viewAsOptions, viewAsPermissions } from "@/lib/marketing/view-as"
import { MARKETING_PERMISSIONS } from "@/lib/marketing/permissions"

const T = "11111111-1111-1111-1111-111111111111"
const bundles = { setter: ["leads.read", "leads.mark"], content: ["chat", "bogus.perm"] }

describe("view-as cookie", () => {
  it("round-trips the owner and a bundle", () => {
    expect(parseViewAs(serializeViewAs({ teamId: T, as: "owner" }))).toEqual({ teamId: T, as: "owner" })
    expect(parseViewAs(serializeViewAs({ teamId: T, as: { bundle: "setter" } }))).toEqual({ teamId: T, as: { bundle: "setter" } })
  })
  it("anything that does not look exactly right is nothing", () => {
    for (const bad of [null, undefined, "", "owner", "x:owner", `${T}:`, `${T}:admin`, `${T}:bundle=`, `${T}:bundle=../etc`, `${T}:bundle=a;b`, `${T}owner`]) expect(parseViewAs(bad as string)).toBeNull()
  })
})

describe("what he sees", () => {
  it("the owner has every permission; a bundle gives its own, cleaned; a missing bundle gives nothing", () => {
    expect(viewAsPermissions("owner", bundles)).toEqual([...MARKETING_PERMISSIONS])
    expect(viewAsPermissions({ bundle: "setter" }, bundles)).toEqual(["leads.read", "leads.mark"])
    expect(viewAsPermissions({ bundle: "content" }, bundles)).toEqual(["chat"])
    expect(viewAsPermissions({ bundle: "gone" }, bundles)).toEqual([])
  })
  it("the choices come from the bundles setting, owner first", () => {
    const o = viewAsOptions(bundles, k => k.toUpperCase())
    expect(o.map(x => x.label)).toEqual(["Team owner (every screen)", "SETTER", "CONTENT"])
    expect(o[1].value).toEqual({ bundle: "setter" })
  })
  it("the banner words", () => {
    expect(viewAsLabel("owner", k => k)).toBe("the team owner")
    expect(viewAsLabel({ bundle: "setter" }, k => `Role ${k}`)).toBe("Role setter")
  })
})
