import { describe, it, expect } from "vitest"
import {
  isExcludedFieldName,
  isExcludedWarningFieldName,
  EXCLUDED_WIZARD_FIELD_NAMES,
  EXCLUDED_WIZARD_WARNING_FIELD_NAMES,
  EXCLUDED_MODULES,
  EXCLUDED_COMPONENT_TEXT,
} from "@/lib/portal/translation-exclusions"
import { FORMATION_FIELDS, TAX_MMLLC_FIELDS } from "@/components/portal/wizard/wizard-configs"

describe("isExcludedFieldName", () => {
  it("excludes every name found by the 2026-08-21 legal review", () => {
    expect(isExcludedFieldName("disclaimer_accepted")).toBe(true)
    expect(isExcludedFieldName("prior_never_filed_declaration")).toBe(true)
  })

  it("does not exclude an ordinary field name", () => {
    expect(isExcludedFieldName("first_name")).toBe(false)
    expect(isExcludedFieldName("company_name")).toBe(false)
  })
})

describe("isExcludedWarningFieldName", () => {
  it("excludes the $25,000-penalty warning field", () => {
    expect(isExcludedWarningFieldName("has_related_party_transactions")).toBe(true)
  })

  it("does not exclude an unrelated field", () => {
    expect(isExcludedWarningFieldName("email")).toBe(false)
  })
})

describe("registry stays honest against the real wizard config — regression guard", () => {
  it("'disclaimer_accepted' is still a real field name in the live wizard configs (catches a future rename silently orphaning the exclusion)", () => {
    const formationHasIt = FORMATION_FIELDS.documents.some(f => f.name === "disclaimer_accepted")
    expect(formationHasIt).toBe(true)
  })

  it("'prior_never_filed_declaration' is still a real field name in the live tax wizard config", () => {
    const hasIt = TAX_MMLLC_FIELDS.documents.some(f => f.name === "prior_never_filed_declaration")
    expect(hasIt).toBe(true)
  })

  it("every field named in EXCLUDED_WIZARD_FIELD_NAMES/WARNING is actually excluded by the helper functions (no typo in the registry itself)", () => {
    for (const name of EXCLUDED_WIZARD_FIELD_NAMES) expect(isExcludedFieldName(name)).toBe(true)
    for (const name of EXCLUDED_WIZARD_WARNING_FIELD_NAMES) expect(isExcludedWarningFieldName(name)).toBe(true)
  })
})

describe("module and component exclusions", () => {
  it("lists both hash-versioned legal-text modules", () => {
    expect(EXCLUDED_MODULES).toContain("lib/td-communication/disclaimer.ts")
    expect(EXCLUDED_MODULES).toContain("lib/td-communication/showcase-consent.ts")
  })

  it("lists both flagged component-level attestations", () => {
    const files = EXCLUDED_COMPONENT_TEXT.map(e => e.file)
    expect(files).toContain("components/portal/tax-financials-review.tsx")
    expect(files).toContain("components/portal/team-manager.tsx")
  })
})
