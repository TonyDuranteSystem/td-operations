import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { NextResponse } from 'next/server'

/**
 * GET /api/tasks/open-counts
 *
 * Returns aggregate counts of OPEN tasks (status != 'Done') grouped by
 * account_id and contact_id. Used by /portal-chats to render a per-thread
 * "has pending work" indicator (the orange dot) alongside the existing
 * unread-message badge, and to surface a global task count in the tab title.
 *
 * Response shape:
 * {
 *   by_account: { "<account_id>": <count>, ... },
 *   by_contact: { "<contact_id>": <count>, ... },  // contact-only tasks (account_id IS NULL)
 *   total: <total_open_across_all_threads>
 * }
 *
 * Admin only. Kept separate from the get_portal_chat_threads RPC because
 * changing that RPC's return type requires dropping it, which the
 * execute_sql guardrail blocks.
 */
export async function GET() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Dashboard access required' }, { status: 403 })
  }

  // Single query returning all open tasks with their linkage columns.
  // Aggregation happens in JS because Supabase JS client doesn't support
  // GROUP BY directly without an RPC. Dataset is small (open tasks only).
  const { data, error } = await supabaseAdmin
    .from('tasks')
    .select('account_id, contact_id')
    .neq('status', 'Done')

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const byAccount: Record<string, number> = {}
  const byContact: Record<string, number> = {}
  let total = 0

  for (const row of data ?? []) {
    total++
    if (row.account_id) {
      byAccount[row.account_id] = (byAccount[row.account_id] ?? 0) + 1
    } else if (row.contact_id) {
      byContact[row.contact_id] = (byContact[row.contact_id] ?? 0) + 1
    }
  }

  return NextResponse.json({
    by_account: byAccount,
    by_contact: byContact,
    total,
  })
}
