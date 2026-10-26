import { describe, it, expect } from "vitest"
import { folderDeleteRefusal, folderMoveRefusal, folderRenameRefusal, isFixedFolder, isLockedFolder, isYearFolderKind } from "@/lib/crm-store/folder-rules"

const base = { name: "2052", template_slug: null as string | null, parent_id: "p" as string | null }
const EMPTY = { liveFiles: 0, subFolders: 0 }

describe("an EMPTY tax-year folder can be renamed or deleted, never moved", () => {
  for (const kind of ["tax_year", "person_tax_year"]) {
    it(`${kind}: empty → rename and delete allowed`, () => {
      expect(folderRenameRefusal({ ...base, kind }, EMPTY)).toBeNull()
      expect(folderDeleteRefusal({ ...base, kind }, [], EMPTY)).toBeNull()
    })
    it(`${kind}: with a file, a sub-folder, or unread contents → refused`, () => {
      for (const c of [{ liveFiles: 1, subFolders: 0 }, { liveFiles: 0, subFolders: 1 }, {}, undefined]) {
        expect(folderRenameRefusal({ ...base, kind }, c)).toMatch(/only be renamed while it is empty/)
        expect(folderDeleteRefusal({ ...base, kind }, [], c)).toMatch(/only be deleted while it is empty/)
      }
    })
    it(`${kind}: moving stays refused`, () => {
      expect(folderMoveRefusal({ ...base, kind })).toMatch(/can't be moved/)
      expect(isLockedFolder({ ...base, kind })).toBe(true)
      expect(isFixedFolder({ ...base, kind })).toBe(false)
    })
  }
  it("a year folder made by a template (has a slug) is fixed, even when empty", () => {
    expect(folderRenameRefusal({ ...base, kind: "tax_year", template_slug: "x" }, EMPTY)).toMatch(/fixed folders/)
    expect(folderDeleteRefusal({ ...base, kind: "tax_year", template_slug: "x" }, [], EMPTY)).toMatch(/fixed folders/)
  })
})

describe("template and standard folders are never changed, empty or not", () => {
  for (const kind of ["company", "tax", "banking", "correspondence", "contacts", "personal", "person_tax", "itin", "root"]) {
    it(kind, () => {
      expect(folderRenameRefusal({ ...base, kind }, EMPTY)).toMatch(/fixed folders/)
      expect(folderDeleteRefusal({ ...base, kind }, [], EMPTY)).toMatch(/fixed folders/)
      expect(folderMoveRefusal({ ...base, kind })).toMatch(/fixed folders/)
    })
  }
  it("a storage's top folder (no parent) is fixed", () => {
    expect(folderRenameRefusal({ ...base, parent_id: null, kind: "custom" })).toMatch(/fixed folders/)
  })
})

describe("a folder staff made", () => {
  it("renames and moves freely; deletes unless it holds a standard or year folder", () => {
    expect(folderRenameRefusal({ ...base, kind: "custom" })).toBeNull()
    expect(folderMoveRefusal({ ...base, kind: "custom" })).toBeNull()
    expect(folderDeleteRefusal({ ...base, kind: "custom" }, ["custom"])).toBeNull()
    expect(folderDeleteRefusal({ ...base, kind: "custom" }, ["custom", "tax_year"])).toMatch(/contains a standard or tax-year folder/)
  })
  it("isYearFolderKind", () => {
    expect(isYearFolderKind("tax_year")).toBe(true)
    expect(isYearFolderKind("person_tax_year")).toBe(true)
    expect(isYearFolderKind("tax")).toBe(false)
    expect(isYearFolderKind(null)).toBe(false)
  })
})
