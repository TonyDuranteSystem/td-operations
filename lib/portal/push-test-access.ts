/**
 * Who may send a TEST push alert to a company (bug hunt 2026-11-10, finding 8; docs/systems/client-app.md).
 *
 * The test button on the portal's Settings sends one test alert to every browser and every client iPhone of the company it names. Before this, a login with
 * no client record (a team member, or any other kind of login) was never checked, so anyone who knew a company's id could make that company's people's
 * phones buzz. Now ONLY a client of that company, or a team member of that company, may do it; everything else (staff, partners, unknown) is refused.
 * PURE, so it is unit-tested without a database.
 */
import type { PortalIdentity } from '@/lib/portal/resolve-portal-identity'
import { hasCapability } from '@/lib/portal/team/capabilities'

export function mayTestPushForAccount(identity: PortalIdentity, accountId: unknown): accountId is string {
  if (typeof accountId !== 'string' || accountId.length === 0 || accountId.length > 64) return false
  if (identity.kind === 'contact') return identity.accountIds.includes(accountId)
  // A team login needs the Chat power (the test buzzes every browser and phone of the company, and alerts are a chat feature): a login with
  // no powers, or one still waiting for its own notice (its powers are held back), may not.
  if (identity.kind === 'teammate') return identity.accountId === accountId && hasCapability(identity.capabilities, 'chat')
  return false
}
