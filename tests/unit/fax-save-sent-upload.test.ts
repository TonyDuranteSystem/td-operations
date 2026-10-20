import { describe, it, expect } from "vitest"
import { looksPersonal, personalKind, normalizeFaxName } from "@/lib/fax/save-sent-upload"

describe("normalizeFaxName", () => {
  it("separators, camelCase and letter↔digit boundaries", () => {
    expect(normalizeFaxName("SS-4_Acme_Signed_for_IRS.pdf")).toBe("ss 4 acme signed for irs pdf")
    expect(normalizeFaxName("SS4Form.pdf")).toBe("ss 4 form pdf")
    expect(normalizeFaxName("Form_1040_2024.pdf")).toBe("form 1040 2024 pdf")
    expect(normalizeFaxName("Rossi(W-7).pdf")).toBe("rossi w 7 pdf")
  })
})

describe("personalKind / looksPersonal — a person's own paper", () => {
  it("identity and residence papers are 'identity' (spaces, hyphens, UNDERSCORES, camelCase)", () => {
    for (const n of [
      "Passport copy.pdf", "Passport_Rossi.pdf", "PassportRossi.pdf", "ID card.png", "ID_Card_Rossi.png", "W-7 Rossi.pdf", "W-7_Rossi.pdf", "W7_Rossi.pdf", "ITIN letter.pdf",
      "Rossi_ITIN.pdf", "RossiITIN.pdf", "Proof of address.pdf", "Proof_of_Address.pdf", "Utility bill May.pdf", "Utility_Bill.pdf", "visa.pdf", "Rossi_visa.pdf",
      "I-94.pdf", "I94_Rossi.pdf", "W-8BEN.pdf", "W8BEN_Rossi.pdf", "8843.pdf", "Form_8843_Rossi.pdf", "SSN card.jpg", "SSN_Rossi.jpg", "Driver license.jpg",
      "Drivers_License_Rossi.jpg", "Driver's License.jpg", "Driving licence.pdf", "Birth certificate.pdf", "Birth_Cert_Rossi.pdf", "Carta d'identità.pdf", "Social Security card.pdf",
    ]) {
      expect(personalKind(n), n).toBe("identity")
      expect(looksPersonal(n)).toBe(true)
    }
  })
  it("SS-4 and the 1040 family are 'form' in every spelling the production files use", () => {
    for (const n of [
      "SS-4 Rossi.pdf", "ss4.pdf", "SS-4_Acme_Signed_for_IRS.pdf", "SS4Form.pdf", "SS4_Acme.pdf", "1040 2025.pdf", "Form_1040_2024.pdf", "Form 1040-NR.pdf", "1040NR_Rossi.pdf", "Rossi_1040-NR_Signed_for_IRS.pdf",
    ]) expect(personalKind(n), n).toBe("form")
  })
  it("a company paper is not personal — including the production '…Signed_for_IRS' shapes", () => {
    for (const n of [
      "2025 Tax Return - Acme International LLC.pdf", "2025_Tax_Return_Acme_Signed_for_IRS.pdf", "1120 2025.pdf", "Form_1120_2025.pdf", "5472.pdf", "Articles of Organization.pdf", "scan0042.pdf",
      "Business License renewal.pdf", "Business_License.pdf", "Driver Services notice.pdf", "Identity Verification Services letter.pdf", "Advisory notice.pdf", "Itinerary 2025.pdf", "Vista Holdings LLC.pdf", "Assessment.pdf",
      "Idaho Annual Report.pdf", "Licensing agreement.pdf", "License Agreement.pdf",
    ]) {
      expect(personalKind(n), n).toBeNull()
      expect(looksPersonal(n)).toBe(false)
    }
  })
})
