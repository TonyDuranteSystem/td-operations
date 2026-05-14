'use server'

import { createClient } from '@/lib/supabase/server'
import { getClientContactId } from '@/lib/portal-auth'
import { getPortalAccounts } from '@/lib/portal/queries'
import { getPortalJourneyEvents } from '@/lib/portal/journey-events'
import type { ActivityEvent } from '@/lib/operations/account-activity'

type Result =
  | { success: true; events: ActivityEvent[] }
  | { success: false; error: string }

export async function fetchPortalJourney(): Promise<Result> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: 'Not authenticated' }
  const contactId = getClientContactId(user)
  if (!contactId) return { success: false, error: 'No contact linked to this account' }
  const accounts = await getPortalAccounts(contactId)
  const accountIds = accounts.map(a => a.id)
  try {
    const events = await getPortalJourneyEvents(contactId, accountIds)
    return { success: true, events }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to load journey' }
  }
}
