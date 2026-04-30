/**
 * Client completeness scoring — Phase 0 + Phase 1.
 *
 * Pure logic: no DB calls, no imports, no side effects.
 * All service_type strings verified from live DB 2026-04-29.
 *
 * Three-level model:
 *   Contact baseline — person, confirmed once, shared across all accounts.
 *   Account baseline — company, confirmed per company.
 *   (Service baseline is Phase 4 — not in scope here.)
 *
 * Scoring:
 *   red    = one or more critical fields missing
 *   yellow = all critical present, one or more warnings
 *   green  = everything present (N/A fields count as present)
 *
 * Phase 1 — flag-aware scoring:
 *   ActiveFlag[]  optional — DB column names for active audit_flags rows.
 *   Precedence:   field present > N/A flag > field absent.
 *   N/A flag:     field treated as complete; added to na_fields, not missing_critical.
 *   Follow-up:    tracked in followup_fields; never affects dot color.
 */

export type CompletenessStatus = 'red' | 'yellow' | 'green'

/** Minimal flag shape needed by the scoring engine (pre-filtered to this entity). */
export type ActiveFlag = {
  field_name: string
  flag_type: 'na' | 'follow_up'
}

export type CompletenessResult = {
  status: CompletenessStatus
  missing_critical: string[]
  missing_warning: string[]
  /** DB field names that are absent but marked N/A — dot stays green. Phase 1. */
  na_fields: string[]
  /** DB field names with a follow_up flag — panel indicator only, no color change. Phase 1. */
  followup_fields: string[]
}

export type CompletenessScore = {
  contact: CompletenessResult
  account: CompletenessResult
}

// ── Service type trigger lists (exact strings from DB) ─────────────────────

/** Services that require citizenship + date of birth to be on file. */
const CITIZENSHIP_DOB_SERVICES: readonly string[] = [
  'Company Formation',
  'Client Onboarding',
  'ITIN',
  'Banking Fintech',
  'Tax Return',
]

/** Services that require a personal address to be on file. */
const ADDRESS_SERVICES: readonly string[] = [
  'Company Formation',
  'Client Onboarding',
  'Banking Fintech',
  'CMRA Mailing Address',
]

/** Services that require passport_on_file = true. */
const PASSPORT_SERVICES: readonly string[] = [
  'ITIN',
  'Banking Fintech',
]

function hasService(active: string[], triggers: readonly string[]): boolean {
  return active.some(t => triggers.includes(t))
}

// ── Input types ────────────────────────────────────────────────────────────

/**
 * Minimal contact fields needed for scoring.
 * Maps to the `contacts` table columns (itin_number is canonical — 59 live rows).
 */
export type ContactInput = {
  full_name: string | null
  email: string | null
  itin_number: string | null
  citizenship: string | null
  date_of_birth: string | null
  passport_on_file: boolean | null
  address_line1: string | null
}

/**
 * Minimal account fields needed for scoring.
 * Maps to the `accounts` table columns.
 */
export type AccountInput = {
  entity_type: string | null
  ein_number: string | null
  state_of_formation: string | null
  physical_address: string | null
  onboarding_date: string | null
  account_type: string | null
}

// ── Scoring functions ──────────────────────────────────────────────────────

/**
 * Score the primary contact for an account.
 *
 * @param contact             Primary contact row, or null if no contact is linked.
 * @param activeServiceTypes  Non-cancelled service_type strings for this account.
 * @param flags               Active audit_flags for this contact entity (Phase 1).
 *                            Defaults to [] — fully backward compatible.
 */
