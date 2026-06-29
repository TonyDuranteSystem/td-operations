/**
 * TD Communication — Phase 7 client-side access helper.
 *
 * Resolves the logged-in portal client's OWN active brand-audit enrollment by
 * their whole identity (contact OR any owned account), reusing the same lookup
 * the portal page + brand-audit submit use. The client never passes an
 * enrollment id to the Phase 7 routes — they always operate on this result — so
 * there is no IDOR surface.
 */

import type { User } from '@supabase/supabase-js'
import { getClientContactId, getClientAccountIds } from '@/lib/portal-auth'
import { getClientActiveEnrollment } from './brand-audit'
import type { CommEnrollmentRow } from './types'

export async function resolveClientActiveEnrollment(
  user: User,
): Promise<CommEnrollmentRow | null> {
  const contactId = getClientContactId(user)
  const accountIds = contactId ? await getClientAccountIds(contactId) : []
  if (!contactId && accountIds.length === 0) return null
  return getClientActiveEnrollment(contactId, accountIds)
}
