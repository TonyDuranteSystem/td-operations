import { describe, it, expect } from "vitest"
import { storeMergeBlocker, storeMergeCheck } from "@/lib/crm-store/merge-guard"
import type { CombinePlan } from "@/lib/crm-store/merge-combine"

const deps = (r: CombinePlan | { error: string }) => ({ combinePlan: async () => r })

describe("storeMergeBlocker (two storages are combined by the merge; only the cases the database cannot combine are refused)", () => {
  it("lets a merge go ahead when there is nothing to combine", async () => {
    expect(await storeMergeBlocker("a", "b", deps({ combined: false }))).toBeNull()
  })
  it("lets a merge go ahead when the two storages can be combined, and hands back the plan", async () => {
    const plan: CombinePlan = { combined: true, files_moved: 3 }
    const r = await storeMergeCheck("a", "b", deps(plan))
    expect(r.blocker).toBeNull()
    expect(r.plan).toEqual(plan)
  })
  it("refuses with the database's own plain-words reason (a study copy, files in the trash ...)", async () => {
    expect(await storeMergeBlocker("a", "b", deps({ combined: false, blocker: "The merged-away contact has 1 file(s) in the trash." }))).toMatch(/in the trash/)
    expect(await storeMergeBlocker("a", "b", deps({ combined: false, blocker: "... a Google Drive study copy ..." }))).toMatch(/study copy/)
  })
  it("fails closed when the check itself fails", async () => {
    expect(await storeMergeBlocker("a", "b", deps({ error: "boom" }))).toMatch(/please try again/)
  })
})
