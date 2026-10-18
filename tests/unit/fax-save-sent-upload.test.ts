import { describe, it, expect, vi } from "vitest"
import { companyNamedInFile, periodYearFromName, fileSentUpload, type SentUploadDeps } from "@/lib/fax/save-sent-upload"

const accounts = [
  { id: "a1", company_name: "Morgan & Taylor International LLC" },
  { id: "a2", company_name: "Horus LLC" },
  { id: "a3", company_name: "Horus LLC Holdings" },
  { id: "a4", company_name: "AB LLC" },
  { id: "a5", company_name: null },
]

describe("companyNamedInFile — whole name, one candidate only", () => {
  it("finds the company whose full name is in the file name", () => {
    expect(companyNamedInFile("2025 Tax Return - Morgan & Taylor International LLC_Signed_for_IRS.pdf", accounts)).toBe("a1")
  })
  it("two companies named (one name inside the other) -> nobody is guessed", () => {
    expect(companyNamedInFile("2025 Horus LLC Holdings 1120.pdf", accounts)).toBeNull()
  })
  it("a short name is never matched; no name = null", () => {
    expect(companyNamedInFile("AB LLC return.pdf", accounts)).toBeNull()
    expect(companyNamedInFile("scan0001.pdf", accounts)).toBeNull()
  })
  it("no partial words: 'Horus LLC' does not match 'Horuss LLC'", () => {
    expect(companyNamedInFile("Horuss LLC return.pdf", accounts)).toBeNull()
  })
})

describe("periodYearFromName", () => {
  it("reads the tax year", () => {
    expect(periodYearFromName("2025_FULFIL_1120Proforma.pdf")).toBe(2025)
    expect(periodYearFromName("Tax Return 2024 Amended.pdf")).toBe(2024)
    expect(periodYearFromName("scan12345.pdf")).toBeNull()
  })
})

describe("fileSentUpload", () => {
  const base = { accountId: null, serviceDeliveryId: null, fileName: "x.pdf", bytes: Buffer.from("%PDF"), mimeType: "application/pdf", actor: "luca@x", callerKey: "fax-upload:h" }
  const mk = (over: Partial<SentUploadDeps> = {}) => {
    const save = vi.fn(async () => ({ route: "store", documentRowId: "doc-1" }))
    const deps: SentUploadDeps = { accountOfDelivery: async () => "sd-acc", accounts: async () => accounts, save, ...over }
    return { deps, save }
  }
  it("a named company: filed in ITS storage, Tax, type IRS Fax, hidden, with the year", async () => {
    const m = mk()
    const r = await fileSentUpload({ ...base, accountId: "a1", fileName: "2025 return.pdf" }, m.deps)
    expect(r).toEqual({ route: "store", accountId: "a1", documentRowId: "doc-1", inferred: false })
    expect(m.save).toHaveBeenCalledWith(expect.objectContaining({ accountId: "a1", folder: "tax", documentType: "irs_fax", portalVisible: false, periodYear: 2025, callerKey: "fax-upload:h" }))
  })
  it("a flow fax uses the flow's company", async () => {
    const m = mk()
    expect(await fileSentUpload({ ...base, serviceDeliveryId: "sd1" }, m.deps)).toMatchObject({ route: "store", accountId: "sd-acc", inferred: false })
  })
  it("no company named: inferred from the file name, and said so", async () => {
    const m = mk()
    expect(await fileSentUpload({ ...base, fileName: "2025 Horus LLC 1120 Proforma Signed for IRS.pdf" }, m.deps)).toMatchObject({ route: "store", accountId: "a2", inferred: true })
  })
  it("nobody identifiable: nothing is filed (the caller keeps its old copy)", async () => {
    const m = mk()
    expect(await fileSentUpload(base, m.deps)).toEqual({ route: "none", reason: "no_company" })
    expect(m.save).not.toHaveBeenCalled()
  })
  it("a company with no storage: nothing is filed in Drive or anywhere new", async () => {
    const m = mk({ save: vi.fn(async () => ({ route: "drive" })) })
    expect(await fileSentUpload({ ...base, accountId: "a1" }, m.deps)).toEqual({ route: "none", reason: "company_has_no_storage" })
  })
})
