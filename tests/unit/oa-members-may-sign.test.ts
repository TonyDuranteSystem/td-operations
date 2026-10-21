import { describe, it, expect } from "vitest"
import { generateOASections, type OAData } from "@/lib/types/oa-templates"

const base: OAData = {
  company_name: "Acme LLC", state_of_formation: "Florida", formation_date: "2020-01-01", entity_type: "MMLLC",
  member_name: "Pat Doe", manager_name: "Tony Manager", effective_date: "2026-10-21", business_purpose: "any lawful business",
  initial_contribution: "$1,000 USD", fiscal_year_end: "December 31", accounting_method: "Cash", duration: "Perpetual",
  principal_address: "10225 Ulmerton Rd, Largo, FL 33771",
  members: [
    { name: "Pat Doe", ownership_pct: 50, initial_contribution: "$1,000 USD" },
    { name: "Sam Roe", ownership_pct: 50, initial_contribution: "$1,000 USD" },
  ],
}
const membership = (d: OAData) => generateOASections(d).find(s => s.title === "Article II — Membership")!.content

describe("Section 2.3 — members may sign", () => {
  it("default (flag off/absent/null) keeps the Manager-only wording", () => {
    for (const flag of [undefined, null, false]) {
      const t = membership({ ...base, members_may_sign: flag })
      expect(t).toContain("full and exclusive authority")
      expect(t).toContain("No Member, solely by virtue of being a Member, shall have the authority to bind the Company.")
      expect(t).not.toContain("each Member, acting alone")
    }
  })
  it("flag on: Manager and each Member may sign, no 'exclusive', no 'No Member' sentence", () => {
    const t = membership({ ...base, members_may_sign: true })
    expect(t).toContain("The Manager shall have full authority to manage")
    expect(t).not.toContain("exclusive")
    expect(t).not.toContain("No Member, solely by virtue")
    expect(t).toContain("The Manager and each Member, acting alone, may also sign and deliver")
    expect(t).toContain("real estate transactions")
  })
  it("the rest of the Membership article is untouched", () => {
    const t = membership({ ...base, members_may_sign: true })
    expect(t).toContain("2.2 Limited Liability")
    expect(t).toContain("2.4 Compensation")
    expect(t).toContain("2.5 Voting")
  })
  it("the flag does not alter a single-member agreement", () => {
    const sm = { ...base, entity_type: "SMLLC" as const, members: undefined }
    expect(membership({ ...sm, members_may_sign: true })).toBe(membership(sm))
  })
})
