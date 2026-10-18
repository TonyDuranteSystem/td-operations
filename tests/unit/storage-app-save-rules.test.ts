import { describe, it, expect } from "vitest"
import { checkDestination, checkNewFile, cleanFileName, isJunkName, isItemKey, saveCallerKey, writeLimitBytes, isClientSaveOwner, MAX_SAVE_BYTES } from "@/lib/storage-app/save-rules"

describe("where a Mac may save a new file (step A: Business and My files only)", () => {
  const ok = { ownerKind: "business", folderKind: "custom", inStaffShare: false, folderTrashed: false }
  it("allows a normal folder of Business and of My files", () => {
    expect(checkDestination(ok).ok).toBe(true)
    expect(checkDestination({ ...ok, ownerKind: "private" }).ok).toBe(true)
  })
  it("never a top folder of any storage", () => {
    for (const k of ["root", "business_root", "private_root"]) expect(checkDestination({ ...ok, folderKind: k }).ok).toBe(false)
  })
  it("never '2. Contacts', 'Shared with staff', or a trashed folder", () => {
    expect(checkDestination({ ...ok, folderKind: "contacts" }).ok).toBe(false)
    expect(checkDestination({ ...ok, inStaffShare: true }).ok).toBe(false)
    expect(checkDestination({ ...ok, folderTrashed: true }).ok).toBe(false)
  })
  it("a company's or person's own folders: only the team-made ones and Correspondence (step B slice 1)", () => {
    for (const owner of ["company", "person"]) {
      for (const k of ["custom", "correspondence"]) expect(checkDestination({ ...ok, ownerKind: owner, folderKind: k }).ok).toBe(true)
      for (const k of ["banking", "tax", "tax_year", "company", "itin", "personal", "person_tax", "person_tax_year", "contacts", "root"]) expect(checkDestination({ ...ok, ownerKind: owner, folderKind: k }).ok).toBe(false)
    }
  })
  it("still not companies being formed or unknown storages", () => {
    for (const k of ["formation", null, undefined, "something"]) expect(checkDestination({ ...ok, ownerKind: k as string }).ok).toBe(false)
  })
  it("a client folder is still refused when trashed, in Shared with staff, or a top folder", () => {
    const c = { ownerKind: "company", folderKind: "custom", inStaffShare: false, folderTrashed: false }
    expect(checkDestination({ ...c, folderTrashed: true }).ok).toBe(false)
    expect(checkDestination({ ...c, inStaffShare: true }).ok).toBe(false)
    expect(checkDestination({ ...c, folderKind: "root" }).ok).toBe(false)
  })
})

describe("what a Mac may save", () => {
  it("junk and temporary names are never saved", () => {
    for (const n of [".DS_Store", "._photo.jpg", "~$report.docx", "x.crdownload", "y.download", "z.part", "a.tmp", "o.opdownload", "doc.sb-1a2b3c4d-AbCd9z", "(A Document Being Saved By Preview)", "Thumbs.db", ".~lock.a.odt#"]) expect(isJunkName(n)).toBe(true)
    for (const n of ["report.pdf", "Download notes.txt", "partial agreement.docx", "tmp.pdf", "Q3.sb-final.pdf", "doc.sb-1234-abcd.pdf", "My Downloads list.xlsx", "part list.docx"]) expect(isJunkName(n)).toBe(false)
  })
  it("names are cleaned and bounded", () => {
    expect(cleanFileName("  a\u0000b.pdf ")).toBe("ab.pdf")
    expect(cleanFileName("")).toBeNull(); expect(cleanFileName("..")).toBeNull(); expect(cleanFileName(5)).toBeNull()
    expect(cleanFileName("x".repeat(256))).toBeNull()
  })
  it("size is required and capped at 150 MB", () => {
    expect(checkNewFile({ name: "a.pdf", size: 10 }).ok).toBe(true)
    expect(checkNewFile({ name: "a.pdf", size: 0 }).ok).toBe(true)
    expect(checkNewFile({ name: "a.pdf", size: MAX_SAVE_BYTES + 1 })).toMatchObject({ ok: false, code: "too_big" })
    expect(checkNewFile({ name: "a.pdf", size: -1 }).ok).toBe(false)
    expect(checkNewFile({ name: "a.pdf", size: "5" }).ok).toBe(false)
    expect(checkNewFile({ name: ".DS_Store", size: 5 })).toMatchObject({ ok: false, code: "ignored" })
  })
})

describe("the key that makes saving safe to retry", () => {
  it("accepts only a uuid and builds the key from the Mac + its own id, never folder or name", () => {
    expect(isItemKey("3f1a2b3c-4d5e-4f60-8a7b-1c2d3e4f5a6b")).toBe(true)
    expect(isItemKey("nope")).toBe(false); expect(isItemKey(undefined)).toBe(false)
    expect(saveCallerKey("dev1", "3F1A2B3C-4D5E-4F60-8A7B-1C2D3E4F5A6B")).toBe("storage-app:dev1:3f1a2b3c-4d5e-4f60-8a7b-1c2d3e4f5a6b")
  })
  it("the upload limit defaults to 500 MB per hour and can be set", () => {
    expect(writeLimitBytes(undefined)).toBe(500 * 1024 * 1024)
    expect(writeLimitBytes("2")).toBe(2 * 1024 * 1024)
    expect(writeLimitBytes("0")).toBe(500 * 1024 * 1024)
  })
})

describe("which storages count as client storages for a Mac save", () => {
  it("company and person only (slice 1)", () => {
    expect(isClientSaveOwner("company")).toBe(true)
    expect(isClientSaveOwner("person")).toBe(true)
    for (const k of ["formation", "business", "private", null, undefined, ""]) expect(isClientSaveOwner(k as string)).toBe(false)
  })
})
