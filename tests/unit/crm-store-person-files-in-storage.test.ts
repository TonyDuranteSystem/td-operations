import { describe, it, expect, vi } from "vitest"
import { personFilesInStorage } from "@/lib/crm-store/switched-drive-guard"

const live = (id: string | null) => async () => id
const state = (s: "drive" | "moving" | "store") => async () => s

describe("personFilesInStorage — does this person's file live in the new storage?", () => {
  it("yes when the person has their own live storage", async () => {
    expect(await personFilesInStorage("p1", null, { liveOwner: live("o1"), companyState: state("drive") })).toBe(true)
  })

  it("yes when the company they belong to is switched or mid-move", async () => {
    expect(await personFilesInStorage("p1", "a1", { liveOwner: live(null), companyState: state("store") })).toBe(true)
    expect(await personFilesInStorage("p1", "a1", { liveOwner: live(null), companyState: state("moving") })).toBe(true)
  })

  it("no when neither is true, and no company question is asked without a company", async () => {
    const companyState = vi.fn(state("store"))
    expect(await personFilesInStorage("p1", null, { liveOwner: live(null), companyState })).toBe(false)
    expect(companyState).not.toHaveBeenCalled()
    expect(await personFilesInStorage("p1", "a1", { liveOwner: live(null), companyState: state("drive") })).toBe(false)
  })

  it("a read error is never read as 'no' (fails closed)", async () => {
    await expect(
      personFilesInStorage("p1", "a1", { liveOwner: async () => { throw new Error("db down") }, companyState: state("drive") }),
    ).rejects.toThrow("db down")
  })
})
