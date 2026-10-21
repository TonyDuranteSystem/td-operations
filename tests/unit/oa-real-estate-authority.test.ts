import { describe, it, expect } from "vitest"
import { generateOASections, includesRealEstateAuthority, REAL_ESTATE_AUTHORITY_FROM, type OAData } from "@/lib/types/oa-templates"

const base: OAData = {
  company_name: "Acme LLC", state_of_formation: "Florida", formation_date: "2020-01-01", entity_type: "SMLLC",
  member_name: "Pat Doe", manager_name: "Pat Doe", effective_date: "2026-10-20", business_purpose: "any lawful business",
  initial_contribution: "$1,000 USD", fiscal_year_end: "December 31", accounting_method: "Cash", duration: "Perpetual",
  principal_address: "10225 Ulmerton Rd, Largo, FL 33771",
}
const resolutions = (d: OAData) => generateOASections(d).find(s => s.title === "Initial Resolutions of the Manager")!.content

describe("Manager's authority for real estate (Initial Resolutions)", () => {
  it("a new agreement lets the Manager sign for real estate transactions", () => {
    const text = resolutions({ ...base, created_at: "2026-10-21T10:00:00Z" })
    expect(text).toContain("to open bank accounts in the name of the Company")
    expect(text).toContain("to designate authorized signatories for such accounts, and to sign and deliver, in the name and on behalf of the Company")
    expect(text).toContain("real estate transactions")
    expect(text).toContain("purchase, sale, lease, or financing of real property")
  })
  it("a live preview (no created_at) gets the current wording", () => {
    expect(resolutions(base)).toContain("real estate transactions")
  })
  it("an agreement created before the change keeps its original wording", () => {
    const text = resolutions({ ...base, created_at: "2026-04-02T17:00:38Z" })
    expect(text).toContain("and to designate authorized signatories for such accounts;")
    expect(text).not.toContain("real estate")
  })
  it("the cut-off is exact and an unreadable date falls back to the current wording", () => {
    expect(includesRealEstateAuthority(REAL_ESTATE_AUTHORITY_FROM)).toBe(true)
    expect(includesRealEstateAuthority("2026-10-20T12:59:59Z")).toBe(false)
    expect(includesRealEstateAuthority("not a date")).toBe(true)
    expect(includesRealEstateAuthority(null)).toBe(true)
  })
  it("every other resolution is untouched", () => {
    const text = resolutions({ ...base, created_at: "2026-10-21T10:00:00Z" })
    expect(text).toContain("apply for an Employer Identification Number (EIN)")
    expect(text).toContain("Manager: Pat Doe")
  })
})
