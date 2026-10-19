import { describe, it, expect, vi } from "vitest"
import { formDestinationForAccount, type FormDestinationDeps } from "@/lib/crm-store/form-destination"

// Stop Drive S1d: where a company's form package is filed. Nothing here may reach Drive: the dependencies are fakes.
const mk = (marker: string | null, legacy: Awaited<ReturnType<FormDestinationDeps["legacy"]>>, state: "drive" | "moving" | "store" = "drive") => {
  const alarm = vi.fn(async (p: { reason: string }) => `sentence:${p.reason}`)
  const deps = { storageMarker: vi.fn(async () => marker), state: vi.fn(async () => state), legacy: vi.fn(async () => legacy), alarm } as unknown as FormDestinationDeps
  return { deps, alarm }
}
const refused = { allowed: false as const, reason: "archived" as const, sentence: "x" }

describe("formDestinationForAccount", () => {
  it("a company in storage -> its storage marker, no legacy lookup, no alarm", async () => {
    const m = mk("account-storage:abc", refused)
    expect(await formDestinationForAccount("a1", "banking", m.deps)).toEqual({ ok: true, folderId: "account-storage:abc", via: "storage" })
    expect(m.deps.legacy).not.toHaveBeenCalled(); expect(m.alarm).not.toHaveBeenCalled()
  })
  it("a company with storage but NO Drive folder (every new client) still gets a destination", async () => {
    const m = mk("account-storage:new", { allowed: false, reason: "no_folder", sentence: "x" })
    expect((await formDestinationForAccount("a2", "banking", m.deps)).ok).toBe(true)
  })
  it("a company left on Drive -> its own folder", async () => {
    const m = mk(null, { allowed: true, folderId: "F-rebis" })
    expect(await formDestinationForAccount("a3", "closure", m.deps)).toEqual({ ok: true, folderId: "F-rebis", via: "legacy-drive" })
    expect(m.alarm).not.toHaveBeenCalled()
  })
  it.each([["archived"], ["no_folder"]] as const)("no destination (%s): the plain sentence comes back and ONE alarm is raised", async (reason) => {
    const m = mk(null, { allowed: false, reason, sentence: "x" })
    expect(await formDestinationForAccount("a4", "banking", m.deps)).toEqual({ ok: false, reason, sentence: `sentence:${reason}` })
    expect(m.alarm).toHaveBeenCalledTimes(1)
  })
  it("no account -> refused with an alarm", async () => {
    const m = mk(null, refused)
    expect(await formDestinationForAccount(null, "banking", m.deps)).toMatchObject({ ok: false, reason: "no_company" })
    expect(m.alarm).toHaveBeenCalledTimes(1)
  })
  it("a company mid-move (the REAL case: the storage lookup would throw 'being moved'): a plain 'try again' — no lookup, no alarm", async () => {
    const m = mk("account-storage:abc", refused, "moving")
    const r = await formDestinationForAccount("a5", "banking", m.deps)
    expect(r).toMatchObject({ ok: false, reason: "moving" })
    expect(m.deps.storageMarker).not.toHaveBeenCalled(); expect(m.alarm).not.toHaveBeenCalled()
  })
})
