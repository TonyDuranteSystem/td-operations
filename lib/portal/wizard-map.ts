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
  "td_communication",
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
 * TD Communication brand-audit wizard — handled inline by
 * wizard-submit/route.ts (no submission table, no background job). The
 * canonical record is the `td_comm_enrollments` row, which the inline
 * branch finds/creates, fills with `form_data`, advances to
 * `form_submitted`, and announces in the project's collaboration chat.
 * Counted as "covered" by the exhaustiveness check (same role as
 * BANKING_INLINE_TYPES). Kept separate from banking so each allowlist
 * stays an exact, independently-asserted set.
 */
export const TD_COMM_INLINE_TYPES = ["td_communication"] as const

export type TdCommInlineType = (typeof TD_COMM_INLINE_TYPES)[number]

export function isTdCommInlineType(type: string): type is TdCommInlineType {
  return TD_COMM_INLINE_TYPES.includes(type as TdCommInlineType)
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
 * Wizard types owned by the BUYER (contact), not the company.
 *
 * Per the formation architecture (Antonio, 2026-05-03/04, sysdoc
 * 'ops-2026-05-03-formation-architecture-decision-and-plan'): a formation is
 * purchased by an individual before any company exists, so its wizard_progress
 * and submission live on the contact and NEVER migrate to the account — even
 * after the company is materialized (materialization sets account_id on the
 * service delivery, not on wizard_progress). When NOT scoped to a specific
 * new-company lead (PR #75's ?lead= flow), the portal must look these up by
 * contact_id, not account_id. Otherwise, the moment a contact gains a linked
 * account the portal stops finding the formation and re-offers it, creating a
 * duplicate (Lorenzo Cannas, dev_task 21fd1f4a).
 *
 * Account-owned wizards (onboarding, banking, tax, closure, company_info) stay
 * account-scoped — they belong to the company.
 */
export const CONTACT_SCOPED_WIZARD_TYPES = ["formation"] as const

export type ContactScopedWizardType = (typeof CONTACT_SCOPED_WIZARD_TYPES)[number]

export function isContactScopedWizard(type: string | undefined): boolean {
  return CONTACT_SCOPED_WIZARD_TYPES.includes(type as ContactScopedWizardType)
}

/**
 * Wizard types that can run EITHER contact-scoped OR account-scoped, depending
 * on whether the SD has an account_id.
 *
 * Closure (today): a contact may be closing their own managed LLC (SD has
 * account_id set) OR an external LLC that isn't in the CRM as an account
 * (SD has account_id null — Patrick Covelli's Delaware LLC pattern). Both
 * must surface in the portal regardless of whether the contact also has a
 * managed account on file.
 *
 * Unlike CONTACT_SCOPED_WIZARD_TYPES, flexible types do NOT change the
 * wizard_progress lookup precedence (resolveWizardProgressScope) — those
 * routes still prefer account_id when set, contact_id otherwise. Flexible
 * only matters for SD-driven DISCOVERY: the wizard page and the
 * "Complete Setup" visibility check must also query contact-scoped SDs of
 * these types even when the contact has an accountId.
 */
export const FLEXIBLE_WIZARD_TYPES = ["closure"] as const

export type FlexibleWizardType = (typeof FLEXIBLE_WIZARD_TYPES)[number]

export function isFlexibleWizardType(type: string | undefined): boolean {
  return FLEXIBLE_WIZARD_TYPES.includes(type as FlexibleWizardType)
}

/**
 * Maps each flexible wizard type to the service_type values used on
 * service_deliveries.service_type for SDs of that wizard. Used by the
 * portal's flexible-SD lookup to filter contact-scoped service_deliveries
 * to the types that matter.
 */
export const FLEXIBLE_SERVICE_TYPES_BY_WIZARD: Record<FlexibleWizardType, readonly string[]> = {
  closure: ["Company Closure"],
} as const

export function getFlexibleServiceTypes(): string[] {
  return Object.values(FLEXIBLE_SERVICE_TYPES_BY_WIZARD).flatMap((arr) => [...arr])
}

/**
 * Wizard types for a service that belongs to the PERSON, never the company.
 *
 * ITIN is the case: an ITIN is issued to an individual, is one-per-person for
 * life, and is sold standalone as often as it is bundled with a formation. The
 * write side already encodes this — `createSD` (lib/operations/service-delivery.ts)
 * strips `account_id` from every ITIN service delivery, "the ITIN belongs to the
 * person, not the company". This map is the READ side of that same rule, so the
 * portal looks where the writer actually put the row.
 *
 * Distinct from CONTACT_SCOPED_WIZARD_TYPES (formation), which is about an
 * entity that does not exist yet and is routed by the ?lead= switcher. A
 * person-owned wizard has no lead dimension — see resolveWizardProgressScope,
 * which must NOT inherit formation's `restrictToNoLead`.
 *
 * Distinct from FLEXIBLE_WIZARD_TYPES (closure), which genuinely runs EITHER
 * scope depending on the SD. ITIN has no such duality: it is always the person.
 *
 * NOT included: "ITIN Renewal". `createSD` forces contact scope for
 * `service_type === "ITIN"` exactly, so a renewal SD keeps its account_id
 * (pinned by tests/unit/operations-service-delivery.test.ts). Listing it here
 * would discover nothing (the discovery query filters account_id IS NULL) and
 * would route renewal clients into the ITIN-application chain. Bringing
 * renewals onto this rail is a separate, deliberate change.
 */
export const PERSON_OWNED_WIZARD_TYPES = ["itin"] as const

export type PersonOwnedWizardType = (typeof PERSON_OWNED_WIZARD_TYPES)[number]

export function isPersonOwnedWizard(type: string | undefined): boolean {
  return PERSON_OWNED_WIZARD_TYPES.includes(type as PersonOwnedWizardType)
}

export const PERSON_OWNED_SERVICE_TYPES_BY_WIZARD: Record<PersonOwnedWizardType, readonly string[]> = {
  itin: ["ITIN"],
} as const

export function getPersonOwnedServiceTypes(): string[] {
  return Object.values(PERSON_OWNED_SERVICE_TYPES_BY_WIZARD).flatMap((arr) => [...arr])
}

/**
 * Service types whose CONTACT-SCOPED service deliveries must be discovered even
 * when the client also owns an account: flexible (closure) ∪ person-owned (ITIN).
 *
 * Both portal discovery surfaces read this one accessor — the wizard page and
 * the sidebar "Complete Setup" visibility check — so they cannot drift apart
 * again (they already had, differing in row limit and status filter).
 *
 * Company Formation is deliberately absent: it is selected by the company
 * switcher / ?lead= flow, and surfacing it here would leak a second company's
 * formation into the portal of a client operating a different company (the
 * bb54680b class, prevented identically in lib/portal/queries.ts).
 */
export function getContactScopedDiscoveryServiceTypes(): string[] {
  return [...getFlexibleServiceTypes(), ...getPersonOwnedServiceTypes()]
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
 * banking-inline allowlist, is in the TD-Communication inline allowlist,
 * or is a UI-only route that never reaches wizard-submit. Anything
 * uncovered would be silently dropped by wizard-submit/route.ts — the
 * class of bug the P0.5 ITIN fix addressed.
 */
export function isWizardTypeCovered(type: string): boolean {
  return (
    isBankingInlineType(type) ||
    isTdCommInlineType(type) ||
    isUIOnlyType(type) ||
    getSubmissionTable(type) !== null
  )
}
