'use server'

import { createClient } from '@/lib/supabase/server'
import { isDashboardUser } from '@/lib/auth'
import {
  getAccountActivity,
  getContactActivity,
  type ActivityEvent,
} from '@/lib/operations/account-activity'

type Result =
  | { success: true; events: ActivityEvent[] }
  | { success: false; error: string }

export async function fetchAccountActivity(
  accountId: string,
  contactIds?: string[],
): Promise<Result> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return { success: false, error: 'Dashboard access required' }
  }
  try {
    const events = await getAccountActivity(accountId, { contactIds })
    return { success: true, events }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to load activity' }
  }
}

export async function fetchContactActivity(
  contactId: string,
  accountIds?: string[],
): Promise<Result> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return { success: false, error: 'Dashboard access required' }
  }
  try {
    const events = await getContactActivity(contactId, { accountIds })
    return { success: true, events }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to load activity' }
  }
}
