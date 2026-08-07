import { describe, it, expect } from "vitest"
import { renewalActionLink } from "@/lib/renewal-links"

describe("renewalActionLink — calendar action rows link to the filing venue", () => {
  it("RA renewals always go to Harbor Compliance, regardless of state", () => {
    expect(renewalActionLink("ra", "Wyoming")?.url).toContain("harborcompliance.com")
    expect(renewalActionLink("ra", "New Mexico")?.label).toBe("Harbor Compliance")
    expect(renewalActionLink("ra", null)?.url).toContain("harborcompliance.com")
  })

  it("annual reports go to the formation state's SOS portal — full names and codes", () => {
    expect(renewalActionLink("ar", "Wyoming")?.url).toContain("wyobiz.wyo.gov")
    expect(renewalActionLink("ar", "WY")?.label).toBe("WY SOS")
    expect(renewalActionLink("ar", "Florida")?.url).toContain("sunbiz.org")
    expect(renewalActionLink("ar", "Delaware")?.url).toContain("delaware.gov")
    expect(renewalActionLink("ar", "Massachusetts")?.label).toBe("MA SOS")
    expect(renewalActionLink("ar", "  florida  ")?.label).toBe("Sunbiz")
  })

  it("unknown or missing state → null (row shows no link, never a wrong portal)", () => {
    expect(renewalActionLink("ar", null)).toBeNull()
    expect(renewalActionLink("ar", "Texas")).toBeNull()
    expect(renewalActionLink("ar", "")).toBeNull()
  })
})
