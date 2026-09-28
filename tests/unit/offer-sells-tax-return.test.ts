import { describe, it, expect } from "vitest"
import { offerSellsTaxReturn } from "@/lib/offers/compute-offer-totals"

// Antonio 2026-09-27: onboarding + tax return are on ONE invoice. Own price or
// $0 (included in the onboarding price) — once the offer is paid, the tax
// return is paid. The price never decides it.
describe("offerSellsTaxReturn", () => {
  it("tax return with its own price → sold (paid with the offer)", () => {
    expect(offerSellsTaxReturn([{ name: "Client Onboarding", price: "€1500" }, { name: "Tax Return", price: "$1,000", pipeline_type: "Tax Return" }])).toBe(true)
    expect(offerSellsTaxReturn([{ name: "Tax Return", price: "$750", pipeline_type: "Tax Return" }])).toBe(true)
  })
  it("tax return at $0 / Included → sold (included in the onboarding price)", () => {
    for (const price of ["$0", "€0", "Included", "Inclusa"]) expect(offerSellsTaxReturn([{ name: "Tax Return", price, pipeline_type: "Tax Return" }])).toBe(true)
  })
  it("no tax return line → not sold", () => {
    expect(offerSellsTaxReturn([{ name: "Client Onboarding", price: "€1500", pipeline_type: "Client Onboarding" }])).toBe(false)
    expect(offerSellsTaxReturn(null)).toBe(false)
  })
  it("an optional tax return the client did not pick → not sold", () => {
    const services = [{ name: "Tax Return", price: "$500", pipeline_type: "Tax Return", optional: true }]
    expect(offerSellsTaxReturn(services, [])).toBe(false)
    expect(offerSellsTaxReturn(services, ["Tax Return"])).toBe(true)
  })
})
