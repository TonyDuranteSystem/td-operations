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

  it("a stray company_name on an individual member never wins over their real name (Donato Ciardo, 2026-09-01)", () => {
    // The wizard left a company_name value on an individual's entry (the
    // LLC's own name). Before the fix this silently replaced the member's
    // name, crediting the company itself with ownership and dropping the
    // real person from their own K-1.
    const out = extractWizardMembers({
      member_0_member_type: "individual",
      member_0_member_first_name: "Donato",
      member_0_member_last_name: "Ciardo",
      member_0_member_ownership_pct: 99,
      member_0_member_company_name: "Fast Consulting LLC",
      member_1_member_type: "individual",
      member_1_member_first_name: "Cristian",
      member_1_member_last_name: "Ciardo",
      member_1_member_ownership_pct: 1,
    })
    expect(out).toEqual([
      { name: "Donato Ciardo", pct: 99 },
      { name: "Cristian Ciardo", pct: 1 },
    ])
  })

  it("falls back to the legacy additional_members array when no flat member_N_ keys exist (PlayLover International LLC / Easy English LLC, 2026-09-01)", () => {
    // The standalone legacy tax form (app/tax-form/[token]) sends co-members
    // as an additional_members array instead of flat member_{idx}_ keys —
    // a shape this function's regex cannot match at all. Before this
    // fallback, every co-member from an account submitted this way was
    // silently absent from ownership, not merely misnamed.
    const out = extractWizardMembers({
      owner_first_name: "Christian",
      owner_last_name: "Pozza",
      additional_members: [
        { member_name: "Stefano Mozzicato", member_ownership_pct: "50", member_tax_residency: "Emirati Arabi Uniti" },
      ],
    })
    expect(out).toEqual([
      { name: "Christian Pozza", pct: null },
      { name: "Stefano Mozzicato", pct: 50 },
    ])
  })

  it("flat member_N_ keys win over additional_members when both are present", () => {
    const out = extractWizardMembers({
      owner_first_name: "Should", owner_last_name: "BeIgnored",
      member_0_member_first_name: "Sofia", member_0_member_last_name: "Marinoni", member_0_member_ownership_pct: 100,
      additional_members: [{ member_name: "Ghost Member", member_ownership_pct: "50" }],
    })
    expect(out).toEqual([{ name: "Sofia Marinoni", pct: 100 }])
  })

  it("empty additional_members array does not fabricate an owner-only entry that the caller can't distinguish from 'no data'", () => {
    expect(extractWizardMembers({ owner_first_name: "Solo", owner_last_name: "Owner", additional_members: [] })).toEqual([])
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
