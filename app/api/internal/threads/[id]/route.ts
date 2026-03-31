import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'

/**
 * GET /api/internal/threads/[id]
 * Returns thread metadata + all messages. Marks messages as read for requesting user.
 *
 * PATCH /api/internal/threads/[id]
 * Update thread: { resolved?: boolean, title?: string }
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }

  const { id } = await params

  // Get thread
  const { data: thread, error } = await supabaseAdmin
    .from('internal_threads')
    .select('*')
    .eq('id', id)
    .single()

  if (error || !thread) {
    return NextResponse.json({ error: 'Thread not found' }, { status: 404 })
  }

  // Get company name
  const { data: account } = await supabaseAdmin
    .from('accounts')
    .select('company_name')
    .eq('id', thread.account_id)
    .single()

  // Get source message text
  let sourceMessage: string | null = null
  if (thread.source_message_id) {
    const { data: srcMsg } = await supabaseAdmin
      .from('portal_messages')
      .select('message')
      .eq('id', thread.source_message_id)
      .single()
    sourceMessage = srcMsg?.message ?? null
  }

  // Get all messages
  const { data: messages } = await supabaseAdmin
    .from('internal_messages')
    .select('*')
    .eq('thread_id', id)
    .order('created_at', { ascending: true })

  // Mark unread messages from other senders as read
  await supabaseAdmin
    .from('internal_messages')
    .update({ read_at: new Date().toISOString() })
    .eq('thread_id', id)
    .neq('sender_id', user.id)
    .is('read_at', null)

  return NextResponse.json({
    thread: {
      ...thread,
      company_name: account?.company_name ?? 'Unknown',
      source_message: sourceMessage,
    },
    messages: messages ?? [],
  })
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }

  const { id } = await params
  const body = await request.json()

  const updates: Record<string, unknown> = {}
  if (typeof body.resolved === 'boolean') {
    updates.resolved_at = body.resolved ? new Date().toISOString() : null
  }
  if (typeof body.title === 'string') {
    updates.title = body.title
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })
  }

  const { data: thread, error } = await supabaseAdmin
    .from('internal_threads')
    .update(updates)
    .eq('id', id)
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ thread })
}
