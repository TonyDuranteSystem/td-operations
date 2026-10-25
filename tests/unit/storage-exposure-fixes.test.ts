import { describe, it, expect } from "vitest"
import { dropDocsClientCannotSee, correspondenceOwnerMatches, correspondenceTypeAllowed, type ClientStoreDeps } from "@/lib/portal/client-store-docs"
import { ownerChangeHidePlan, OWNER_CHANGE_HIDDEN_NOTE } from "@/lib/crm-store/owner-change-hide"
import { isLockedFolder, folderDeleteRefusal, parseYearFolderName, MIN_PERIOD_YEAR, MAX_PERIOD_YEAR } from "@/lib/crm-store/folder-rules"
import { undoShowPlan } from "@/lib/crm-store/understand/move-owner"

const store = (id: string) => `store:00000000-0000-4000-8000-${id.padStart(12, "0")}`

function deps(over: Partial<ClientStoreDeps> = {}): ClientStoreDeps {
  return {
    serviceTypes: async (ids) => new Map(ids.map((i) => [i, "Company Formation"])),
    closed: async () => new Set(),
    personalOutsidePerson: async () => new Set(),
    ...over,
  }
}

describe("tax page / flow page / legacy fallback list only what the client may see", () => {
  it("a hidden draft is never listed (no flag, no client-safe stage) — store or Drive row", async () => {
    const rows = [
      { id: "a", drive_file_id: store("1"), portal_visible: false, category: 3, contact_id: null },
      { id: "b", drive_file_id: "drive-file-1", portal_visible: false, category: 3, contact_id: null },
      { id: "c", drive_file_id: store("2"), portal_visible: true, category: 3, contact_id: null },
    ]
    const out = await dropDocsClientCannotSee(rows, "me", deps())
    expect(out.map((r) => r.id)).toEqual(["c"])
  })

  it("a document at a client-safe flow stage is listed even with the flag off", async () => {
    const rows = [{ id: "a", drive_file_id: "d1", portal_visible: false, service_delivery_id: "sd1", flow_stage: "Filed with State" }]
    expect((await dropDocsClientCannotSee(rows, "me", deps())).length).toBe(1)
    const internal = [{ id: "a", drive_file_id: "d1", portal_visible: false, service_delivery_id: "sd1", flow_stage: "Draft" }]
    expect((await dropDocsClientCannotSee(internal, "me", deps())).length).toBe(0)
  })

  it("another member's personal document is dropped, the viewer's own stays", async () => {
    const rows = [
      { id: "p1", drive_file_id: "d1", portal_visible: true, category: 2, contact_id: "other" },
      { id: "p2", drive_file_id: "d2", portal_visible: true, category: 2, contact_id: "me" },
    ]
    expect((await dropDocsClientCannotSee(rows, "me", deps())).map((r) => r.id)).toEqual(["p2"])
  })

  it("a closed store file (no type / staff-only) is dropped even when flagged visible", async () => {
    const rows = [{ id: "a", drive_file_id: store("1"), portal_visible: true }, { id: "b", drive_file_id: store("2"), portal_visible: true }]
    const out = await dropDocsClientCannotSee(rows, "me", deps({ closed: async () => new Set([store("1")]) }))
    expect(out.map((r) => r.id)).toEqual(["b"])
  })
})

describe("correspondence file", () => {
  it("serves only while the file's owner is still the item's company or person", () => {
    expect(correspondenceOwnerMatches({ account_id: "A", contact_id: null }, { account_id: "A", contact_id: null })).toBe(true)
    expect(correspondenceOwnerMatches({ account_id: "A", contact_id: "C" }, { account_id: null, contact_id: "C" })).toBe(true)
    expect(correspondenceOwnerMatches({ account_id: "A", contact_id: "C" }, { account_id: "B", contact_id: null })).toBe(false)
    expect(correspondenceOwnerMatches({ account_id: "A", contact_id: null }, null)).toBe(false)
    expect(correspondenceOwnerMatches({ account_id: null, contact_id: null }, { account_id: null, contact_id: null })).toBe(false)
  })
  it("untyped is normal; a staff-only type or a personal paper outside a person is refused", () => {
    expect(correspondenceTypeAllowed(null, true, false)).toBe(true)
    expect(correspondenceTypeAllowed("letter", false, false)).toBe(true)
    expect(correspondenceTypeAllowed("formation_summary", true, false)).toBe(false)
    expect(correspondenceTypeAllowed(null, false, true)).toBe(false)
  })
})

