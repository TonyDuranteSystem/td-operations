import { describe, it, expect, vi } from "vitest"
import { personHasFilesInStorage, assertPersonFilesStillOnDrive, PersonFilesInStorageError, type PersonDriveGuardDeps } from "@/lib/crm-store/person-drive-guard"

function deps(over: Partial<PersonDriveGuardDeps> = {}): PersonDriveGuardDeps {
  return {
    liveOwner: async () => null,
    linkedAccountIds: async () => [],
    companyState: async () => "drive",
    ...over,
  }
}

describe("personHasFilesInStorage — may a Drive folder still be created or linked for this person?", () => {
  it("no: no live storage of their own and every company still on Drive", async () => {
    expect(await personHasFilesInStorage("p1", deps({ linkedAccountIds: async () => ["a1", "a2"] }))).toBe(false)
  })

  it("yes: the person has their own live storage (no company lookups needed)", async () => {
    const linkedAccountIds = vi.fn(async () => ["a1"])
    expect(await personHasFilesInStorage("p1", deps({ liveOwner: async () => "o1", linkedAccountIds }))).toBe(true)
    expect(linkedAccountIds).not.toHaveBeenCalled()
  })

  it("yes: ANY company of theirs is switched or mid-move", async () => {
    const states: Record<string, "drive" | "moving" | "store"> = { a1: "drive", a2: "moving" }
    expect(await personHasFilesInStorage("p1", deps({ linkedAccountIds: async () => ["a1", "a2"], companyState: async (id) => states[id] }))).toBe(true)
    expect(await personHasFilesInStorage("p1", deps({ linkedAccountIds: async () => ["a1"], companyState: async () => "store" }))).toBe(true)
  })

  it("a read error is never read as 'no' (the error propagates)", async () => {
    await expect(personHasFilesInStorage("p1", deps({ liveOwner: async () => { throw new Error("db down") } }))).rejects.toThrow("db down")
    await expect(personHasFilesInStorage("p1", deps({ linkedAccountIds: async () => { throw new Error("db down") } }))).rejects.toThrow("db down")
  })
})

describe("assertPersonFilesStillOnDrive", () => {
  it("passes for a Drive person and throws a plain message for a storage person", async () => {
    await expect(assertPersonFilesStillOnDrive("p1", deps())).resolves.toBeUndefined()
    await expect(assertPersonFilesStillOnDrive("p1", deps({ liveOwner: async () => "o1" }))).rejects.toBeInstanceOf(PersonFilesInStorageError)
    await expect(assertPersonFilesStillOnDrive("p1", deps({ liveOwner: async () => "o1" }))).rejects.toThrow(/Work in Storage/)
  })
})
