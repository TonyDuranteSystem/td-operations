import { describe, it, expect } from "vitest"
import { businessOwnerIdOf } from "@/lib/crm-store/handoff-area"

/** Which storage owner the "Save in Business" choice opens (lib/crm-store/handoff-area.ts; dev job fb49265a, 2026-11-10). */
describe("businessOwnerIdOf", () => {
  it("finds the Business owner in the navigation", () => {
    const groups = [
      { key: "clients", owners: [{ id: "c1" }] },
      { key: "business", owners: [{ id: "biz-1" }, { id: "biz-2" }] },
      { key: "my_files", owners: [{ id: "mine" }] },
    ]
    expect(businessOwnerIdOf(groups)).toBe("biz-1")
  })
  it("is null when this login is not offered Business", () => {
    expect(businessOwnerIdOf([{ key: "clients", owners: [{ id: "c1" }] }])).toBeNull()
  })
  it("is null for a Business group with no owner", () => {
    expect(businessOwnerIdOf([{ key: "business", owners: [] }])).toBeNull()
  })
  it("is null for missing or odd answers (never throws)", () => {
    expect(businessOwnerIdOf(null)).toBeNull()
    expect(businessOwnerIdOf(undefined)).toBeNull()
    expect(businessOwnerIdOf({} as never)).toBeNull()
    expect(businessOwnerIdOf([null as never, { key: "business", owners: null as never }])).toBeNull()
    expect(businessOwnerIdOf([{ key: "business", owners: [{ id: "" }] }])).toBeNull()
  })
})
