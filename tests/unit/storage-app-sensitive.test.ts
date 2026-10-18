import { describe, it, expect } from "vitest"
import { isSensitiveForDevice, looksSensitiveByName, SENSITIVE_DOCUMENT_TYPES, keepSecondsFor } from "@/lib/storage-app/sensitive"
import { defaultSettings } from "@/lib/storage-app/settings"

describe("what counts as sensitive for the Mac app (opens, but audited and kept only briefly — Antonio 2026-10-17)", () => {
  it("blocks passports, IDs and the ITIN papers wherever they are", () => {
    for (const t of SENSITIVE_DOCUMENT_TYPES) {
      expect(isSensitiveForDevice({ documentType: t, ownerKind: "company" })).toBe(true)
      expect(isSensitiveForDevice({ documentType: t.toUpperCase(), ownerKind: "person" })).toBe(true)
    }
    expect(SENSITIVE_DOCUMENT_TYPES).toEqual(["passport", "id_document", "itin_letter", "form_w_7", "form_w_7_coa", "form_1040_nr", "itin_application", "itin_schedule_oi"])
  })
  it("blocks ANY untyped file inside a person's storage (it could be an untyped passport)", () => {
    expect(isSensitiveForDevice({ documentType: null, ownerKind: "person" })).toBe(true)
    expect(isSensitiveForDevice({ documentType: "  ", ownerKind: "person" })).toBe(true)
  })
  it("lets everything else through, including untyped files in company, Business and My files", () => {
    expect(isSensitiveForDevice({ documentType: "articles_of_organization", ownerKind: "company" })).toBe(false)
    expect(isSensitiveForDevice({ documentType: "irs_notice", ownerKind: "person" })).toBe(false)
    expect(isSensitiveForDevice({ documentType: null, ownerKind: "company" })).toBe(false)
    expect(isSensitiveForDevice({ documentType: null, ownerKind: "business" })).toBe(false)
    expect(isSensitiveForDevice({ documentType: undefined, ownerKind: "private" })).toBe(false)
  })

  it("an UNTYPED file anywhere whose name looks like an identity / ITIN paper is blocked until someone types it", () => {
    for (const name of ["ITIN data.pdf", "ITIN_Data_QA_Test_Cutover (5).pdf", "W-7 application.pdf", "w7_form.pdf", "Form W 7 signed.pdf", "Passport (2).pdf", "passaporto.jpg", "SSN card.jpg", "Social Security card.png", "Driver's License.pdf", "ID card front.jpg", "carta d'identità.pdf", "Permesso di soggiorno.pdf", "1040-NR draft.pdf", "Schedule OI.pdf", "identity proof.pdf"]) {
      expect(looksSensitiveByName(name), name).toBe(true)
      expect(isSensitiveForDevice({ documentType: null, ownerKind: "company", name }), name).toBe(true)
    }
  })
  it("ordinary untyped company files are NOT blocked by name", () => {
    for (const name of ["Invoice 2025.pdf", "Operating Agreement.docx", "Bank statement.pdf", "Articles of Organization.pdf", "Tax return 1040.pdf", "Notes.txt", "Meeting minutes (final).docx", "QA Test client upload (2).pdf"]) {
      expect(looksSensitiveByName(name), name).toBe(false)
      expect(isSensitiveForDevice({ documentType: null, ownerKind: "company", name }), name).toBe(false)
    }
    expect(looksSensitiveByName(null)).toBe(false)
    expect(looksSensitiveByName("")).toBe(false)
  })
  it("a TYPED file is judged by its type only, whatever its name says", () => {
    expect(isSensitiveForDevice({ documentType: "irs_notice", ownerKind: "company", name: "ITIN notice.pdf" })).toBe(false)
    expect(isSensitiveForDevice({ documentType: "passport", ownerKind: "company", name: "Notes.txt" })).toBe(true)
  })
})

describe("how long a Mac keeps the copy of an opened file (Antonio 2026-10-17 evening)", () => {
  it("sensitive papers 2 minutes, everything else 15 minutes", () => {
    const d = defaultSettings()
    expect(d.keepSecondsSensitive).toBe(120)
    expect(d.keepSecondsNormal).toBe(900)
    expect(keepSecondsFor(true, d)).toBe(120)
    expect(keepSecondsFor(false, d)).toBe(900)
    expect(keepSecondsFor(true, { keepSecondsSensitive: 30, keepSecondsNormal: 60 })).toBe(30)
  })
})
