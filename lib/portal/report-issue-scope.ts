/**
 * Which company an automatic "report an issue" may be filed under (dev job e59dd470, 20 Nov bug hunt A#9).
 *
 * POST /api/portal/report-issue took `account_id` straight from the request body: any signed-in client or team login could open a
 * High-priority task for Luca, and a `portal_issues` row, under ANY company by typing its id. Now the company is kept only when the
 * caller really belongs to it; otherwise the report is still saved (an error report must never be lost) but WITHOUT a company link.
 *   - staff (not the client role): any company (as before);
 *   - a client with a contact: only a company linked to that contact;
 *   - a team login: only its own company (no power needed: a login with no powers or waiting for its notice can still report a problem);
 *   - anyone else: no company.
 * Dependencies are passed in so the rule runs without a database (tests).
 */
import type { User } from '@supabase/supabase-js'
import { getClientContactId, getClientAccountIds } from '@/lib/portal-auth'
import { resolvePortalIdentity, type PortalIdentity } from '@/lib/portal/resolve-portal-identity'

export interface ReportScopeDeps {
  getContactId: (user: User) => string | null | undefined
  getAccountIds: (contactId: string) => Promise<string[]>
  resolveIdentity: (user: User) => Promise<PortalIdentity>
}

const defaultDeps: ReportScopeDeps = {
  getContactId: getClientContactId,
  getAccountIds: getClientAccountIds,
  resolveIdentity: resolvePortalIdentity,
}

/** The company id the report may be filed under, or null (file it without a company). */
export async function accountIdForIssueReport(user: User, requested: unknown, deps: ReportScopeDeps = defaultDeps): Promise<string | null> {
  if (typeof requested !== 'string' || requested.length === 0 || requested.length > 64) return null
  const isClient = (user.app_metadata as Record<string, unknown> | undefined)?.role === 'client'
  if (!isClient) return requested // staff
  const contactId = deps.getContactId(user)
  if (contactId) return (await deps.getAccountIds(contactId)).includes(requested) ? requested : null
  const identity = await deps.resolveIdentity(user)
  return identity.kind === 'teammate' && identity.accountId === requested ? requested : null
}
