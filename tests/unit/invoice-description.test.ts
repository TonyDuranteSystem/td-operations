import { describe, it, expect } from "vitest"
import { getInvoiceDescription } from "@/lib/portal/offer-invoice-policy"

describe("getInvoiceDescription — the invoice created at signing", () => {
  it("a formation contract that sells no formation is named after what was bought (S1 E2E ★7)", () => {
    expect(getInvoiceDescription("formation", [], "Mario Rossi", [{ name: "Company Change Name", price: "€700", pipeline_type: "Company Change Name" }])).toBe("Company Change Name - Mario Rossi")
    expect(getInvoiceDescription("formation", null, "X", [{ name: "Company Closure", pipeline_type: "Company Closure" }, { name: "Shipping" }])).toBe("Company Closure + Shipping - X")
  })

  it("a real formation keeps the package label", () => {
    expect(getInvoiceDescription("formation", [], "Acme LLC", [{ name: "Company Formation", pipeline_type: "Company Formation" }, { name: "DBA Registration", pipeline_type: "DBA" }])).toBe("LLC Formation Package - Acme LLC")
  })

  it("unticked optional lines are not 'bought'", () => {
    expect(getInvoiceDescription("formation", [], "X", [{ name: "Company Closure", pipeline_type: "Company Closure", optional: true }])).toBe("LLC Formation Package - X")
  })

  it("other contract types are unchanged", () => {
    expect(getInvoiceDescription("onboarding", [], "X", [{ name: "Company Change Name", pipeline_type: "Company Change Name" }])).toBe("LLC Onboarding Package - X")
  })

  it("legacy offers with no typed lines keep the package label", () => {
    expect(getInvoiceDescription("formation", [], "X", [{ name: "Custom package" }])).toBe("LLC Formation Package - X")
    expect(getInvoiceDescription("formation", [], "X", null)).toBe("LLC Formation Package - X")
    expect(getInvoiceDescription("formation", [], "X")).toBe("LLC Formation Package - X")
  })

  it("selected services still win", () => {
    expect(getInvoiceDescription("formation", ["Company Change Name"], "DF", [{ name: "Other", pipeline_type: "Other" }])).toBe("Company Change Name - DF")
  })
})
