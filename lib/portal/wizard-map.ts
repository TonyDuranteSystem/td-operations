/**
 * P1.7 — Wizard-map single source of truth.
 *
 * Exported so the wizard-submit route, the wizard page, and the
 * characterization tests can import the same maps. Extracted to close a
 * class of bug documented in plan §4 P0.5 — ITIN wizard type was missing
 * from the submission-table map, so portal ITIN submissions silently
 * dropped for Damiano Mocellin (2026-04-13) and Antonio Truocchio
 * (2026-04-06) until a rescue.
 *
 * The exhaustiveness invariant (enforced by a test in P1.7): every
 * wizard type in `VALID_WIZARD_TYPES` must either have a row in
 * `SUBMISSION_TABLES` / `JOB_TYPES` or be in `BANKING_INLINE_TYPES`
 * (inline-handled in wizard-submit/route.ts step 4b).
 *
 * Changes here must be reviewed carefully — this is a schema-shaped
 * config, not mere code.
 */

/** All wizard_type values that the portal accepts from clients. */
export const VALID_WIZARD_TYPES = [
  "onboarding",
  "formation",
  "banking",
  "banking_payset",
  "banking_relay",
  "closure",
  "itin",
  "tax",
  "company_info",
] as const

export type WizardType = (typeof VALID_WIZARD_TYPES)[number]

export function isValidWizardType(type: string | undefined): type is WizardType {
  return VALID_WIZARD_TYPES.includes(type as WizardType)
}

/**
 * Wizard types handled inline by wizard-submit/route.ts step 4b (no
 * submission table row written; PDF + Drive + chat + task + SD advance
 * happen directly in the route). Exhaustiveness check counts these as
 * "covered".
 */
export const BANKING_INLINE_TYPES = ["banking_payset", "banking_relay"] as const

export type BankingInlineType = (typeof BANKING_INLINE_TYPES)[number]

export function isBankingInlineType(type: string): type is BankingInlineType {
  return BANKING_INLINE_TYPES.includes(type as BankingInlineType)
}

/**
 * Wizard types that exist in VALID_WIZARD_TYPES only as UI-layer
 * routes — they never POST to wizard-submit because the page renders a
 * picker / redirect instead of the form. Counted as "covered" by the
 * exhaustiveness check because the wizard-submit route is not on their
 * path.
 *
 * - 'banking': renders BankingPicker (app/portal/wizard/page.tsx:345),
 *   which redirects the user to banking_payset or banking_relay. No
 *   bare-'banking' POST happens.
 */
export const UI_ONLY_TYPES = ["banking"] as const

export type UIOnlyType = (typeof UI_ONLY_TYPES)[number]

export function isUIOnlyType(type: string): type is UIOnlyType {
  return UI_ONLY_TYPES.includes(type as UIOnlyType)
}

/**
 * wizard_type → submission table name. Null for types with no submission
 * table (must be in BANKING_INLINE_TYPES, UI_ONLY_TYPES, or the
 * wizard-submit route silently drops the submission).
 */
export const SUBMISSION_TABLES: Partial<Record<WizardType | "tax_return", string>> = {
  formation: "formation_submissions",
  onboarding: "onboarding_submissions",
  tax: "tax_return_submissions",
  // tax_return is an alias for tax accepted by callers that use the
  // service_type name instead of the wizard key.
  tax_return: "tax_return_submissions",
  company_info: "company_info_submissions",
  itin: "itin_submissions",
  // closure_submissions table exists but no closure-setup job handler is
  // wired up yet (plan §16.4: "Deferred to Phase 1 — 0 stuck closure
  // clients"). Covering the submission table stops the silent-drop class
  // of P0.5 bug; the background auto-chain follows in a later phase.
  closure: "closure_submissions",
}

export function getSubmissionTable(wizardType: string): string | null {
  return (
    SUBMISSION_TABLES[wizardType as keyof typeof SUBMISSION_TABLES] ?? null
  )
}

/**
 * wizard_type → job_type registered in lib/jobs/registry.ts. Null for
 * types with no background handler (must be inline-handled or skipped).
 */
export const JOB_TYPES: Partial<Record<WizardType | "tax_return", string>> = {
  formation: "formation_setup",
  onboarding: "onboarding_setup",
  tax: "tax_form_setup",
  tax_return: "tax_form_setup",
  company_info: "tax_return_intake",
  itin: "itin_wizard_setup",
}

export function getJobType(wizardType: string): string | null {
  return JOB_TYPES[wizardType as keyof typeof JOB_TYPES] ?? null
}

/**
 * Exhaustiveness predicate used by the characterization test. A wizard
 * type is "covered" when it has a submission-table row, is in the
 * banking-inline allowlist, or is a UI-only route that never reaches
 * wizard-submit. Anything uncovered would be silently dropped by
 * wizard-submit/route.ts — the class of bug the P0.5 ITIN fix
 * addressed.
 */
export function isWizardTypeCovered(type: string): boolean {
  return (
    isBankingInlineType(type) ||
    isUIOnlyType(type) ||
    getSubmissionTable(type) !== null
  )
}