describe("a file that changes owner is hidden from the client", () => {
  it("visible by flag, by flow stage or published -> hidden + stage cleared + note", () => {
    const row = { id: "r", portal_visible: true, flow_stage: "Filed with State", client_notified_at: "2026-01-01" }
    const plan = ownerChangeHidePlan(false, [row])
    expect(plan.wasVisible).toBe(true)
    expect(plan.patch).toEqual({ portal_visible: false, flow_stage: null, client_notified_at: null })
    expect(plan.note).toBe(OWNER_CHANGE_HIDDEN_NOTE)
    expect(ownerChangeHidePlan(true, []).wasVisible).toBe(true)
    expect(ownerChangeHidePlan(false, [{ id: "r", portal_visible: false, flow_stage: "Filed with State", client_notified_at: null }]).wasVisible).toBe(true)
  })
  it("an already-hidden file needs no note", () => {
    const plan = ownerChangeHidePlan(false, [{ id: "r", portal_visible: false, flow_stage: null, client_notified_at: null }])
    expect(plan.wasVisible).toBe(false)
    expect(plan.note).toBeNull()
  })
  it("undo tries to show the file again only if the client saw it before", () => {
    expect(undoShowPlan(true, [])).toBe(true)
    expect(undoShowPlan(false, [{ portal_visible: true }])).toBe(true)
    expect(undoShowPlan(false, [{ portal_visible: false }])).toBe(false)
  })
})

describe("folder delete and year folders", () => {
  const base = { name: "X", template_slug: null as string | null, parent_id: "p" as string | null }
  it("a tax-year folder is locked and refused with a plain message", () => {
    expect(isLockedFolder({ ...base, kind: "tax_year" })).toBe(true)
    expect(isLockedFolder({ ...base, kind: "person_tax_year" })).toBe(true)
    expect(isLockedFolder({ ...base, kind: "custom" })).toBe(false)
    expect(isLockedFolder({ template_slug: null, parent_id: "p" })).toBe(false)
    expect(folderDeleteRefusal({ ...base, kind: "tax_year" }, [])).toBe("A tax-year folder cannot be deleted from here.")
    expect(folderDeleteRefusal({ ...base, kind: "person_tax_year" }, [])).toBe("A tax-year folder cannot be deleted from here.")
  })
  it("a folder staff made is deletable, unless it contains a standard folder", () => {
    expect(folderDeleteRefusal({ ...base, kind: "custom" }, ["custom", "custom"])).toBeNull()
    expect(folderDeleteRefusal({ ...base, kind: "custom" }, ["custom", "tax_year"])).toMatch(/contains a standard or tax-year folder/)
    expect(folderDeleteRefusal({ ...base, kind: "tax" }, [])).toMatch(/standard folder/)
    expect(folderDeleteRefusal({ ...base, template_slug: "company_standard", kind: "custom" }, [])).toMatch(/fixed folders/)
    expect(folderDeleteRefusal({ ...base, parent_id: null, kind: "custom" }, [])).toMatch(/fixed folders/)
  })
  it("a year folder is only accepted inside the store's range", () => {
    expect(parseYearFolderName("2025")).toBe(2025)
    expect(parseYearFolderName(" 1990 ")).toBe(MIN_PERIOD_YEAR)
    expect(parseYearFolderName("2100")).toBe(MAX_PERIOD_YEAR)
    expect(parseYearFolderName("1985")).toBeNull()
    expect(parseYearFolderName("2101")).toBeNull()
    expect(parseYearFolderName("25")).toBeNull()
    expect(parseYearFolderName("2025a")).toBeNull()
  })
})
