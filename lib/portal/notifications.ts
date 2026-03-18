import { supabaseAdmin } from '@/lib/supabase-admin'

/**
 * Create a portal notification for a client.
 * Called by MCP tools, API routes, and cron jobs when something happens
 * that the client should know about.
 */
export async function createPortalNotification(params: {
  account_id: string
  contact_id?: string
  type: string
  title: string
  body?: string
  link?: string
}) {
  const { error } = await supabaseAdmin
    .from('portal_notifications')
    .insert(params)

  if (error) {
    console.error('Failed to create portal notification:', error.message)
  }
}

/**
 * Get unread notification count for an account.
 */
export async function getUnreadNotificationCount(accountId: string): Promise<number> {
  const { count } = await supabaseAdmin
    .from('portal_notifications')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', accountId)
    .is('read_at', null)

  return count ?? 0
}
