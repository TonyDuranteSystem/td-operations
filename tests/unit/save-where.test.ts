import { describe, it, expect } from "vitest"
import { proposeFaxPlace, taxYearFromName, documentTypeFor, isFaxPurpose, FAX_PURPOSES, type PlaceOwnerRef } from "@/lib/crm-store/save-where"

const acme: PlaceOwnerRef = { kind: "company", accountId: "acc-1", name: "Acme International LLC" }
const NOW = new Date("2026-10-20T12:00:00Z")

describe("taxYearFromName — one plausible year, nothing guessed", () => {
  it("a single year", () => { expect(taxYearFromName("2025 Tax Return - Acme.pdf", NOW)).toBe(2025) })
  it("two different years, none, or an implausible year → null", () => {
    expect(taxYearFromName("Return 2024 and 2025.pdf", NOW)).toBeNull()
    expect(taxYearFromName("scan0042.pdf", NOW)).toBeNull()
    expect(taxYearFromName("Return 2099.pdf", NOW)).toBeNull()
    expect(taxYearFromName("Return 1999.pdf", NOW)).toBeNull()
  })
  it("a year that is part of a DATE is not the tax year", () => {
    expect(taxYearFromName("Tax Return signed 2025-10-20.pdf", NOW)).toBeNull()
    expect(taxYearFromName("Tax Return signed 10.20.2025.pdf", NOW)).toBeNull()
    expect(taxYearFromName("Tax Return signed Oct 20, 2025.pdf", NOW)).toBeNull()
    expect(taxYearFromName("Tax Return 20 October 2025.pdf", NOW)).toBeNull()
    expect(taxYearFromName("Return signed 2025_10_20.pdf", NOW)).toBeNull()
    expect(taxYearFromName("2024 Tax Return signed 2025-10-20.pdf", NOW)).toBe(2024)
    expect(taxYearFromName("2025 Tax Return - Acme.pdf", NOW)).toBe(2025)
    expect(taxYearFromName("Return_2025_Signed_for_IRS.pdf", NOW)).toBe(2025)
  })
  it("the same year twice is still one year; a number inside a longer number is not a year", () => {
    expect(taxYearFromName("2025 Return 2025 copy.pdf", NOW)).toBe(2025)
    expect(taxYearFromName("Ref 120251.pdf", NOW)).toBeNull()
  })
})

describe("proposeFaxPlace — Antonio's fax rules, each with a reason", () => {
  it("(a) tax return to the IRS → that company's Tax folder, in the year's folder (year from the file name)", () => {
    const p = proposeFaxPlace({ purpose: "irs_tax_return", company: acme, fileName: "2025 Tax Return - Acme.pdf", now: NOW })
    expect(p).toMatchObject({ state: "proposed", owner: acme, folder: { kind: "tax", year: 2025 }, path: ["Acme International LLC", "3. Tax", "2025"] })
    expect(p.why).toMatch(/Tax folder/)
    expect(p.why).toMatch(/2025/)
  })
  it("(a) no single year in the name → the Tax folder itself, and it says why", () => {
    const p = proposeFaxPlace({ purpose: "irs_tax_return", company: acme, fileName: "signed.pdf", now: NOW })
    expect(p).toMatchObject({ state: "proposed", folder: { kind: "tax", year: null }, path: ["Acme International LLC", "3. Tax"] })
    expect(p.why).toMatch(/does not give one single tax year/)
  })
  it("(b) EIN request to the IRS → the company's own folder (Company), even if the name says a year", () => {
    const p = proposeFaxPlace({ purpose: "irs_ein_request", company: acme, fileName: "SS-4 2026.pdf", now: NOW })
    expect(p).toMatchObject({ state: "proposed", owner: acme, folder: { kind: "company" }, path: ["Acme International LLC", "1. Company"] })
    expect(p.why).toMatch(/EIN/)
  })
  it("(c) a fax for a third party → Business › Fax, whatever company was picked", () => {
    for (const company of [null, acme, { kind: "business" } as PlaceOwnerRef]) {
      const p = proposeFaxPlace({ purpose: "third_party", company, fileName: "x.pdf", now: NOW })
      expect(p).toMatchObject({ state: "proposed", owner: { kind: "business" }, folder: { kind: "named", name: "Fax" }, path: ["Business", "Fax"] })
    }
  })
  it("'Something else' proposes nothing and says to choose a place", () => {
    const p = proposeFaxPlace({ purpose: "something_else", company: acme, fileName: "2025 Tax Return.pdf", now: NOW })
    expect(p.state).toBe("choose")
    expect(p.why).toMatch(/Choose a place/)
  })
  it("'Not sure': an IRS fax with no company (or Business) proposes nothing — the company is never read from the file name", () => {
    for (const purpose of ["irs_tax_return", "irs_ein_request"] as const) {
      expect(proposeFaxPlace({ purpose, company: null, fileName: "Acme International LLC 2025 Tax Return.pdf", now: NOW }).state).toBe("choose")
      expect(proposeFaxPlace({ purpose, company: { kind: "business" }, fileName: "x.pdf", now: NOW }).state).toBe("choose")
    }
  })
  it("choosing Business for an IRS fax says plainly that a tax return / EIN request needs a company", () => {
    const t = proposeFaxPlace({ purpose: "irs_tax_return", company: { kind: "business" }, fileName: "x.pdf", now: NOW })
    expect(t.why).toMatch(/belongs to a company, so it has no place in Business/)
    expect(t.why).not.toMatch(/pick the company above\. Or use/)
    expect(proposeFaxPlace({ purpose: "irs_ein_request", company: { kind: "business" }, fileName: "x.pdf", now: NOW }).why).toMatch(/belongs to a company/)
    expect(proposeFaxPlace({ purpose: "irs_tax_return", company: null, fileName: "x.pdf", now: NOW }).why).toMatch(/pick the company above/)
  })
  it("every purpose is known; a stray value is not a purpose", () => {
    expect(FAX_PURPOSES.map((p) => p.key)).toEqual(["irs_tax_return", "irs_ein_request", "third_party", "something_else"])
    expect(isFaxPurpose("third_party")).toBe(true)
    expect(isFaxPurpose("guess")).toBe(false)
  })
})

describe("documentTypeFor", () => {
  it("IRS faxes are 'IRS Fax' wherever they go; the rest is a plain document in a client's storage and untyped in the firm's own areas", () => {
    expect(documentTypeFor("irs_tax_return", false)).toBe("irs_fax")
    expect(documentTypeFor("irs_ein_request", true)).toBe("irs_fax")
    expect(documentTypeFor("third_party", true)).toBeNull()
    expect(documentTypeFor("something_else", false)).toBe("other_document")
  })
})
