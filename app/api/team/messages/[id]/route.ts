import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser, isAdmin } from '@/lib/auth'
import { CLAUDE_SENDER_UUID } from '@/lib/team/workspace'
import { NextRequest, NextResponse } from 'next/server'

/**
 * PATCH /api/team/messages/[id]  — edit a message (author only).
 * Preserves original_message on first edit and stamps edited_at.
 * Body: { message }
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }
  const { id: msgId } = await params
  const body = await request.json().catch(() => ({}))
  const newMessage: string = (body.message ?? '').toString().trim()
  if (!newMessage) return NextResponse.json({ error: 'message required' }, { status: 400 })
  if (newMessage.length > 5000) return NextResponse.json({ error: 'Message too long (max 5000 characters)' }, { status: 400 })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: existing } = await (supabaseAdmin as any)
    .from('internal_messages')
    .select('id, sender_id, message, original_message, deleted_at')
    .eq('id', msgId)
    .single()
  if (!existing) return NextResponse.json({ error: 'Message not found' }, { status: 404 })
  if (existing.deleted_at) return NextResponse.json({ error: 'Cannot edit a deleted message' }, { status: 400 })
  // Author-only (admins may edit anyone would be surprising in a chat; keep it strict).
  if (existing.sender_id !== user.id) {
    return NextResponse.json({ error: 'You can only edit your own messages.' }, { status: 403 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: updated, error } = await (supabaseAdmin as any)
    .from('internal_messages')
    .update({
      message: newMessage,
      edited_at: new Date().toISOString(),
      original_message: existing.original_message ?? existing.message,
    })
    .eq('id', msgId)
    .select()
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ message: updated })
}

/**
 * DELETE /api/team/messages/[id]  — soft-delete (R100). Author or admin.
 * Staff see a tombstone; the row is preserved for audit.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }
  const { id: msgId } = await params

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: existing } = await (supabaseAdmin as any)
    .from('internal_messages')
    .select('id, sender_id, thread_id, deleted_at')
    .eq('id', msgId)
    .single()
  if (!existing) return NextResponse.json({ error: 'Message not found' }, { status: 404 })
  if (existing.deleted_at) return NextResponse.json({ ok: true }) // already deleted — idempotent

  let allowed = existing.sender_id === user.id || isAdmin(user)
  // A message Claude posted has no human author to defer to. Inside a DM,
  // either of its two real participants may still retract it — a stuck error
  // bubble, a relay that's gone stale — never in a channel/discussion with a
  // wider audience, which stays admin-only exactly as before (2026-09-07).
  if (!allowed && existing.sender_id === CLAUDE_SENDER_UUID && existing.thread_id) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: thread } = await (supabaseAdmin as any)
      .from('internal_threads')
      .select('thread_type, dm_key')
      .eq('id', existing.thread_id)
      .maybeSingle()
    if (thread?.thread_type === 'dm' && (thread.dm_key ?? '').split(':').includes(user.id)) {
      allowed = true
    }
  }
  if (!allowed) {
    return NextResponse.json({ error: 'You can only delete your own messages.' }, { status: 403 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabaseAdmin as any)
    .from('internal_messages')
    .update({ deleted_at: new Date().toISOString(), deleted_by: user.id })
    .eq('id', msgId)
    .is('deleted_at', null) // TOCTOU guard
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
