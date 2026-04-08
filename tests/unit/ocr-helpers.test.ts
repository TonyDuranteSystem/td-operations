import { describe, it, expect } from "vitest"
import { parseItinIssueDateFromOcr } from "@/lib/ocr-helpers"

describe("parseItinIssueDateFromOcr", () => {
  it("extracts date from real CP565 OCR text", () => {
    const ocrText = `IRS Notice CP565
Case Reference Number: 20294-058-26617-6
Date of Birth: July 31, 2003
March 30, 2026
You've been assigned an Individual Taxpayer Identification Number (ITIN)
This notice confirms your assigned ITIN 904-62-7931.`

    expect(parseItinIssueDateFromOcr(ocrText)).toBe("2026-03-30")
  })

  it("picks the date closest to ITIN assignment text when multiple dates exist", () => {
    const ocrText = `Department of the Treasury
January 15, 2025
Some other content here...
Date of Birth: July 31, 2003
December 5, 2025
You've been assigned an Individual Taxpayer Identification Number (ITIN)
This notice confirms your assigned ITIN 912-34-5678.`

    expect(parseItinIssueDateFromOcr(ocrText)).toBe("2025-12-05")
  })

  it("handles date without comma after day", () => {
    const ocrText = `March 5 2026
You've been assigned an Individual Taxpayer Identification Number (ITIN)
ITIN 901-23-4567`

    expect(parseItinIssueDateFromOcr(ocrText)).toBe("2026-03-05")
  })

  it("handles single-digit day", () => {
    const ocrText = `January 3, 2026
assigned ITIN 999-88-7777`

    expect(parseItinIssueDateFromOcr(ocrText)).toBe("2026-01-03")
  })

  it("falls back to today when no date found", () => {
    const ocrText = "Some random text with no date patterns ITIN 901-23-4567"
    const today = new Date().toISOString().split("T")[0]

    expect(parseItinIssueDateFromOcr(ocrText)).toBe(today)
  })

  it("is case-insensitive for month names", () => {
    const ocrText = `MARCH 30, 2026
assigned ITIN 904-62-7931`

    expect(parseItinIssueDateFromOcr(ocrText)).toBe("2026-03-30")
  })
})
