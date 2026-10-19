import { describe, it, expect, vi } from "vitest"
import { companyNamedInFile, periodYearFromName, looksPersonal, fileSentUpload, type SentUploadDeps } from "@/lib/fax/save-sent-upload"

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
  it("a short name is never matched; no name = null; no partial words", () => {
    expect(companyNamedInFile("AB LLC return.pdf", accounts)).toBeNull()
    expect(companyNamedInFile("scan0001.pdf", accounts)).toBeNull()
    expect(companyNamedInFile("Horuss LLC return.pdf", accounts)).toBeNull()
  })
})

describe("periodYearFromName — conservative", () => {
  const now = new Date("2026-10-18")
  it("a tax paper naming exactly one year", () => {
    expect(periodYearFromName("2025_FULFIL_1120Proforma.pdf", now)).toBe(2025)
    expect(periodYearFromName("Tax Return 2024 Amended.pdf", now)).toBe(2024)
  })
  it("a stray year in a non-tax paper is NOT a tax year", () => {
    expect(periodYearFromName("SS-4 Acme LLC 2026.pdf", now)).toBeNull()
    expect(periodYearFromName("Letter 2026.pdf", now)).toBeNull()
  })
  it("two different years, or none, or an implausible year -> no year", () => {
    expect(periodYearFromName("Tax Return 2024 and 2025.pdf", now)).toBeNull()
    expect(periodYearFromName("scan12345 return.pdf", now)).toBeNull()
    expect(periodYearFromName("Tax return 2031.pdf", now)).toBeNull()
  })
})

describe("looksPersonal", () => {
  it("passports, IDs, W-7/ITIN papers, proofs of address are personal; a tax return is not", () => {
    for (const n of ["Passport Mario Rossi.pdf", "W-7 Rossi.pdf", "ITIN package.pdf", "id card front.jpg", "Proof of address.pdf", "Driver license.png", "SS-4 Rossi.pdf", "Form 1040 2025 Rossi.pdf", "1040-NR Rossi.pdf", "W-8BEN.pdf"]) expect(looksPersonal(n)).toBe(true)
    for (const n of ["2025 Tax Return - Acme LLC_Signed_for_IRS.pdf", "Form 1120 2025.pdf", "Form 1065 2025.pdf", "5472 Acme.pdf"]) expect(looksPersonal(n)).toBe(false)
  })
})

describe("fileSentUpload", () => {
  const base = { accountId: null, serviceDeliveryId: null, fileName: "x.pdf", bytes: Buffer.from("%PDF"), mimeType: "application/pdf", actor: "luca@x", contentHash: "h1" }
  const mk = (over: Partial<SentUploadDeps> = {}) => {
    const save = vi.fn(async () => ({ route: "store" as const, documentRowId: "doc-1" }))
    const deps: SentUploadDeps = { accountOfDelivery: async () => "sd-acc", accounts: async () => accounts, save: save as unknown as SentUploadDeps["save"], ...over }
    return { deps, save }
  }
  it("a named company: filed in ITS storage with the year; the key carries the company", async () => {
    const m = mk()
    const r = await fileSentUpload({ ...base, accountId: "a1", fileName: "2025 Tax return.pdf" }, m.deps)
    expect(r).toEqual({ route: "store", accountId: "a1", documentRowId: "doc-1", inferred: false })
    expect(m.save).toHaveBeenCalledWith(expect.objectContaining({ accountId: "a1", year: 2025, callerKey: "fax-upload:a1:h1" }))
  })
  it("the SAME bytes faxed for company A and then company B never share a key", async () => {
    const m = mk()
    await fileSentUpload({ ...base, accountId: "a1" }, m.deps)
    await fileSentUpload({ ...base, accountId: "a2" }, m.deps)
    const keys = m.save.mock.calls.map((c) => (c as unknown as [{ callerKey: string }])[0].callerKey)
    expect(new Set(keys).size).toBe(2)
  })
  it("a flow fax uses the flow's company; a flow lookup error is NOT swallowed", async () => {
    const m = mk()
    expect(await fileSentUpload({ ...base, serviceDeliveryId: "sd1" }, m.deps)).toMatchObject({ route: "store", accountId: "sd-acc", inferred: false })
    const bad = mk({ accountOfDelivery: async () => { throw new Error("db down") } })
    await expect(fileSentUpload({ ...base, serviceDeliveryId: "sd1" }, bad.deps)).rejects.toThrow("db down")
  })
  it("a company guessed from the file name is reported as inferred", async () => {
    const m = mk()
    expect(await fileSentUpload({ ...base, fileName: "2025 Horus LLC 1120 Proforma Signed for IRS.pdf" }, m.deps)).toMatchObject({ route: "store", accountId: "a2", inferred: true })
  })
  it("a personal document is never filed in a company's storage, even with a company named", async () => {
    const m = mk()
    expect(await fileSentUpload({ ...base, accountId: "a1", fileName: "W-7 + passport copy.pdf" }, m.deps)).toEqual({ route: "none", reason: "personal_document" })
    expect(m.save).not.toHaveBeenCalled()
  })
  it("nobody identifiable / company without storage / company moving -> nothing filed, with the reason", async () => {
    expect(await fileSentUpload(base, mk().deps)).toEqual({ route: "none", reason: "no_company" })
    expect(await fileSentUpload({ ...base, accountId: "a1" }, mk({ save: async () => ({ route: "drive" }) }).deps)).toEqual({ route: "none", reason: "company_has_no_storage" })
    expect(await fileSentUpload({ ...base, accountId: "a1" }, mk({ save: async () => ({ route: "moving" }) }).deps)).toEqual({ route: "none", reason: "company_moving" })
  })
})
