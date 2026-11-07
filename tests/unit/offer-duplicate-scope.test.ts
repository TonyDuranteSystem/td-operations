import { describe, it, expect } from "vitest"
import { duplicateOfferScope } from "@/lib/offers/duplicate-scope"

// Company Closure Part C (dev job a6bbea09): a closure offer on a company was refused (409) by ANY other open offer of that company.
describe("duplicateOfferScope", () => {
  const ACC = "acc-1"

  it("a standalone service on a company is blocked only by an open offer of the SAME kind", () => {
    for (const t of ["closure", "tax_return", "itin", "company_change_name", "ein_change_name", "shipping", "public_notary", "consulting_call", "custom_widget"]) {
      expect(duplicateOfferScope({ accountId: ACC, contractType: t }), t).toEqual({ column: "account_id", value: ACC, contractType: t })
    }
  })

  it("a bundle on a company still blocks on any open offer (unchanged)", () => {
    for (const t of ["formation", "onboarding", "renewal", undefined, null]) {
      expect(duplicateOfferScope({ accountId: ACC, contractType: t as string | null | undefined }), String(t)).toEqual({ column: "account_id", value: ACC })
    }
  })

  it("a lead beats a company, a company beats a contact (unchanged precedence)", () => {
    expect(duplicateOfferScope({ leadId: "lead-1", accountId: ACC, contactId: "c-1", contractType: "closure" })).toEqual({ column: "lead_id", value: "lead-1" })
    expect(duplicateOfferScope({ accountId: ACC, contactId: "c-1", contractType: "closure" })?.column).toBe("account_id")
  })

  it("a contact keeps the per-kind rule it always had", () => {
    expect(duplicateOfferScope({ contactId: "c-1", contractType: "itin" })).toEqual({ column: "contact_id", value: "c-1", contractType: "itin" })
    expect(duplicateOfferScope({ contactId: "c-1" })).toEqual({ column: "contact_id", value: "c-1" })
  })

  it("no owner means no duplicate check", () => {
    expect(duplicateOfferScope({ contractType: "closure" })).toBeNull()
    expect(duplicateOfferScope({ leadId: null, accountId: null, contactId: null })).toBeNull()
  })
})
