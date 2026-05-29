/**
 * Portal Team Access — server-side capability gate + nav mapping.
 *
 * The single place that answers: "for THIS logged-in user, may they access a
 * section, and which account is in scope?" Default-deny for teammates.
 *
 * Used by:
 *   - portal pages/routes: requirePortalCapability(capability)
 *   - the sidebar (via the nav-key → capability map): teammateNavCapability()
 *
 * Design: sysdoc 'portal-team-access-design'.
 */
import type { User } from '@supabase/supabase-js'
import { resolvePortalIdentity, type PortalIdentity } from '@/lib/portal/resolve-portal-identity'
import { hasCapability, type TeamCapability } from './capabilities'

export type PortalAccessResult =
  | { allowed: true; kind: 'contact'; contactId: string; accountIds: string[] }
  | { allowed: true; kind: 'teammate'; teamMemberId: string; accountId: string; displayName: string; capabilities: Record<string, boolean> }
  | { allowed: false; reason: 'unauthenticated' | 'denied' }

/**
 * Resolve access for a portal capability.
 *  - contact  → always allowed (existing client behavior; scoping unchanged)
 *  - teammate → allowed ONLY if the capability is granted (default-deny)
 *  - none     → denied
 */
export async function requirePortalCapability(
  user: User | null,
  capability: TeamCapability,
  resolve: (u: User) => Promise<PortalIdentity> = resolvePortalIdentity,
): Promise<PortalAccessResult> {
  if (!user) return { allowed: false, reason: 'unauthenticated' }
  const identity: PortalIdentity = await resolve(user)

  if (identity.kind === 'contact') {
    return { allowed: true, kind: 'contact', contactId: identity.contactId, accountIds: identity.accountIds }
  }
  if (identity.kind === 'teammate') {
    if (!hasCapability(identity.capabilities, capability)) return { allowed: false, reason: 'denied' }
    return {
      allowed: true,
      kind: 'teammate',
      teamMemberId: identity.teamMemberId,
      accountId: identity.accountId,
      displayName: identity.displayName,
      capabilities: identity.capabilities,
    }
  }
  return { allowed: false, reason: 'denied' }
}

/**
 * Map a sidebar nav key → the capability that gates it for a TEAMMATE.
 *   - a TeamCapability string → shown iff that capability is granted
 *   - 'always'                → always shown to teammates (home, guide)
 *   - null                    → never shown to teammates (owner-only)
 */
export function teammateNavCapability(navKey: string): TeamCapability | 'always' | null {
  switch (navKey) {
    case 'nav.overview':
    case 'nav.guide':
      return 'always'
    case 'nav.myCompany':
      return 'company_services'
    case 'nav.documents':
    case 'nav.generateDocuments':
      return 'documents'
    case 'nav.invoices':
    case 'nav.tdBilling':
      return 'invoices_billing'
    case 'nav.chat':
      return 'chat'
    case 'nav.myClients':
      return 'sales_customers'
    // Owner-only / non-delegable for teammates:
    //   nav.team (admin only), nav.signDocuments (signing = owner only),
    //   nav.requestService, nav.referrals, nav.profile, nav.offer, nav.wizard,
    //   partner items.
    default:
      return null
  }
}
