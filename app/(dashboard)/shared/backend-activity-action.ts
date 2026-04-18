'use server'

/**
 * P3.8 — server action wrapper for backend activity fetch.
 *
 * Thin pass-through to lib/per-record-activity/queries.ts that also enforces
 * the dashboard permission check. Called from the client BackendActivityPanel
 * when a user opens the "Backend" tab on an account or contact page.
 */

import { createClient } from '@/lib/supabase/server'
import { isDashboardUser } from '@/lib/auth'
import {
  getAccountBackendActivity,
  getContactBackendActivity,
  type BackendActivity,
} from '@/lib/per-record-activity/queries'

type Result =
  | { success: true; activity: BackendActivity }
  | { success: false; error: string }

export async function fetchAccountBackendActivity(accountId: string): Promise<Result> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return { success: false, error: 'Dashboard access required' }
  }
  try {
    const activity = await getAccountBackendActivity(accountId)
    return { success: true, activity }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to load activity' }
  }
}

export async function fetchContactBackendActivity(
  contactId: string,
  email?: string | null,
): Promise<Result> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return { success: false, error: 'Dashboard access required' }
  }
  try {
    const activity = await getContactBackendActivity(contactId, { email })
    return { success: true, activity }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to load activity' }
  }
}