export function scoreContact(
  contact: ContactInput | null,
  activeServiceTypes: string[],
  flags: ActiveFlag[] = [],
): CompletenessResult {
  // No contact linked at all — hard red regardless of services or flags
  if (!contact) {
    return {
      status: 'red',
      missing_critical: ['No linked contact'],
      missing_warning: [],
      na_fields: [],
      followup_fields: [],
    }
  }

  const critical: string[] = []
  const warning: string[] = []
  const na_fields: string[] = []

  function hasNA(fieldName: string): boolean {
    return flags.some(f => f.field_name === fieldName && f.flag_type === 'na')
  }

  // Always required — NEVER eligible for N/A (critical fields, no service condition)
  if (!contact.full_name || contact.full_name.trim() === '') critical.push('Full name')
  if (!contact.email) critical.push('Email')

  // Conditional on active services — eligible for N/A when service not active
  if (hasService(activeServiceTypes, CITIZENSHIP_DOB_SERVICES)) {
    if (!contact.citizenship) {
      if (hasNA('citizenship')) na_fields.push('citizenship')
      else critical.push('Citizenship')
    }
    if (!contact.date_of_birth) {
      if (hasNA('date_of_birth')) na_fields.push('date_of_birth')
      else critical.push('Date of birth')
    }
  }

  if (hasService(activeServiceTypes, ADDRESS_SERVICES)) {
    if (!contact.address_line1) {
      if (hasNA('address_line1')) na_fields.push('address_line1')
      else critical.push('Address')
    }
  }

  if (hasService(activeServiceTypes, PASSPORT_SERVICES)) {
    if (!contact.passport_on_file) {
      if (hasNA('passport_on_file')) na_fields.push('passport_on_file')
      else critical.push('Passport on file')
    }
  }

  // Warning-only field — always eligible for N/A
  if (!contact.itin_number) {
    if (hasNA('itin_number')) na_fields.push('itin_number')
    else warning.push('ITIN')
  }

  // Follow-up flags — tracked regardless of field presence; never affect dot color
  const followup_fields = flags
    .filter(f => f.flag_type === 'follow_up')
    .map(f => f.field_name)

  const status: CompletenessStatus =
    critical.length > 0 ? 'red' : warning.length > 0 ? 'yellow' : 'green'

  return { status, missing_critical: critical, missing_warning: warning, na_fields, followup_fields }
}

/**
 * Score the account data completeness.
 *
 * Partner accounts return green with empty lists (not scored).
 * One-Time accounts apply lighter rules (EIN + start date are warnings only).
 *
 * @param account             Account row fields.
 * @param activeServiceTypes  Non-cancelled service_type strings for this account.
 * @param flags               Active audit_flags for this account entity (Phase 1).
 *                            Defaults to [] — fully backward compatible.
 */
export function scoreAccount(
  account: AccountInput,
  activeServiceTypes: string[],
  flags: ActiveFlag[] = [],
): CompletenessResult {
  // Partner accounts are not scored
  if (account.account_type === 'Partner') {
    return {
      status: 'green',
      missing_critical: [],
      missing_warning: [],
      na_fields: [],
      followup_fields: [],
    }
  }

  const critical: string[] = []
  const warning: string[] = []
  const na_fields: string[] = []

  const isOneTime = account.account_type === 'One-Time'

  function hasNA(fieldName: string): boolean {
    return flags.some(f => f.field_name === fieldName && f.flag_type === 'na')
  }

  // Entity type — always critical, NEVER eligible for N/A
  if (!account.entity_type) critical.push('Entity type')

  // State of formation — always critical, NEVER eligible for N/A
  if (!account.state_of_formation) critical.push('State of formation')

  // EIN — eligible for N/A (formations in progress, migrated data)
  if (!account.ein_number) {
    if (hasNA('ein_number')) {
      na_fields.push('ein_number')
    } else if (isOneTime) {
      warning.push('EIN')
    } else {
      critical.push('EIN')
    }
  }

  // Start date — eligible for N/A (migrated data — date genuinely unknown)
  if (!account.onboarding_date) {
    if (hasNA('onboarding_date')) {
      na_fields.push('onboarding_date')
    } else if (isOneTime) {
      warning.push('Start date')
    } else {
      critical.push('Start date')
    }
  }

  // CMRA: physical address needed if CMRA service is active — eligible for N/A
  if (
    activeServiceTypes.includes('CMRA Mailing Address') &&
    !account.physical_address
  ) {
    if (hasNA('physical_address')) na_fields.push('physical_address')
    else warning.push('Physical address (CMRA active)')
  }

  // Follow-up flags — tracked regardless of field presence; never affect dot color
  const followup_fields = flags
    .filter(f => f.flag_type === 'follow_up')
    .map(f => f.field_name)

  const status: CompletenessStatus =
    critical.length > 0 ? 'red' : warning.length > 0 ? 'yellow' : 'green'

  return { status, missing_critical: critical, missing_warning: warning, na_fields, followup_fields }
}

/**
 * Compute both Contact and Account completeness in one call.
 *
 * @param account             Account row fields.
 * @param primaryContact      Primary contact, or null if none linked.
 * @param activeServiceTypes  Non-cancelled service_type strings for this account.
 * @param contactFlags        Active audit_flags for the primary contact (Phase 1). Optional.
 * @param accountFlags        Active audit_flags for the account (Phase 1). Optional.
 */
export function computeCompleteness(
  account: AccountInput,
  primaryContact: ContactInput | null,
  activeServiceTypes: string[],
  contactFlags: ActiveFlag[] = [],
  accountFlags: ActiveFlag[] = [],
): CompletenessScore {
  return {
    contact: scoreContact(primaryContact, activeServiceTypes, contactFlags),
    account: scoreAccount(account, activeServiceTypes, accountFlags),
  }
}
