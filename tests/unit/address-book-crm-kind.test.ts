import { describe, it, expect } from "vitest"
import { CRM_KIND_IDS, CRM_KIND_TEXT, canRetype, classifyContact, classifyPartner, type AccountLink } from "@/lib/address-book/crm-kind"

const live = (over: Partial<AccountLink> = {}): AccountLink => ({ accountType: "Client", accountStatus: "Active", ended: false, ...over })

describe("what the CRM says a contact is", () => {
  it("a live link to an Active client company = client with a company, whatever the portal level", () => {
    expect(classifyContact({ portalTier: "active", links: [live()] })).toBe("company")
    expect(classifyContact({ portalTier: null, links: [live()] })).toBe("company")
    expect(classifyContact({ portalTier: "lead", links: [live()] })).toBe("company")
  })
  it("one live Active company is enough, even next to a closed one", () => {
    expect(classifyContact({ portalTier: null, links: [live({ accountStatus: "Closed" }), live()] })).toBe("company")
  })
  it("any other link = past or one-time client: closed, cancelled, one-time, or a link that ended", () => {
    expect(classifyContact({ portalTier: "active", links: [live({ accountStatus: "Closed" })] })).toBe("past")
    expect(classifyContact({ portalTier: null, links: [live({ accountStatus: "Cancelled" })] })).toBe("past")
    expect(classifyContact({ portalTier: null, links: [live({ accountType: "One-Time" })] })).toBe("past")
    expect(classifyContact({ portalTier: null, links: [live({ ended: true })] })).toBe("past")
    expect(classifyContact({ portalTier: null, links: [live({ accountStatus: "Offboarding" })] })).toBe("past")
  })
  it("with no company the portal level decides", () => {
    expect(classifyContact({ portalTier: "lead", links: [] })).toBe("lead")
    expect(classifyContact({ portalTier: "active", links: [] })).toBe("individual")
    expect(classifyContact({ portalTier: "formation", links: [] })).toBe("individual")
    expect(classifyContact({ portalTier: "onboarding", links: [] })).toBe("other")
    expect(classifyContact({ portalTier: "something-new", links: [] })).toBe("other")
  })
  it("no company and no level = not sorted yet (blank and spaces count as none)", () => {
    expect(classifyContact({ portalTier: null, links: [] })).toBe("unsorted")
    expect(classifyContact({ portalTier: "", links: [] })).toBe("unsorted")
    expect(classifyContact({ portalTier: "  ", links: [] })).toBe("unsorted")
  })
  it("the level is read without case", () => {
    expect(classifyContact({ portalTier: "LEAD", links: [] })).toBe("lead")
  })
})

describe("partners", () => {
  it("a Banking Partner is a banker, every other partner is a partner", () => {
    expect(classifyPartner("Banking Partner")).toBe("banker")
    expect(classifyPartner("banking partner ")).toBe("banker")
    for (const t of ["Service Partner", "External Partner", "RA Provider", "", null, undefined]) expect(classifyPartner(t)).toBe("partner")
  })
})

describe("which kinds Antonio may give a type of his own", () => {
  it("only the two the CRM leaves open", () => {
    expect(CRM_KIND_IDS.filter(canRetype).sort()).toEqual(["other", "unsorted"])
  })
  it("every kind has words for its row and its chip", () => {
    for (const k of CRM_KIND_IDS) {
      expect(CRM_KIND_TEXT[k].row.length).toBeGreaterThan(2)
      expect(CRM_KIND_TEXT[k].chip.length).toBeGreaterThan(2)
    }
  })
})
