import { describe, it, expect } from "vitest"
import { pickOaManagerName, membersMissingEmail } from "@/lib/oa/resolve-manager"

describe("pickOaManagerName", () => {
  it("uses the company's own manager when set", () => {
    expect(pickOaManagerName("Antonio Durante", "Giulia Schiavoni")).toBe("Antonio Durante")
  })
  it("falls back to the signer when blank, null or whitespace", () => {
    expect(pickOaManagerName(null, "Giulia Schiavoni")).toBe("Giulia Schiavoni")
    expect(pickOaManagerName(undefined, "Giulia Schiavoni")).toBe("Giulia Schiavoni")
    expect(pickOaManagerName("   ", "Giulia Schiavoni")).toBe("Giulia Schiavoni")
  })
  it("collapses inner spacing", () => {
    expect(pickOaManagerName("  Antonio   Durante ", "X")).toBe("Antonio Durante")
  })
})

describe("membersMissingEmail", () => {
  it("lists members with no email, using the right email field per shape", () => {
    expect(membersMissingEmail([
      { full_name: "Giulia", email: "g@x.com" },
      { full_name: "Caterina", email: "  " },
      { company_name: "Acme Ltd", email: null, representative_email: "rep@acme.com" },
      { company_name: "Beta Ltd", email: null, representative_email: null },
      { name: "Marco", member_email: null },
    ])).toEqual(["Caterina", "Beta Ltd", "Marco"])
  })
  it("returns nothing when everyone has an email", () => {
    expect(membersMissingEmail([{ full_name: "A", email: "a@x.com" }])).toEqual([])
  })
})
