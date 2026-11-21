/**
 * Which company an activity-record line written from the browser is filed under.
 *
 * POST /api/portal/audit used to file the line under whatever account_id the browser sent, so any signed-in
 * login could write lines into ANY company's activity record (a team login too — it has no contact, so the
 * route's own fallback gave it no company at all). Now the company must be one the login actually belongs to.
 * PURE, so it is unit-tested without a database.
 */
import type { PortalIdentity } from '@/lib/portal/resolve-portal-identity'

const MAX_ID_LENGTH = 64

function asId(requested: unknown): string | undefined {
  return typeof requested === 'string' && requested.length > 0 && requested.length <= MAX_ID_LENGTH ? requested : undefined
}

/**
 * @param isStaff true for a non-client login (an admin looking at the portal) — kept as before: it may name any company.
 * @returns the company to file the line under, or undefined (file it with no company) — never a company the login is not part of.
 */
export function auditAccountIdFor(identity: PortalIdentity, requested: unknown, isStaff: boolean): string | undefined {
  const wanted = asId(requested)
  if (identity.kind === 'contact') {
    if (wanted && identity.accountIds.includes(wanted)) return wanted
    return identity.accountIds[0] || undefined
  }
  if (identity.kind === 'teammate') return identity.accountId
  return isStaff ? wanted : undefined
}
