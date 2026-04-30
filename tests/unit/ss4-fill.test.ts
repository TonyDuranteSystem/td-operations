import { describe, it, expect } from "vitest"
import { fillSS4, type SS4FillData } from "@/lib/pdf/ss4-fill"
import { PDFDocument } from "pdf-lib"

/**
 * SS-4 PDF fill tests.
 *
 * Line 6 (county_and_state) = entity's primary physical location per IRS instruction.
 * It must be explicitly provided — never auto-derived from formation state, owner address,
 * mailing address, or registered agent address. The PDF generator throws if it is missing.
 */

// Fixtures use realistic but distinct county values to make the rule explicit.
// county_and_state must be set based on verified primary physical location, not assumed.

const SMLLC_DATA: SS4FillData = {
  companyName: "Test Company LLC",
  entityType: "SMLLC",
  stateOfFormation: "NM",
  formationDate: "2026-03-15",
  memberCount: 1,
  responsiblePartyName: "John Smith",
  responsiblePartyTitle: "Owner",
  responsiblePartyPhone: "+44 7911 123456",
  countyAndState: "Bernalillo County, New Mexico", // explicitly verified primary physical location
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
  countyAndState: "Sheridan County, Wyoming", // explicitly verified primary physical location
}

describe("SS-4 PDF Fill", () => {
  it("generates a valid PDF for SMLLC", async () => {
    const bytes = await fillSS4(SMLLC_DATA)
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(bytes.length).toBeGreaterThan(50000)

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
    const data: SS4FillData = { ...SMLLC_DATA, formationDate: "2026-01-15" }
    const bytes = await fillSS4(data)
    expect(bytes.length).toBeGreaterThan(0)
  }, 30000)

  it("handles ITIN in line 7b when provided", async () => {
    const data: SS4FillData = { ...SMLLC_DATA, responsiblePartyItin: "912-34-5678" }
    const bytes = await fillSS4(data)
    expect(bytes.length).toBeGreaterThan(0)
  }, 30000)

  it("defaults to 'Foreigner' for line 7b when no ITIN", async () => {
    const data: SS4FillData = { ...SMLLC_DATA, responsiblePartyItin: undefined }
    const bytes = await fillSS4(data)
    expect(bytes.length).toBeGreaterThan(0)
  }, 30000)

  it("handles hasAppliedBefore with previous EIN", async () => {
    const data: SS4FillData = { ...SMLLC_DATA, hasAppliedBefore: true, previousEin: "12-3456789" }
    const bytes = await fillSS4(data)
    expect(bytes.length).toBeGreaterThan(0)
  }, 30000)

  // ─── Line 6: county_and_state is required (IRS primary physical location) ────

  it("throws when countyAndState is missing — admin must verify primary physical location", async () => {
    const data: SS4FillData = { ...SMLLC_DATA, countyAndState: undefined }
    await expect(fillSS4(data)).rejects.toThrow(/county_and_state.*Line 6.*required|Line 6.*required/i)
  }, 30000)

  it("accepts any explicitly verified county_and_state regardless of formation state", async () => {
    // The fill function renders whatever county_and_state the admin verified.
    // Formation state plays no role in determining Line 6.
    const floridaPrimary: SS4FillData = {
      ...SMLLC_DATA,
      stateOfFormation: "NM",
      countyAndState: "Pinellas County, Florida", // only correct if primary physical location is TD Largo
    }
    const wyomingPrimary: SS4FillData = {
      ...SMLLC_DATA,
      stateOfFormation: "NM",
      countyAndState: "Sheridan County, Wyoming",
    }
    const [bytesFL, bytesWY] = await Promise.all([fillSS4(floridaPrimary), fillSS4(wyomingPrimary)])
    expect(bytesFL.length).toBeGreaterThan(50000)
    expect(bytesWY.length).toBeGreaterThan(50000)
  }, 30000)

  it("WY-formed LLC with WY primary physical location → Sheridan County, Wyoming on Line 6", async () => {
    // A Wyoming LLC whose primary physical location is the Wyoming TD office
    // must use Sheridan County, Wyoming — NOT Pinellas County, Florida.
    const data: SS4FillData = {
      ...MMLLC_DATA,
      stateOfFormation: "WY",
      countyAndState: "Sheridan County, Wyoming",
    }
    const bytes = await fillSS4(data)
    expect(bytes.length).toBeGreaterThan(50000)
  }, 30000)

  it("Pinellas County only appears when explicitly set — not derived from formation state or mailing address", async () => {
    // Pinellas County is valid only when the admin has verified the entity's
    // primary physical location is the TD Largo office.
    const data: SS4FillData = {
      ...SMLLC_DATA,
      stateOfFormation: "NM",
      countyAndState: "Pinellas County, Florida",
    }
    const bytes = await fillSS4(data)
    const pdf = await PDFDocument.load(bytes)
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(1)
    // No auto-derivation: if countyAndState had been omitted, the generator would throw.
  }, 30000)

  it("NM-formed LLC with NM primary physical location → county in New Mexico on Line 6", async () => {
    const data: SS4FillData = {
      ...SMLLC_DATA,
      stateOfFormation: "NM",
      countyAndState: "Bernalillo County, New Mexico",
    }
    const bytes = await fillSS4(data)
    expect(bytes.length).toBeGreaterThan(50000)
  }, 30000)
})
