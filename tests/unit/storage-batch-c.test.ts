import { describe, it, expect, vi, beforeEach } from "vitest"

const state: { rows: Array<{ id: string; drive_folder_id: string | null }>; error: { message: string } | null; calls: number } = { rows: [], error: null, calls: 0 }
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        in: async (_c: string, ids: string[]) => {
          state.calls++
          return { data: state.error ? null : state.rows.filter(r => ids.includes(r.id)), error: state.error }
        },
      }),
    }),
  },
}))

import { splitByDriveFolder, accountsWithoutDriveFolder } from "@/lib/archive/skip-no-drive-folder"
import { driveLinkLabel, moveWithoutDriveFolderAnswer, esignFilingLine, DRIVE_ARCHIVE_WARNING, PERSON_IN_STORAGE_MESSAGE } from "@/lib/crm-store/drive-archive-notes"

beforeEach(() => { state.rows = []; state.error = null; state.calls = 0 })

describe("splitByDriveFolder", () => {
  it("separates rows whose account has no Drive folder, keeps rows without an account", () => {
    const rows = [{ id: "1", account_id: "a" }, { id: "2", account_id: "b" }, { id: "3", account_id: null }]
    const { keep, skipped } = splitByDriveFolder(rows, new Set(["b"]))
    expect(keep.map(r => r.id)).toEqual(["1", "3"])
    expect(skipped.map(r => r.id)).toEqual(["2"])
  })
  it("skips nothing for an empty set / empty list", () => {
    expect(splitByDriveFolder([{ account_id: "a" }], new Set()).skipped).toEqual([])
    expect(splitByDriveFolder([], new Set(["a"]))).toEqual({ keep: [], skipped: [] })
  })
})

describe("accountsWithoutDriveFolder", () => {
  it("returns only existing accounts with no folder; unknown accounts are not skipped", async () => {
    state.rows = [{ id: "a", drive_folder_id: "F" }, { id: "b", drive_folder_id: null }, { id: "c", drive_folder_id: "" }]
    const r = await accountsWithoutDriveFolder(["a", "b", "c", "ghost", "b"])
    expect([...r].sort()).toEqual(["b", "c"])
  })
  it("makes no database call for an empty list", async () => {
    expect((await accountsWithoutDriveFolder([])).size).toBe(0)
    expect(state.calls).toBe(0)
  })
  it("reads in batches of 100", async () => {
    await accountsWithoutDriveFolder(Array.from({ length: 250 }, (_, i) => `x${i}`))
    expect(state.calls).toBe(3)
  })
  it("throws on a read error (never read as 'no folder')", async () => {
    state.error = { message: "boom" }
    await expect(accountsWithoutDriveFolder(["a"])).rejects.toThrow(/boom/)
  })
})

describe("drive-archive-notes", () => {
  it("labels the contact Drive link as the old archive only when the person is in storage", () => {
    expect(driveLinkLabel(true).text).toBe("Old Drive archive")
    expect(driveLinkLabel(false).text).toBe("Open in Drive")
  })
  it("move without a Drive folder: 400 for a Drive company, truthful 409 for storage / moving", () => {
    expect(moveWithoutDriveFolderAnswer("drive").status).toBe(400)
    for (const s of ["store", "moving"] as const) {
      const a = moveWithoutDriveFolderAnswer(s)
      expect(a.status).toBe(409)
      expect(a.error).not.toMatch(/no Drive folder linked/)
      expect(a.error).toMatch(/CRM storage/)
    }
  })
  it("the e-sign email never claims 'filed' when filing failed", () => {
    expect(esignFilingLine({ hasAccount: true, filingNeeded: true, filed: true })).toMatch(/is filed in the client's documents/)
    const bad = esignFilingLine({ hasAccount: true, filingNeeded: true, filed: false })
    expect(bad).toMatch(/could NOT be filed/)
    expect(bad).not.toMatch(/is filed/)
    expect(esignFilingLine({ hasAccount: false, filingNeeded: false, filed: true })).not.toMatch(/filed in the client/)
  })
  it("exports the warning texts", () => {
    expect(DRIVE_ARCHIVE_WARNING).toMatch(/ARCHIVE/)
    expect(PERSON_IN_STORAGE_MESSAGE).toMatch(/CRM storage/)
  })
})
