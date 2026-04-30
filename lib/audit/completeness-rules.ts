/**
 * Client completeness scoring — Phase 0 (diagnostic only, no DB writes).
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
 *   green  = everything present
 */

export type CompletenessStatus = 'red' | 'yellow' | 'green'

export type CompletenessResult = {
  status: CompletenessStatus
  missing_critical: string[]
  missing_warning: string[]
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
 * @param contact  Primary contact row, or null if no contact is linked.
 * @param activeServiceTypes  Non-cancelled service_type strings for this account.
 */
export function scoreContact(
  contact: ContactInput | null,
  activeServiceTypes: string[],
): CompletenessResult {
  // No contact linked at all — hard red regardless of services
  if (!contact) {
    return { status: 'red', missing_critical: ['No linked contact'], missing_warning: [] }
  }

  const critical: string[] = []
  const warning: string[] = []

  // Always required
  if (!contact.full_name || contact.full_name.trim() === '') critical.push('Full name')
  if (!contact.email) critical.push('Email')

  // Conditional on active services
  if (hasService(activeServiceTypes, CITIZENSHIP_DOB_SERVICES)) {
    if (!contact.citizenship) critical.push('Citizenship')
    if (!contact.date_of_birth) critical.push('Date of birth')
  }

  if (hasService(activeServiceTypes, ADDRESS_SERVICES)) {
    if (!contact.address_line1) critical.push('Address')
  }

  if (hasService(activeServiceTypes, PASSPORT_SERVICES)) {
    if (!contact.passport_on_file) critical.push('Passport on file')
  }

  // Always warning (nice-to-have, never blocks)
  if (!contact.itin_number) warning.push('ITIN')

  const status: CompletenessStatus =
    critical.length > 0 ? 'red' : warning.length > 0 ? 'yellow' : 'green'

  return { status, missing_critical: critical, missing_warning: warning }
}

/**
 * Score the account data completeness.
 *
 * Partner accounts return green with empty lists (not scored in Phase 0).
 * One-Time accounts apply lighter rules (EIN + start date are warnings only).
 *
 * @param account  Account row fields.
 * @param activeServiceTypes  Non-cancelled service_type strings for this account.
 */
export function scoreAccount(
  account: AccountInput,
  activeServiceTypes: string[],
): CompletenessResult {
  // Partner accounts are not scored in Phase 0
  if (account.account_type === 'Partner') {
    return { status: 'green', missing_critical: [], missing_warning: [] }
  }

  const critical: string[] = []
  const warning: string[] = []

  const isOneTime = account.account_type === 'One-Time'

  // Entity type — always critical (needed for all services)
  if (!account.entity_type) critical.push('Entity type')

  // State of formation — always critical
  if (!account.state_of_formation) critical.push('State of formation')

  // EIN — critical for standard clients, warning for one-time
  if (!account.ein_number) {
    if (isOneTime) {
      warning.push('EIN')
    } else {
      critical.push('EIN')
    }
  }

  // Start date (onboarding_date) — critical for standard, warning for one-time
  if (!account.onboarding_date) {
    if (isOneTime) {
      warning.push('Start date')
    } else {
      critical.push('Start date')
    }
  }

  // CMRA: physical address needed if CMRA service is active
  if (
    activeServiceTypes.includes('CMRA Mailing Address') &&
    !account.physical_address
  ) {
    warning.push('Physical address (CMRA active)')
  }

  const status: CompletenessStatus =
    critical.length > 0 ? 'red' : warning.length > 0 ? 'yellow' : 'green'

  return { status, missing_critical: critical, missing_warning: warning }
}

/**
 * Compute both Contact and Account completeness in one call.
 *
 * @param account  Account row fields.
 * @param primaryContact  Primary contact, or null if none linked.
 * @param activeServiceTypes  Non-cancelled service_type strings for this account.
 */
export function computeCompleteness(
  account: AccountInput,
  primaryContact: ContactInput | null,
  activeServiceTypes: string[],
): CompletenessScore {
  return {
    contact: scoreContact(primaryContact, activeServiceTypes),
    account: scoreAccount(account, activeServiceTypes),
  }
}
