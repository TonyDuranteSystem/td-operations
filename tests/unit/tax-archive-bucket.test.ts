import { describe, it, expect } from "vitest"
import { bucketForTaxUploadPath } from "@/lib/tax/archive-submission"

describe("bucketForTaxUploadPath — find files across BOTH buckets (Carasso reliability)", () => {
  it("portal-wizard uploads resolve to onboarding-uploads", () => {
    expect(bucketForTaxUploadPath("tax/acct/bank_accounts_0_statements_ab12_mercury.csv")).toBe("onboarding-uploads")
    expect(bucketForTaxUploadPath("tax_return/x/prior_year_return_cd34_r.pdf")).toBe("onboarding-uploads")
    expect(bucketForTaxUploadPath("onboarding/x/passport_ef56_p.jpg")).toBe("onboarding-uploads")
  })

  it("legacy EXTERNAL tax-form uploads resolve to tax-form-uploads (Matteo's EIN letter)", () => {
    expect(bucketForTaxUploadPath("carasso-consulting-llc-2025/ein_letter_2-page-fax (EIN-147c).pdf")).toBe("tax-form-uploads")
    expect(bucketForTaxUploadPath("some-company-2024/statement.csv")).toBe("tax-form-uploads")
  })
})
