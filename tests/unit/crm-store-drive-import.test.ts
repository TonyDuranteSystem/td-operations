import { describe, it, expect, vi } from "vitest"
vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: {} }))
import { kindForTopFolder, pickPerson, buildReport, skipReasonFor, cleanImportName, WAITING_RE, WAITING_SENTENCE_RE, type ImportItem } from "@/lib/crm-store/drive-import"

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
  it("cleans Drive file names the store would refuse, keeping the extension", () => {
    expect(cleanImportName("Statement 01/2024.pdf")).toBe("Statement 01-2024.pdf")
    expect(cleanImportName("a\\b.pdf")).toBe("a-b.pdf")
    expect(cleanImportName("bad\u0007name.pdf")).toBe("badname.pdf")
    expect(cleanImportName("  ")).toBe("Untitled")
    const long = `${"x".repeat(300)}.pdf`
    expect(cleanImportName(long)).toHaveLength(255)
    expect(cleanImportName(long).endsWith(".pdf")).toBe(true)
    expect(cleanImportName("città è 😀.pdf")).toBe("città è 😀.pdf")
  })
  it("a claimed (working) file keeps parity open", () => {
    expect(buildReport([item({ status: "working" })], []).parityOk).toBe(false)
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
  it("the 'still opens from Drive' sentences are found and removed exactly (every wording, parentheses inside)", () => {
    const cases = [
      ["Kept once. The client could see it but it has no type — its CRM record still opens from Drive until it gets one (Needs a type).", "Kept once."],
      ["The client could see this but the new storage cannot show it as it is (needs review) — its CRM record still opens from Drive; check it (Still on Drive).", ""],
      ["Top. The client could see this but the new storage refused to show it (store: a draft is never shown) — its CRM record still opens from Drive; check it (Still on Drive). Backup ok.", "Top. Backup ok."],
    ]
    for (const [text, rest] of cases) {
      expect(WAITING_RE.test(text)).toBe(true)
      expect(text.replace(WAITING_SENTENCE_RE, "").replace(/\s+/g, " ").trim()).toBe(rest)
    }
    expect(WAITING_RE.test("Type set later: Passport.")).toBe(false)
  })
  it("a merged copy with a second record the client sees is listed apart (checked by hand, no Set type)", () => {
    const r = buildReport([item({ name: "Copy.pdf", drive_path: ["2. Contacts"], status: "merged", reason: "Kept once. The client sees this record too, but the kept copy already has its own CRM record — two records for one document: check them by hand (Second record)." })], [])
    expect(r.secondRecords).toEqual([{ name: "Copy.pdf", where: "2. Contacts" }])
    expect(r.waitingForType).toEqual([])
  })
  it("lists the files the client sees that have no type (their records still open from Drive)", () => {
    const r = buildReport([
      item({ name: "Old note.pdf", drive_path: ["Old stuff"], reason: "The client could see this but it has no type — its CRM record still opens from Drive until it gets one (Needs a type)." }),
      item({ name: "Copy.pdf", drive_path: ["2. Contacts"], status: "merged", reason: "Kept once. The client could see it but it has no type — its CRM record still opens from Drive until it gets one (Needs a type)." }),
      item({ name: "Typed.pdf" }),
    ], [])
    expect(r.waitingForType).toEqual([{ name: "Old note.pdf", where: "Old stuff", fileId: null }, { name: "Copy.pdf", where: "2. Contacts", fileId: null }])
    expect(r.parityOk).toBe(true)
  })
})
