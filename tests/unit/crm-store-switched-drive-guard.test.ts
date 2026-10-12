import { describe, it, expect, vi } from "vitest"
import { assertTargetsNotSwitched, runAsStoreBackup, stateFrom, SwitchedCompanyDriveWriteError } from "@/lib/crm-store/switched-drive-guard"

// A tiny Drive tree: root > state > companyA > sub > file ; root > state > companyB
const parents: Record<string, string[]> = {
  file: ["sub"], sub: ["companyA"], companyA: ["state"], companyB: ["state"], state: ["root"], root: [],
}
const deps = (locked: string[]) => ({
  lockedFolderIds: async () => new Set(locked),
  parentsOf: vi.fn(async (id: string) => parents[id] ?? []),
})

describe("stateFrom — one company, three states", () => {
  it("a live storage means store, even with an open move", () => {
    expect(stateFrom({ hasLiveOwner: true, openMoveRun: true })).toBe("store")
    expect(stateFrom({ hasLiveOwner: false, hasLiveFormationOwner: true, openMoveRun: false })).toBe("store")
  })
  it("an open move without a live storage is moving; nothing at all is drive (a study copy is not a state)", () => {
    expect(stateFrom({ hasLiveOwner: false, openMoveRun: true })).toBe("moving")
    expect(stateFrom({ hasLiveOwner: false, openMoveRun: false })).toBe("drive")
  })
})

describe("assertTargetsNotSwitched — Drive writes for a switched company are refused", () => {
  it("does nothing, and asks Drive nothing, while no company is switched", async () => {
    const d = deps([])
    await expect(assertTargetsNotSwitched(["file"], d)).resolves.toBeUndefined()
    expect(d.parentsOf).not.toHaveBeenCalled()
  })

  it("refuses a write straight into a switched company's folder", async () => {
    await expect(assertTargetsNotSwitched(["companyA"], deps(["companyA"]))).rejects.toBeInstanceOf(SwitchedCompanyDriveWriteError)
  })

  it("refuses a write anywhere BELOW a switched company's folder (a file, a sub-folder)", async () => {
    await expect(assertTargetsNotSwitched(["file"], deps(["companyA"]))).rejects.toThrow(/new CRM storage/)
    await expect(assertTargetsNotSwitched(["sub"], deps(["companyA"]))).rejects.toThrow(/new CRM storage/)
  })

  it("lets a sibling company that is still on Drive keep working", async () => {
    await expect(assertTargetsNotSwitched(["companyB"], deps(["companyA"]))).resolves.toBeUndefined()
  })

  it("checks every id of a move (file AND its new parent)", async () => {
    await expect(assertTargetsNotSwitched(["companyB", "sub"], deps(["companyA"]))).rejects.toBeInstanceOf(SwitchedCompanyDriveWriteError)
  })

  it("ignores empty ids and an empty list", async () => {
    await expect(assertTargetsNotSwitched(["", ""], deps(["companyA"]))).resolves.toBeUndefined()
    await expect(assertTargetsNotSwitched([], deps(["companyA"]))).resolves.toBeUndefined()
  })

  it("fails CLOSED: an unreadable lookup refuses the write", async () => {
    const bad = { lockedFolderIds: async () => { throw new Error("db down") }, parentsOf: async () => [] }
    await expect(assertTargetsNotSwitched(["companyB"], bad)).rejects.toThrow("db down")
  })

  it("fails CLOSED when Drive cannot say where a folder sits (a switched company's file must not slip through)", async () => {
    const d = { lockedFolderIds: async () => new Set(["companyA"]), parentsOf: async () => { throw new Error("drive 500") } }
    await expect(assertTargetsNotSwitched(["file"], d)).rejects.toThrow("drive 500")
  })

  it("stops on a loop in the parents instead of hanging", async () => {
    const loop = { lockedFolderIds: async () => new Set(["zzz"]), parentsOf: async (id: string) => (id === "a" ? ["b"] : ["a"]) }
    await expect(assertTargetsNotSwitched(["a"], loop)).resolves.toBeUndefined()
  })

  it("fails CLOSED when a folder sits deeper than the proof limit (never lets a very deep path through)", async () => {
    const deep = { lockedFolderIds: async () => new Set(["zzz"]), parentsOf: async (id: string) => [id + "x"] }
    await expect(assertTargetsNotSwitched(["a"], deep)).rejects.toThrow(/nested too deeply/)
  })

  it("the one-way backup is the only way through, and only inside its own scope", async () => {
    await expect(runAsStoreBackup(() => assertTargetsNotSwitched(["file"], deps(["companyA"])))).resolves.toBeUndefined()
    await expect(assertTargetsNotSwitched(["file"], deps(["companyA"]))).rejects.toBeInstanceOf(SwitchedCompanyDriveWriteError)
  })
})
