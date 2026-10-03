import { describe, it, expect } from "vitest"
import { storeMergeBlocker } from "@/lib/crm-store/merge-guard"

describe("storeMergeBlocker", () => {
  it("lets a merge go ahead when at most one of the two has a storage", async () => {
    expect(await storeMergeBlocker("a", "b", { personOwners: async () => ({ contactIds: ["a"] }) })).toBeNull()
    expect(await storeMergeBlocker("a", "b", { personOwners: async () => ({ contactIds: [] }) })).toBeNull()
  })
  it("refuses when both have a storage, in plain words", async () => {
    const r = await storeMergeBlocker("a", "b", { personOwners: async () => ({ contactIds: ["a", "b"] }) })
    expect(r).toMatch(/cannot be merged automatically/)
    expect(r).not.toMatch(/study copy/)
  })
  it("says so when one of them was created by a Google Drive study copy", async () => {
    const r = await storeMergeBlocker("a", "b", { personOwners: async () => ({ contactIds: ["a", "b"], studyOnlyContactIds: ["b"] }) })
    expect(r).toMatch(/study copy/)
  })
  it("fails closed when the check itself fails", async () => {
    expect(await storeMergeBlocker("a", "b", { personOwners: async () => ({ error: "boom" }) })).toMatch(/please try again/)
  })
})
