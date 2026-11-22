import { describe, it, expect, vi } from "vitest"
import { summarizePlan, getCombinePlan, type CombinePlan } from "@/lib/crm-store/merge-combine"

describe("summarizePlan (the combine plan in plain English)", () => {
  it("says nothing when the storages are not combined", () => {
    expect(summarizePlan(null)).toBeNull()
    expect(summarizePlan({ combined: false })).toBeNull()
    expect(summarizePlan({ combined: false, blocker: "x" })).toBeNull()
  })
  it("counts the files and says nothing is overwritten or deleted", () => {
    const s = summarizePlan({ combined: true, files_moved: 1 })
    expect(s?.headline).toMatch(/1 file from the removed contact moves into the kept contact's folder/)
    expect(s?.headline).toMatch(/Nothing is overwritten or deleted/)
    expect(s?.lines).toEqual([])
  })
  it("names joined folders, a branch that moves over, and every rename (identical content is said, never dropped)", () => {
    const plan: CombinePlan = {
      combined: true, files_moved: 6,
      folders_merged: [{ folder: "/" }, { folder: "/Tax" }, { folder: "/Personal documents" }].slice(1),
      folders_moved: [{ folder: "/OnlyRemoved", new_name: "OnlyRemoved", files: 2 }, { folder: "/Same", new_name: "Same (2)", files: 1 }],
      files_renamed: [
        { file_id: "1", folder: "/Tax", name: "a.pdf", new_name: "a (2).pdf", same_content: false },
        { file_id: "2", folder: "/", name: "passport.jpeg", new_name: "passport (2).jpeg", same_content: true },
      ],
    }
    const s = summarizePlan(plan)
    expect(s?.headline).toMatch(/6 files/)
    expect(s?.headline).toMatch(/2 files are renamed/)
    expect(s?.lines.join("\n")).toMatch(/Tax, Personal documents/)
    expect(s?.lines.join("\n")).toMatch(/"OnlyRemoved" exists only on the removed contact: it moves over as it is \(2 files\)/)
    expect(s?.lines.join("\n")).toMatch(/renamed "Same \(2\)"/)
    expect(s?.lines.join("\n")).toMatch(/"a.pdf" in Tax already exists on the kept contact: both are kept, the incoming one becomes "a \(2\).pdf"\./)
    expect(s?.lines.join("\n")).toMatch(/"passport.jpeg" in the top folder .* "passport \(2\).jpeg" \(same content/)
  })
})

describe("getCombinePlan", () => {
  it("hands the lookup the removed and the kept contact, in that order", async () => {
    const lookup = vi.fn(async () => ({ combined: false }) as CombinePlan)
    await getCombinePlan("loser", "winner", lookup)
    expect(lookup).toHaveBeenCalledWith("loser", "winner")
  })
})
