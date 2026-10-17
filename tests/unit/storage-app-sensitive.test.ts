import { describe, it, expect } from "vitest"
import { isSensitiveForDevice, SENSITIVE_DOCUMENT_TYPES } from "@/lib/storage-app/sensitive"

describe("what a Mac may not download (Antonio 2026-10-17)", () => {
  it("blocks passports, IDs and the ITIN papers wherever they are", () => {
    for (const t of SENSITIVE_DOCUMENT_TYPES) {
      expect(isSensitiveForDevice({ documentType: t, ownerKind: "company" })).toBe(true)
      expect(isSensitiveForDevice({ documentType: t.toUpperCase(), ownerKind: "person" })).toBe(true)
    }
    expect(SENSITIVE_DOCUMENT_TYPES).toEqual(["passport", "id_document", "itin_letter", "form_w_7", "form_1040_nr", "itin_application", "itin_schedule_oi"])
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
})
