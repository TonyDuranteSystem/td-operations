import { describe, it, expect } from "vitest"
import { extractWizardMembers, extractWizardOwner, extractWizardMemberResidences } from "@/lib/tax/financials-orchestration"

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

describe("extractWizardMemberResidences", () => {
  it("individual member: residence_country carried raw, index order kept", () => {
    const out = extractWizardMemberResidences({
      member_0_member_type: "individual",
      member_0_member_first_name: "Sofia",
      member_0_member_residence_country: "Italy",
      member_0_member_ownership_pct: "60",
      member_1_member_type: "individual",
      member_1_member_first_name: "Marco",
      member_1_member_residence_country: "United Arab Emirates",
      member_1_member_ownership_pct: 40,
    })
    expect(out).toEqual([
      { pct: 60, residenceCountry: "Italy" },
      { pct: 40, residenceCountry: "United Arab Emirates" },
    ])
  })

  it("company member: residenceCountry is always null, even if the key is somehow present", () => {
    const out = extractWizardMemberResidences({
      member_0_member_type: "company",
      member_0_member_company_name: "Holding SRL",
      member_0_member_ownership_pct: 100,
      // member_company_country is the company's REGISTRATION jurisdiction, not
      // a residence fact — must never leak into residenceCountry even if a
      // stray residence_country key were present on a company row.
      member_0_member_residence_country: "Italy",
    })
    expect(out).toEqual([{ pct: 100, residenceCountry: null }])
  })

  it("missing residence_country → null; missing/blank pct → null", () => {
    const out = extractWizardMemberResidences({
      member_0_member_type: "individual",
      member_0_member_ownership_pct: "",
    })
    expect(out).toEqual([{ pct: null, residenceCountry: null }])
  })

  it("empty data → empty list", () => {
    expect(extractWizardMemberResidences({})).toEqual([])
  })

  it("member_count is authoritative — orphaned keys above it are ignored", () => {
    const out = extractWizardMemberResidences({
      member_count: "1",
      member_0_member_type: "individual", member_0_member_residence_country: "Italy", member_0_member_ownership_pct: 100,
      member_1_member_type: "individual", member_1_member_residence_country: "Spain", member_1_member_ownership_pct: 50,
    })
    expect(out).toEqual([{ pct: 100, residenceCountry: "Italy" }])
  })
})
