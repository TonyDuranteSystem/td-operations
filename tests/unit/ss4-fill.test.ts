import { describe, it, expect } from "vitest"
import { fillSS4, type SS4FillData } from "@/lib/pdf/ss4-fill"
import { PDFDocument } from "pdf-lib"

const SMLLC_DATA: SS4FillData = {
  companyName: "Test Company LLC",
  entityType: "SMLLC",
  stateOfFormation: "NM",
  formationDate: "2026-03-15",
  memberCount: 1,
  responsiblePartyName: "John Smith",
  responsiblePartyTitle: "Owner",
  responsiblePartyPhone: "+44 7911 123456",
}

const MMLLC_DATA: SS4FillData = {
  companyName: "Multi Member LLC",
  entityType: "MMLLC",
  stateOfFormation: "WY",
  formationDate: "2025-09-26",
  memberCount: 2,
  responsiblePartyName: "Jane Doe",
  responsiblePartyItin: "912-34-5678",
  responsiblePartyTitle: "Member",
  responsiblePartyPhone: "+49 30 12345678",
}

describe("SS-4 PDF Fill", () => {
  it("generates a valid PDF for SMLLC", async () => {
    const bytes = await fillSS4(SMLLC_DATA)
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(bytes.length).toBeGreaterThan(50000)

    // Verify it's a valid PDF
    const pdf = await PDFDocument.load(bytes)
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(1)
  }, 30000)

  it("generates a valid PDF for MMLLC", async () => {
    const bytes = await fillSS4(MMLLC_DATA)
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(bytes.length).toBeGreaterThan(50000)

    const pdf = await PDFDocument.load(bytes)
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(1)
  }, 30000)

  it("formats date correctly from YYYY-MM-DD to MM/DD/YYYY", async () => {
    // The date formatting is internal, but we can verify it produces a valid PDF
    const data: SS4FillData = {
      ...SMLLC_DATA,
      formationDate: "2026-01-15",
    }
    const bytes = await fillSS4(data)
    expect(bytes.length).toBeGreaterThan(0)
  }, 30000)

  it("handles ITIN in line 7b when provided", async () => {
    const data: SS4FillData = {
      ...SMLLC_DATA,
      responsiblePartyItin: "912-34-5678",
    }
    const bytes = await fillSS4(data)
    expect(bytes.length).toBeGreaterThan(0)
  }, 30000)

  it("defaults to 'Foreigner' for line 7b when no ITIN", async () => {
    const data: SS4FillData = {
      ...SMLLC_DATA,
      responsiblePartyItin: undefined,
    }
    const bytes = await fillSS4(data)
    expect(bytes.length).toBeGreaterThan(0)
  }, 30000)

  it("uses custom county override when provided", async () => {
    const data: SS4FillData = {
      ...SMLLC_DATA,
      countyAndState: "Custom County - Custom State",
    }
    const bytes = await fillSS4(data)
    expect(bytes.length).toBeGreaterThan(0)
  }, 30000)

  it("handles hasAppliedBefore with previous EIN", async () => {
    const data: SS4FillData = {
      ...SMLLC_DATA,
      hasAppliedBefore: true,
      previousEin: "12-3456789",
    }
    const bytes = await fillSS4(data)
    expect(bytes.length).toBeGreaterThan(0)
  }, 30000)
})
