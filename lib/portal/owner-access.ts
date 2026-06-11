/**
 * Owner-only account access (no teammate delegation).
 *
 * Tax financials (full bank data, P&L drafts, the confirm attestation) are
 * NON-DELEGABLE — like signing, they belong to the account owner, never to a
 * portal teammate regardless of capabilities. Staff (non-client role) pass.
 *
 * Use this instead of canAccessAccount() for owner-only routes.
 */

import type { User } from '@supabase/supabase-js'
import { resolvePortalIdentity } from '@/lib/portal/resolve-portal-identity'

export async function isAccountOwner(user: User | null, accountId: string | null | undefined): Promise<boolean> {
  if (!user || !accountId) return false
  if ((user.app_metadata as Record<string, unknown> | undefined)?.role !== 'client') return true // staff
  const identity = await resolvePortalIdentity(user)
  return identity.kind === 'contact' && identity.accountIds.includes(accountId)
}
