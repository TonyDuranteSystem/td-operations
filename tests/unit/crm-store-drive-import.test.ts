import { describe, it, expect, vi } from "vitest"
vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: {} }))
import { kindForTopFolder, pickPerson, buildReport, skipReasonFor, type ImportItem } from "@/lib/crm-store/drive-import"

const item = (p: Partial<ImportItem>): ImportItem => ({
  id: "i", run_id: "r", source: "drive", source_id: "d", drive_path: [], name: "f.pdf", mime_type: "application/pdf", size_bytes: 10,
  source_md5: "m", status: "done", reason: null, store_file_id: null, sha256: null, landed_in: null, repointed: [], ...p,
})

describe("drive import — pure rules", () => {
  it("maps the numbered Drive folders by their number, and by name without one", () => {
    expect(kindForTopFolder("1. Company")).toBe("company")
    expect(kindForTopFolder("2.Contacts")).toBe("contacts")
    expect(kindForTopFolder("3 - Tax")).toBe("tax")
    expect(kindForTopFolder("4) Banking")).toBe("banking")
    expect(kindForTopFolder("5. Correspondence")).toBe("correspondence")
    expect(kindForTopFolder("Banking")).toBe("banking")
    expect(kindForTopFolder("Taxes")).toBe("tax")
    expect(kindForTopFolder("Old stuff")).toBeNull()
    expect(kindForTopFolder("7. Other")).toBeNull()
  })
  it("finds whose personal document: the row's member, a member-named sub-folder, the only member, else nobody", () => {
    const members = [{ contactId: "a", name: "Anna Bianchi" }, { contactId: "b", name: "Mario Rossi" }]
    expect(pickPerson({ rowContactId: "b", subfolder: null, members })).toBe("b")
    expect(pickPerson({ rowContactId: "zz-not-a-member", subfolder: "anna bianchi ", members })).toBe("a")
    expect(pickPerson({ rowContactId: null, subfolder: "Someone else", members })).toBeNull()
    expect(pickPerson({ rowContactId: null, subfolder: null, members: [members[1]] })).toBe("b")
    // two members with the same name can't be told apart
    expect(pickPerson({ rowContactId: null, subfolder: "Anna Bianchi", members: [...members, { contactId: "c", name: "Anna Bianchi" }] })).toBeNull()
  })
  it("never moves Google-native files or shortcuts", () => {
    expect(skipReasonFor("application/pdf")).toBeNull()
    expect(skipReasonFor(null)).toBeNull()
    expect(skipReasonFor("application/vnd.google-apps.document")).toMatch(/Google Docs/)
    expect(skipReasonFor("application/vnd.google-apps.shortcut")).toMatch(/shortcut/)
  })
  it("the report counts per top folder and holds parity only when nothing failed or is pending", () => {
    const items = [
      item({ drive_path: ["1. Company"], size_bytes: 100 }),
      item({ drive_path: ["1. Company", "Bank"], status: "merged" }),
      item({ drive_path: [], status: "skipped", reason: "Google Docs" }),
      item({ source: "storage", source_id: "storage:b/x", drive_path: [], source_md5: null, repointed: [{ id: "r1", drive_file_id: "storage:b/x", drive_link: null }] }),
      item({ drive_path: ["5. Correspondence"], repointed: [{ id: "n", drive_file_id: "store:x", drive_link: null, created: true }], reason: "Was at the top (Needs review)" }),
    ]
    const r = buildReport(items, ["x"])
    expect(r.parityOk).toBe(true)
    const co = r.folders.find((f) => f.folder === "1. Company")!
    expect(co).toMatchObject({ driveFiles: 2, moved: 1, merged: 1, movedBytes: 100, checksumChecked: 1 })
    expect(r.folders.find((f) => f.folder === "(files kept outside Drive)")?.moved).toBe(1)
    expect(r).toMatchObject({ rowsRepointed: 1, rowsCreated: 1, fromStorage: 1, needsReview: 1 })
    expect(r.skipped).toEqual([{ name: "f.pdf", where: "top of the Drive folder", reason: "Google Docs" }])
    expect(buildReport([...items, item({ status: "failed", reason: "x" })], []).parityOk).toBe(false)
    expect(buildReport([...items, item({ status: "pending" })], []).parityOk).toBe(false)
  })
})
