/**
 * P1.7 characterization test — wizard-map exhaustiveness.
 *
 * Enforces the invariant called out in plan §4 P1.7:
 *   Every value in VALID_WIZARD_TYPES must either have a non-null
 *   getSubmissionTable mapping OR be in the banking-inline handler
 *   allowlist (BANKING_INLINE_TYPES).
 *
 * Would have caught the P0.5 ITIN drop bug (Damiano Mocellin 2026-04-13,
 * Antonio Truocchio 2026-04-06) where `itin` was in VALID_WIZARD_TYPES
 * but missing from the submission-table map, causing wizard-submit to
 * silently drop the payload.
 *
 * Plus a focused test on the job-type map: every type with a submission
 * table also needs a job_type mapping or the background auto-chain
 * doesn't run.
 */

import { describe, it, expect } from "vitest"
import {
  VALID_WIZARD_TYPES,
  BANKING_INLINE_TYPES,
  UI_ONLY_TYPES,
  SUBMISSION_TABLES,
  JOB_TYPES,
  getSubmissionTable,
  getJobType,
  isBankingInlineType,
  isUIOnlyType,
  isValidWizardType,
  isWizardTypeCovered,
} from "@/lib/portal/wizard-map"

describe("wizard-map — exhaustiveness", () => {
  it("every VALID_WIZARD_TYPES entry is covered by a submission table or banking-inline handler", () => {
    const uncovered = VALID_WIZARD_TYPES.filter((t) => !isWizardTypeCovered(t))
    // The single assertion that would have caught the P0.5 bug:
    expect(uncovered, `Uncovered wizard types would silently drop: ${uncovered.join(", ")}`).toEqual([])
  })

  it("job_type map covers every wizard type except known manual-workflow types", () => {
    // Once a submission row exists, a background handler is the norm.
    // Exception: closure (plan §16.4 — deferred; submissions land in
    // closure_submissions and Luca handles them manually). When a
    // closure-setup handler lands, remove 'closure' from this allowlist.
    const KNOWN_MANUAL_TYPES = new Set(["closure"])
    const withoutJob = VALID_WIZARD_TYPES.filter(
      (t) =>
        getSubmissionTable(t) !== null &&
        getJobType(t) === null &&
        !KNOWN_MANUAL_TYPES.has(t),
    )
    expect(
      withoutJob,
      `Wizard types with submission table but no job_type: ${withoutJob.join(", ")}`,
    ).toEqual([])
  })

  it("isValidWizardType returns true for every VALID_WIZARD_TYPES value", () => {
    for (const t of VALID_WIZARD_TYPES) {
      expect(isValidWizardType(t)).toBe(true)
    }
  })

  it("isValidWizardType returns false for unknown types", () => {
    expect(isValidWizardType("unknown")).toBe(false)
    expect(isValidWizardType("")).toBe(false)
    expect(isValidWizardType(undefined)).toBe(false)
  })

  it("isBankingInlineType matches only the banking_* variants", () => {
    expect(isBankingInlineType("banking_payset")).toBe(true)
    expect(isBankingInlineType("banking_relay")).toBe(true)
    expect(isBankingInlineType("banking")).toBe(false) // bare 'banking' is UI-only, not inline
    expect(isBankingInlineType("formation")).toBe(false)
  })

  it("isUIOnlyType matches the UI-picker routes", () => {
    expect(isUIOnlyType("banking")).toBe(true)
    expect(isUIOnlyType("banking_payset")).toBe(false)
    expect(isUIOnlyType("formation")).toBe(false)
  })

  it("getSubmissionTable returns null for uncovered types (regression guard)", () => {
    // Synthetic: simulate adding a new wizard type without updating the
    // submission-table map. isWizardTypeCovered should catch it.
    const synthetic = "newwizard_not_in_maps"
    expect(getSubmissionTable(synthetic)).toBe(null)
    expect(getJobType(synthetic)).toBe(null)
    expect(isWizardTypeCovered(synthetic)).toBe(false)
  })
})

describe("wizard-map — known mappings", () => {
  it("maps every non-banking type to its expected submission table", () => {
    // Characterization: locks in the current expected mappings so a
    // refactor cannot silently rename a table.
    expect(SUBMISSION_TABLES).toMatchObject({
      formation: "formation_submissions",
      onboarding: "onboarding_submissions",
      tax: "tax_return_submissions",
      tax_return: "tax_return_submissions",
      company_info: "company_info_submissions",
      itin: "itin_submissions",
      closure: "closure_submissions",
    })
  })

  it("UI-only allowlist contains exactly the banking picker", () => {
    expect([...UI_ONLY_TYPES]).toEqual(["banking"])
  })

  it("maps every non-banking type to its expected job_type", () => {
    expect(JOB_TYPES).toMatchObject({
      formation: "formation_setup",
      onboarding: "onboarding_setup",
      tax: "tax_form_setup",
      tax_return: "tax_form_setup",
      company_info: "tax_return_intake",
      itin: "itin_wizard_setup",
    })
  })

  it("banking-inline allowlist contains exactly banking_payset + banking_relay", () => {
    expect([...BANKING_INLINE_TYPES]).toEqual(["banking_payset", "banking_relay"])
  })
})
