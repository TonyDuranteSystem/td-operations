import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: {} }))

import { classifyCatchUpRow, sharedDriveIds, kindFromSuggestedFolder, yearFromFileName, faxReceiptRule, type CatchUpRow } from "@/lib/crm-store/catch-up"

const COPY = "2026-10-09T14:33:00.000Z"
const row = (o: Partial<CatchUpRow> = {}): CatchUpRow => ({
  id: "r1", file_name: "Form 8879 signed.pdf", drive_file_id: "1a5DcSLLHWCoAbCdEfGh123", document_type_name: "Form 8879", created_at: "2026-10-13T18:39:00.000Z",
  portal_visible: true, service_delivery_id: null, flow_stage: null, contact_id: null, account_id: "acc", status: "classified", ...o,
})

describe("classifyCatchUpRow — surgical: only what the copy missed", () => {
  it("takes a Drive record made after the approved copy", () => {
    expect(classifyCatchUpRow(row(), COPY)).toEqual({ eligible: true })
  })
  it("leaves a record older than the copy", () => {
    const v = classifyCatchUpRow(row({ created_at: "2026-10-01T00:00:00.000Z" }), COPY)
    expect(v.eligible).toBe(false)
    expect((v as { reason: string }).reason).toMatch(/older than the approved copy/)
  })
  it("leaves a record exactly at the copy start (not strictly newer)", () => {
    expect(classifyCatchUpRow(row({ created_at: COPY }), COPY).eligible).toBe(false)
  })
  it("leaves records already in the storage (new or old pointer)", () => {
    expect(classifyCatchUpRow(row({ drive_file_id: "store:abc" }), COPY).eligible).toBe(false)
    expect(classifyCatchUpRow(row({ drive_file_id: "storage:crm-uploads/x.pdf" }), COPY).eligible).toBe(false)
  })
  it("leaves archived records", () => {
    expect(classifyCatchUpRow(row({ status: "archived" }), COPY).eligible).toBe(false)
  })
  it("leaves internal pointers that are not Drive files", () => {
    expect(classifyCatchUpRow(row({ drive_file_id: "ss4-live:123456789012345" }), COPY).eligible).toBe(false)
    expect(classifyCatchUpRow(row({ drive_file_id: "short" }), COPY).eligible).toBe(false)
  })
  it("leaves workspace documents (service case or stage)", () => {
    expect(classifyCatchUpRow(row({ service_delivery_id: "sd1" }), COPY).eligible).toBe(false)
    expect(classifyCatchUpRow(row({ flow_stage: "EIN Received" }), COPY).eligible).toBe(false)
  })
  it("leaves a person's personal record", () => {
    expect(classifyCatchUpRow(row({ account_id: null, contact_id: "c1" }), COPY).eligible).toBe(false)
  })
  it("leaves everything when the company has no approved copy to compare with", () => {
    const v = classifyCatchUpRow(row(), null)
    expect(v.eligible).toBe(false)
    expect((v as { reason: string }).reason).toMatch(/no approved copy/)
  })
  it("every refusal carries a reason (nothing is silent)", () => {
    const bad = [row({ status: "archived" }), row({ drive_file_id: "x:y" }), row({ flow_stage: "s" }), row({ created_at: "2020-01-01T00:00:00Z" })]
    for (const r of bad) {
      const v = classifyCatchUpRow(r, COPY)
      expect(v.eligible).toBe(false)
      expect(((v as { reason: string }).reason ?? "").length).toBeGreaterThan(5)
    }
  })
})

describe("sharedDriveIds — a Drive file several records point at is left alone", () => {
  const e = (id: string, d: string) => ({ id, driveFileId: d })
  it("flags a file two company records share", () => {
    const shared = sharedDriveIds([e("a", "D1"), e("b", "D2")], [{ id: "a", drive_file_id: "D1" }, { id: "x", drive_file_id: "D1" }, { id: "b", drive_file_id: "D2" }], [])
    expect(Array.from(shared)).toEqual(["D1"])
  })
  it("flags a file that another company's or a person's record also points at", () => {
    const shared = sharedDriveIds([e("a", "D1")], [{ id: "a", drive_file_id: "D1" }], [{ id: "p", drive_file_id: "D1" }])
    expect(shared.has("D1")).toBe(true)
  })
  it("a file only this record points at is not shared", () => {
    expect(sharedDriveIds([e("a", "D1")], [{ id: "a", drive_file_id: "D1" }], []).size).toBe(0)
  })
})

describe("placement helpers", () => {
  it("a type's folder setting names the storage folder", () => {
    expect(kindFromSuggestedFolder("3. Tax")).toBe("tax")
    expect(kindFromSuggestedFolder("5. Correspondence")).toBe("correspondence")
    expect(kindFromSuggestedFolder("1. Company")).toBe("company")
    expect(kindFromSuggestedFolder("4. Banking")).toBe("banking")
  })
  it("no folder setting (or a personal one) means no opinion — the record's category decides", () => {
    expect(kindFromSuggestedFolder(null)).toBeNull()
    expect(kindFromSuggestedFolder("2. Contacts")).toBeNull()
    expect(kindFromSuggestedFolder("whatever")).toBeNull()
  })
  it("reads a single tax year from a file name, nothing when absent or ambiguous", () => {
    expect(yearFromFileName("2025 FramaUS LLC 1120_To_Sign - Signed.pdf")).toBe(2025)
    expect(yearFromFileName("Form 8879_Lucky Pama LLC_To_Sign - Signed.pdf")).toBeNull()
    expect(yearFromFileName("2024 and 2025 summary.pdf")).toBeNull()
    expect(yearFromFileName("invoice 120250.pdf")).toBeNull()
  })
})

describe("faxReceiptRule — a tax-return fax receipt goes to Tax / year as a Fax Confirmation", () => {
  it("IRS Fax and Fax Confirmation both become Fax Confirmation in Tax", () => {
    expect(faxReceiptRule("irs_fax")).toEqual({ slug: "fax_confirmation", kind: "tax" })
    expect(faxReceiptRule("fax_confirmation")).toEqual({ slug: "fax_confirmation", kind: "tax" })
  })
  it("any other type is not touched by the rule", () => {
    expect(faxReceiptRule("form_1120")).toBeNull()
    expect(faxReceiptRule(null)).toBeNull()
    expect(faxReceiptRule(undefined)).toBeNull()
  })
})
