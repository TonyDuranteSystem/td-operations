import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'

/**
 * GET /api/tasks/by-thread?account_id=<uuid>|contact_id=<uuid>
 *
 * Returns all tasks linked to a given CRM thread (account OR contact).
 * Used by the Tasks sub-tab inside /portal-chats to show per-client task
 * context next to the chat messages.
 *
 * Admin only. Excludes tasks in status "Done" by default (include_done=1 to
 * show them too).
 *
 * Response shape matches the existing Task type in lib/types.ts so the
 * existing TaskCard component can render rows without adaptation.
 */
export async function GET(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Dashboard access required' }, { status: 403 })
  }

  const accountId = request.nextUrl.searchParams.get('account_id')
  const contactId = request.nextUrl.searchParams.get('contact_id')
  const includeDone = request.nextUrl.searchParams.get('include_done') === '1'

  if (!accountId && !contactId) {
    return NextResponse.json({ error: 'account_id or contact_id required' }, { status: 400 })
  }

  let query = supabaseAdmin
    .from('tasks')
    .select(
      'id, task_title, status, priority, due_date, assigned_to, category, description, account_id, delivery_id, updated_at, created_at, contact_id, stage_order, attachments, accounts(company_name), service_deliveries(service_type)'
    )

  if (accountId) {
    query = query.eq('account_id', accountId)
  } else if (contactId) {
    query = query.eq('contact_id', contactId)
  }

  if (!includeDone) {
    query = query.neq('status', 'Done')
  }

  // Order: open/urgent first (priority desc, then due date asc, then created desc)
  const { data, error } = await query
    .order('status', { ascending: true })
    .order('priority', { ascending: false })
    .order('due_date', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(100)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Flatten accounts.company_name + service_deliveries.service_type into top-level fields
  // to match the existing Task interface from lib/types.ts
  const tasks = (data ?? []).map(row => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = row as any
    return {
      id: r.id,
      task_title: r.task_title,
      status: r.status,
      priority: r.priority,
      due_date: r.due_date,
      assigned_to: r.assigned_to,
      category: r.category,
      description: r.description,
      account_id: r.account_id,
      delivery_id: r.delivery_id ?? null,
      company_name: r.accounts?.company_name ?? null,
      service_type: r.service_deliveries?.service_type ?? null,
      updated_at: r.updated_at,
      created_at: r.created_at,
    }
  })

  return NextResponse.json({ tasks })
}
