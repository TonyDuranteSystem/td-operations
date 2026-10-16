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
  it("a duplicate copy (same bytes as a file a move already saw) is already decided, whatever its name or id", () => {
    expect(classifyGapFile(file({ md5: "abc" }), ctx({ seenMd5: new Set(["abc"]) }))).toBe("same_content_seen")
    expect(classifyGapFile(file({ md5: "zzz" }), ctx({ seenMd5: new Set(["abc"]) }))).toBe("missing")
    expect(classifyGapFile(file({ md5: null }), ctx({ seenMd5: new Set(["abc"]) }))).toBe("missing")
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
    expect(r.counts).toEqual({ imported: 1, same_content_seen: 0, in_crm_on_drive: 1, same_name_stored: 1, google_native: 1, missing: 1 })
    expect(r.files.map((f) => [f.id, f.kind])).toEqual([["b", "in_crm_on_drive"], ["c", "missing"], ["e", "same_name_stored"]])
    expect(r.files[1].path).toBe("3. Tax › 2025")
  })
  it("an empty folder has nothing to report", () => {
    const r = summarizeGap({ accountId: "acc", company: "Acme LLC", driveFolderId: "root" }, [], ctx())
    expect(r.total).toBe(0)
    expect(r.files).toEqual([])
  })
})

import { applyReport, gapEnabled, stillLocked, type GapState } from "@/lib/crm-store/drive-gap-run"

const base = (): GapState => ({ status: "running", startedAt: "t", updatedAt: "t", lockUntil: null, total: 3, checked: 0, queue: ["a", "b", "c"], failed: [], results: [] })

describe("the Drive check run (no button)", () => {
  it("is off unless STORE_DRIVE_GAP=1", () => {
    expect(gapEnabled({})).toBe(false)
    expect(gapEnabled({ STORE_DRIVE_GAP: "0" })).toBe(false)
    expect(gapEnabled({ STORE_DRIVE_GAP: "1" })).toBe(true)
  })
  it("keeps ONLY the files nothing else knows (missing) — not the ones the CRM, storage or a move already know", () => {
    const s = applyReport(base(), "a", "Acme LLC", { total: 3, files: [
      { name: "new.pdf", path: "3. Tax", kind: "missing", size: 5 },
      { name: "known.pdf", path: "", kind: "in_crm_on_drive", size: 5 },
      { name: "same.pdf", path: "", kind: "same_name_stored", size: 5 },
    ] })
    expect(s.queue).toEqual(["b", "c"])
    expect(s.checked).toBe(1)
    expect(s.results).toEqual([{ accountId: "a", company: "Acme LLC", driveTotal: 3, files: [{ name: "new.pdf", path: "3. Tax", size: 5 }] }])
  })
  it("a company with nothing new adds no result row; a failure is recorded and the run goes on", () => {
    let s = applyReport(base(), "a", "Acme LLC", { total: 2, files: [] })
    expect(s.results).toEqual([])
    s = applyReport(s, "b", "Beta LLC", { error: "Drive API 404" })
    expect(s.failed).toEqual([{ company: "Beta LLC", why: "Drive API 404" }])
    expect(s.queue).toEqual(["c"])
    expect(s.checked).toBe(2)
  })
  it("a run that is still holding the lock is not started twice", () => {
    expect(stillLocked({ ...base(), lockUntil: new Date(Date.now() + 60_000).toISOString() })).toBe(true)
    expect(stillLocked({ ...base(), lockUntil: new Date(Date.now() - 60_000).toISOString() })).toBe(false)
    expect(stillLocked(base())).toBe(false)
  })
})
