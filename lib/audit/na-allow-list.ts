/**
 * N/A eligibility allow-list — Phase 1.
 *
 * Determines whether a given field on an account or contact is eligible for
 * an N/A flag given the currently-active service_deliveries.
 *
 * Rules (confirmed by Antonio 2026-04-30):
 *   1. Critical fields with no service condition are NEVER eligible for N/A.
 *      Contact: email, full_name
 *      Account: entity_type, state_of_formation
 *   2. Fields that are conditional on active services are eligible for N/A
 *      only when none of those services are active.
 *   3. Warning-only fields are always eligible for N/A.
 *
 * Service-type strings match completeness-rules.ts exactly (verified from DB).
 */

// ── Service trigger lists (shared with completeness-rules.ts semantics) ────

/** Services that make citizenship + DOB required. */
const CITIZENSHIP_DOB_SERVICES: readonly string[] = [
  'Company Formation',
  'Client Onboarding',
  'ITIN',
  'Banking Fintech',
  'Tax Return',
]

/** Services that make personal address required. */
const ADDRESS_SERVICES: readonly string[] = [
  'Company Formation',
  'Client Onboarding',
  'Banking Fintech',
  'CMRA Mailing Address',
]

/** Services that make passport_on_file required. */
const PASSPORT_SERVICES: readonly string[] = [
  'ITIN',
  'Banking Fintech',
]

function hasService(active: string[], triggers: readonly string[]): boolean {
  return active.some(t => triggers.includes(t))
}

// ── Critical fields that can NEVER be marked N/A ──────────────────────────

const CONTACT_CRITICAL_NEVER_NA = new Set(['email', 'full_name'])
const ACCOUNT_CRITICAL_NEVER_NA = new Set(['entity_type', 'state_of_formation'])

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Returns true if the given field on the given entity type is eligible for
 * an N/A flag, given the currently-active service_deliveries.
 *
 * Phase 1 covers entity_type values 'account' and 'contact' only.
 * Service-level N/A eligibility is Phase 4.
 *
 * @param fieldName         DB column name (e.g. 'citizenship', 'ein_number')
 * @param entityType        'account' | 'contact'
 * @param activeServices    Non-cancelled service_type strings for this account
 */
export function isFieldEligibleForNA(
  fieldName: string,
  entityType: 'account' | 'contact' | 'service',
  activeServices: string[],
): boolean {
  if (entityType === 'contact') {
    // Never eligible
    if (CONTACT_CRITICAL_NEVER_NA.has(fieldName)) return false

    // Conditional on active services
    if (fieldName === 'citizenship' || fieldName === 'date_of_birth') {
      return !hasService(activeServices, CITIZENSHIP_DOB_SERVICES)
    }
    if (fieldName === 'address_line1') {
      return !hasService(activeServices, ADDRESS_SERVICES)
    }
    if (fieldName === 'passport_on_file') {
      return !hasService(activeServices, PASSPORT_SERVICES)
    }

    // Warning-only fields — always eligible
    if (fieldName === 'itin_number') return true

    // Unknown contact field — not eligible by default
    return false
  }

  if (entityType === 'account') {
    // Never eligible
    if (ACCOUNT_CRITICAL_NEVER_NA.has(fieldName)) return false

    // Always eligible for account (migrated data — these may genuinely be unknown)
    if (fieldName === 'ein_number') return true
    if (fieldName === 'onboarding_date') return true

    // CMRA-conditional
    if (fieldName === 'physical_address') {
      // If CMRA is active, address is required (warning) — allow N/A even then
      // since the N/A should explain the missing address situation
      return true
    }

    // Unknown account field — not eligible by default
    return false
  }

  // Service-level N/A: Phase 4 scope — not eligible in Phase 1
  return false
}
