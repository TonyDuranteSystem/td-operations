/**
 * Single source of truth for the Company Formation pipeline stage names and the
 * `auto_actions` markers that drive its stage-triggered side effects.
 *
 * The 8-stage Company Formation pipeline lives in `pipeline_stages` (migration
 * 20260617-formation-workspace.sql). Code that must reference a specific stage
 * by name imports from here so a future rename touches ONE file, never a scatter
 * of string literals (the trap that broke the old 6-stage rename).
 *
 * Stage-triggered business side effects (compliance-date init, welcome-package
 * enqueue) are NOT gated on a hardcoded stage name — they fire when the stage
 * the SD advances into carries the matching `auto_actions` marker. That makes
 * the trigger stage editable in SQL (see lib/services/stage-actions.ts).
 */

export const FORMATION_SERVICE_TYPE = 'Company Formation'

/** The 8 Company Formation stages, by stage_order. */
export const FORMATION_STAGES = {
  PAYMENT_CONFIRMED: 'Payment Confirmed',
  WIZARD_SUBMITTED: 'Wizard Submitted',
  NAME_CHECK: 'Name Check',
  FILING_WITH_STATE: 'Filing with State',
  ARTICLES_RECEIVED: 'Articles Received',
  SS4_PREPARED: 'SS-4 Prepared',
  SS4_SIGNED: 'SS-4 Signed',
  EIN_RECEIVED: 'EIN Received',
} as const

export type FormationStageName = (typeof FORMATION_STAGES)[keyof typeof FORMATION_STAGES]

/**
 * `auto_actions` marker types (on a `pipeline_stages` row) that gate the
 * Company Formation stage side effects — both set on "Articles Received" today.
 * Consumed in lib/service-delivery.ts via stageHasAction(); set in the migration.
 */
export const INIT_COMPLIANCE_DATES_ACTION = 'init_compliance_dates'
export const ENQUEUE_WELCOME_PACKAGE_ACTION = 'enqueue_welcome_package'
