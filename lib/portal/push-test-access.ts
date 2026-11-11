/**
 * Who may send a TEST push alert to a company (bug hunt 2026-11-10, finding 8; docs/systems/client-app.md).
 *
 * The test button on the portal's Settings sends one test alert to every browser and every client iPhone of the company it names. Before this, a login with
 * no client record (a team member, or any other kind of login) was never checked, so anyone who knew a company's id could make that company's people's
 * phones buzz. Now ONLY a client of that company, or a team member of that company, may do it; everything else (staff, partners, unknown) is refused.
 * PURE, so it is unit-tested without a database.
 */
import type { PortalIdentity } from '@/lib/portal/resolve-portal-identity'

export function mayTestPushForAccount(identity: PortalIdentity, accountId: unknown): accountId is string {
  if (typeof accountId !== 'string' || accountId.length === 0 || accountId.length > 64) return false
  if (identity.kind === 'contact') return identity.accountIds.includes(accountId)
  if (identity.kind === 'teammate') return identity.accountId === accountId
  return false
}
