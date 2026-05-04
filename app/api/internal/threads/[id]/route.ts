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

  // Get company name (or contact name for contact-only threads)
  let companyName: string | null = null
  if (thread.account_id) {
    const { data: account } = await supabaseAdmin
      .from('accounts')
      .select('company_name')
      .eq('id', thread.account_id)
      .single()
    companyName = account?.company_name ?? null
  }
  if (!companyName && thread.contact_id) {
    const { data: contact } = await supabaseAdmin
      .from('contacts')
      .select('full_name')
      .eq('id', thread.contact_id)
      .single()
    companyName = contact?.full_name ?? null
  }

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

  // Get all messages (including deleted — caller renders tombstones)
  const { data: rawMessages } = await supabaseAdmin
    .from('internal_messages')
    .select('*')
    .eq('thread_id', id)
    .order('created_at', { ascending: true })

  const messages = rawMessages ?? []

  // Enrich with reply_to previews
  type ReplyParent = { id: string; message: string; sender_name: string; deleted_at: string | null }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const msgs = messages as any[]
  const replyToIds = Array.from(new Set(msgs.filter((m) => m.reply_to_id).map((m) => m.reply_to_id as string)))
  const parentMap = new Map<string, ReplyParent>()
  if (replyToIds.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: parents } = await (supabaseAdmin as any)
      .from('internal_messages')
      .select('id, message, sender_name, deleted_at')
      .in('id', replyToIds)
    ;(parents ?? []).forEach((p: ReplyParent) => parentMap.set(p.id, p))
  }

  const enriched = msgs.map((m) => ({
    ...m,
    reply_to_preview: m.reply_to_id ? (parentMap.get(m.reply_to_id) ?? null) : null,
  }))

  // Mark messages from other senders as seen
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabaseAdmin as any)
    .from('internal_messages')
    .update({ seen_at: new Date().toISOString() })
    .eq('thread_id', id)
    .neq('sender_id', user.id)
    .is('seen_at', null)

  return NextResponse.json({
    thread: {
      ...thread,
      company_name: companyName ?? thread.title ?? 'Team Discussion',
      source_message: sourceMessage,
    },
    messages: enriched,
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

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }

  const { id } = await params

  // Delete all messages in the thread first (FK constraint)
  await supabaseAdmin
    .from('internal_messages')
    .delete()
    .eq('thread_id', id)

  // Delete the thread
  const { error } = await supabaseAdmin
    .from('internal_threads')
    .delete()
    .eq('id', id)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ deleted: true })
}
