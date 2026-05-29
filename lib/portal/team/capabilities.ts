/**
 * Portal Team Access — capability model.
 *
 * Capabilities are owner-chosen, per-section flags stored on
 * `portal_team_members.capabilities` (JSONB). They are enforced SERVER-SIDE and
 * are DEFAULT-DENY: a capability the owner did not explicitly grant (true) is
 * treated as denied.
 *
 * Two things are NEVER capabilities (non-delegable, owner/admin only):
 *   - signing legal documents (teammates may VIEW under `documents`, never sign)
 *   - managing the team itself (invite/edit/revoke)
 *
 * Adding a new grantable section later = add its key here + map it to routes.
 * No schema change required (the column is JSONB).
 *
 * Design: sysdoc 'portal-team-access-design'.
 */

export const TEAM_CAPABILITIES = [
  'documents',          // view documents incl. legal docs (OA/SS4/8832/MSA/lease) — VIEW only, never sign
  'invoices_billing',   // sales invoices + TD billing
  'chat',               // portal chat for the company
  'company_services',   // company profile + services/deadlines status
  'bank_applications',  // bank application flow
  'sales_customers',    // the client's own sales customers list (owner-grantable extra)
  'company_data_form',  // formation/onboarding company data form (owner-grantable extra)
  'announcements',      // portal announcements/notifications (owner-grantable extra)
] as const

export type TeamCapability = (typeof TEAM_CAPABILITIES)[number]

export type CapabilityFlags = Partial<Record<TeamCapability, boolean>>

const CAPABILITY_SET = new Set<string>(TEAM_CAPABILITIES)

/**
 * Sanitize arbitrary JSONB into a clean CapabilityFlags: only known keys,
 * only true values retained. Unknown keys and non-true values are dropped
 * (default-deny). Safe to call on untrusted DB content.
 */
export function normalizeCapabilities(input: unknown): CapabilityFlags {
  const out: CapabilityFlags = {}
  if (!input || typeof input !== 'object') return out
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (CAPABILITY_SET.has(key) && value === true) {
      out[key as TeamCapability] = true
    }
  }
  return out
}

/**
 * Default-deny capability check. Returns true ONLY when the flag is explicitly true.
 */
export function hasCapability(
  flags: CapabilityFlags | null | undefined,
  capability: TeamCapability,
): boolean {
  return !!flags && flags[capability] === true
}
