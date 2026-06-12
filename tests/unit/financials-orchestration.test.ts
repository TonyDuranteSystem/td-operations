import { describe, it, expect } from "vitest"
import { extractWizardMembers, extractWizardOwner } from "@/lib/tax/financials-orchestration"

describe("extractWizardMembers", () => {
  it("groups flattened repeater keys into members, individuals and companies", () => {
    const out = extractWizardMembers({
      owner_first_name: "Donato", owner_last_name: "Berini",
      member_0_member_type: "individual",
      member_0_member_first_name: "Sofia",
      member_0_member_last_name: "Marinoni",
      member_0_member_ownership_pct: "60",
      member_1_member_type: "company",
      member_1_member_company_name: "Holding SRL",
      member_1_member_ownership_pct: 40,
      unrelated_field: "x",
    })
    expect(out).toEqual([
      { name: "Sofia Marinoni", pct: 60 },
      { name: "Holding SRL", pct: 40 },
    ])
  })

  it("missing or blank pct → null, blank names skipped, index order kept", () => {
    const out = extractWizardMembers({
      member_2_member_first_name: "Z", member_2_member_last_name: "Last", member_2_member_ownership_pct: "",
      member_0_member_first_name: "A", member_0_member_last_name: "First",
      member_1_member_first_name: " ", member_1_member_last_name: "",
    })
    expect(out).toEqual([
      { name: "A First", pct: null },
      { name: "Z Last", pct: null },
    ])
  })

  it("empty data → empty list", () => {
    expect(extractWizardMembers({})).toEqual([])
  })

  it("member_count is authoritative — orphaned keys above it (removed members) are ignored", () => {
    const out = extractWizardMembers({
      member_count: "1",
      member_0_member_first_name: "Sofia", member_0_member_last_name: "Marinoni", member_0_member_ownership_pct: 100,
      // leftovers from a removed member — must NOT become a partner
      member_1_member_first_name: "Ghost", member_1_member_last_name: "Member", member_1_member_ownership_pct: 50,
    })
    expect(out).toEqual([{ name: "Sofia Marinoni", pct: 100 }])
  })
})

describe("extractWizardOwner", () => {
  it("builds the owner with pct null (never inferred)", () => {
    expect(extractWizardOwner({ owner_first_name: "Donato", owner_last_name: "Berini" }))
      .toEqual({ name: "Donato Berini", pct: null })
    expect(extractWizardOwner({})).toBeNull()
  })
})
