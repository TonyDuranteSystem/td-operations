'use server'

/**
 * Server action: count of open workflow dispatch issues for one account.
 * Used by the small client-page link (WorkflowIssuesLink) so the account page
 * stays uncluttered — it only shows the link when there is something to show.
 */

import { createClient } from '@/lib/supabase/server'
import { isDashboardUser } from '@/lib/auth'
import { getWorkflowIssueCountForAccount } from '@/lib/operations/workflow-issues'

export async function fetchAccountWorkflowIssueCount(accountId: string): Promise<number> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) return 0
  try {
    return await getWorkflowIssueCountForAccount(accountId)
  } catch {
    return 0
  }
}
