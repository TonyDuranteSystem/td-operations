import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: {} }))

import { classifyGapFile, summarizeGap, type GapContext, type GapFile } from "@/lib/crm-store/drive-gap"

const file = (over: Partial<GapFile> = {}): GapFile => ({ id: "d1", name: "Return.pdf", mimeType: "application/pdf", path: ["3. Tax", "2025"], size: 10, ...over })
const ctx = (over: Partial<GapContext> = {}): GapContext => ({ importedIds: new Set(), crmDriveIds: new Set(), storedNameKeys: new Set(), ...over })

describe("classifyGapFile", () => {
  it("a file the move recorded is imported", () => {
    expect(classifyGapFile(file(), ctx({ importedIds: new Set(["d1"]) }))).toBe("imported")
  })
  it("a file the CRM lists but still points at Drive is in_crm_on_drive", () => {
    expect(classifyGapFile(file(), ctx({ crmDriveIds: new Set(["d1"]) }))).toBe("in_crm_on_drive")
  })
  it("a Google Doc / Sheet is google_native (a link, not a file)", () => {
    expect(classifyGapFile(file({ mimeType: "application/vnd.google-apps.spreadsheet" }), ctx())).toBe("google_native")
  })
  it("a file whose name storage already holds (any case) is same_name_stored", () => {
    expect(classifyGapFile(file({ name: "RETURN.pdf" }), ctx({ storedNameKeys: new Set(["return.pdf"]) }))).toBe("same_name_stored")
  })
  it("a file nothing matches is missing — the Fulfil Partners case (no CRM row, no import, no same name)", () => {
    expect(classifyGapFile(file({ name: "2025_FULFIL_PARTNERS_LLC_1120Proforma_Signed_for_IRS.pdf" }), ctx({ storedNameKeys: new Set(["something else.pdf"]) }))).toBe("missing")
  })
  it("imported wins over everything else", () => {
    expect(classifyGapFile(file(), ctx({ importedIds: new Set(["d1"]), crmDriveIds: new Set(["d1"]), storedNameKeys: new Set(["return.pdf"]) }))).toBe("imported")
  })
})

describe("summarizeGap", () => {
  it("counts every kind and lists only the files that need a look", () => {
    const files = [
      file({ id: "a", name: "a.pdf" }), file({ id: "b", name: "b.pdf" }), file({ id: "c", name: "c.pdf" }),
      file({ id: "d", name: "d", mimeType: "application/vnd.google-apps.document" }), file({ id: "e", name: "E.pdf" }),
    ]
    const r = summarizeGap({ accountId: "acc", company: "Acme LLC", driveFolderId: "root" }, files,
      ctx({ importedIds: new Set(["a"]), crmDriveIds: new Set(["b"]), storedNameKeys: new Set(["e.pdf"]) }))
    expect(r.total).toBe(5)
    expect(r.counts).toEqual({ imported: 1, in_crm_on_drive: 1, same_name_stored: 1, google_native: 1, missing: 1 })
    expect(r.files.map((f) => [f.id, f.kind])).toEqual([["b", "in_crm_on_drive"], ["c", "missing"], ["e", "same_name_stored"]])
    expect(r.files[1].path).toBe("3. Tax › 2025")
  })
  it("an empty folder has nothing to report", () => {
    const r = summarizeGap({ accountId: "acc", company: "Acme LLC", driveFolderId: "root" }, [], ctx())
    expect(r.total).toBe(0)
    expect(r.files).toEqual([])
  })
})
