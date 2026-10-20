import { describe, it, expect } from "vitest"
import { looksPersonal, personalKind } from "@/lib/fax/save-sent-upload"

describe("personalKind / looksPersonal — a person's own paper", () => {
  it("identity and residence papers are 'identity'", () => {
    for (const n of ["Passport copy.pdf", "ID card.png", "W-7 Rossi.pdf", "ITIN letter.pdf", "Proof of address.pdf", "Utility bill May.pdf", "visa.pdf", "I-94.pdf", "W-8BEN.pdf", "8843.pdf", "SSN card.jpg", "Driver license.jpg"]) {
      expect(personalKind(n), n).toBe("identity")
      expect(looksPersonal(n)).toBe(true)
    }
  })
  it("SS-4 and the 1040 family are 'form' (kept off the company's Documents tab)", () => {
    for (const n of ["SS-4 Rossi.pdf", "ss4.pdf", "1040 2025.pdf", "Form 1040-NR.pdf"]) expect(personalKind(n), n).toBe("form")
  })
  it("a company paper is not personal", () => {
    for (const n of ["2025 Tax Return - Acme International LLC.pdf", "1120 2025.pdf", "5472.pdf", "Articles of Organization.pdf", "scan0042.pdf"]) {
      expect(personalKind(n), n).toBeNull()
      expect(looksPersonal(n)).toBe(false)
    }
  })
})
