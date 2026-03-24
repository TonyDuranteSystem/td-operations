import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getClientContactId } from '@/lib/portal-auth'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/portal/report-issue
 * Auto-reports portal errors. Creates a portal_issue + task for admin.
 * Client sees a friendly message; admin gets full error details.
 */
export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { account_id, area, error_message, context } = await request.json()

  const contactId = getClientContactId(user)

  // Get display name for the task
  let displayName = 'Unknown'
  if (account_id) {
    const { data: account } = await supabaseAdmin
      .from('accounts')
      .select('company_name')
      .eq('id', account_id)
      .single()
    displayName = account?.company_name || 'Unknown'
  } else if (contactId) {
    const { data: contact } = await supabaseAdmin
      .from('contacts')
      .select('full_name')
      .eq('id', contactId)
      .single()
    displayName = contact?.full_name || 'Unknown'
  }

  // Create the issue record
  const { data: _issue } = await supabaseAdmin
    .from('portal_issues')
    .insert({
      account_id: account_id || null,
      contact_id: contactId,
      user_email: user.email,
      area: area || 'general',
      error_message: error_message || 'Unknown error',
      error_context: context || {},
    })
    .select('id')
    .single()

  // Create a task for admin
  await supabaseAdmin.from('tasks').insert({
    task_title: `Portal issue: ${area || 'error'} — ${displayName}`,
    assigned_to: 'Luca',
    category: 'Internal',
    account_id: account_id || null,
    status: 'To Do',
    priority: 'High',
    description: [
      `Client: ${user.email}`,
      `Area: ${area || 'general'}`,
      `Error: ${error_message || 'Unknown'}`,
      context ? `Context: ${JSON.stringify(context)}` : '',
      issue ? `Issue ID: ${issue.id}` : '',
      '',
      'When resolved, mark the portal_issues record as resolved and notify the client.',
    ].filter(Boolean).join('\n'),
  })

  return NextResponse.json({ ok: true, issue_id: issue?.id })
}
