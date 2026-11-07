import { describe, it, expect } from "vitest"
import { showClosedCompanyNotice } from "@/lib/portal/closed-company"
import { t } from "@/lib/portal/i18n"

// Company Closure Part C (dev job a6bbea09): a client whose company was closed landed on "Thank you for your payment! Complete your setup…".
describe("showClosedCompanyNotice", () => {
  it("shows the closed-company notice when a company is closed and the latest offer is the finished one", () => {
    expect(showClosedCompanyNotice({ closedCompanyCount: 1, offerStatus: "completed" })).toBe(true)
    expect(showClosedCompanyNotice({ closedCompanyCount: 2, offerStatus: "Completed" })).toBe(true)
  })

  it("shows it for a client with a closed company and no offer at all", () => {
    expect(showClosedCompanyNotice({ closedCompanyCount: 1, offerStatus: null })).toBe(true)
    expect(showClosedCompanyNotice({ closedCompanyCount: 1, offerStatus: undefined })).toBe(true)
  })

  it("keeps the welcome flow when something new is being bought", () => {
    for (const s of ["draft", "sent", "viewed", "signed"]) {
      expect(showClosedCompanyNotice({ closedCompanyCount: 1, offerStatus: s }), s).toBe(false)
    }
  })

  it("never shows it for a client with no closed company (a real new client keeps the welcome screen)", () => {
    expect(showClosedCompanyNotice({ closedCompanyCount: 0, offerStatus: "completed" })).toBe(false)
    expect(showClosedCompanyNotice({ closedCompanyCount: 0, offerStatus: null })).toBe(false)
  })
})

describe("closed-company texts", () => {
  it("exist in both languages and carry the company placeholder", () => {
    for (const locale of ["en", "it"] as const) {
      for (const key of ["closedCompany.title", "closedCompany.chat", "closedCompany.request"]) {
        expect(t(key, locale), `${locale} ${key}`).not.toBe(key)
      }
      expect(t("closedCompany.body", locale)).toContain("{company}")
    }
    expect(t("closedCompany.title", "it")).not.toBe(t("closedCompany.title", "en"))
  })
})
