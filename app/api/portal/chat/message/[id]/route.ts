import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'

/**
 * PATCH /api/portal/chat/message/[id]
 * Edit the text of an admin-sent portal message. Admin only.
 *
 * Body: { message: string }
 *
 * - Only messages with sender_type = 'admin' can be edited.
 * - On the first edit, the original text is preserved in original_message.
 * - edited_at is always updated to now().
 * - The realtime UPDATE event propagates the new content to the client portal.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Dashboard access required' }, { status: 403 })
  }

  const id = params.id
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  let body: { message?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const newText = typeof body.message === 'string' ? body.message.trim() : null
  if (!newText) return NextResponse.json({ error: 'message must be a non-empty string' }, { status: 400 })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- original_message + deleted_at need migration before types regenerate
  const { data: existing, error: selectError } = await (supabaseAdmin as any)
    .from('portal_messages')
    .select('id, sender_type, message, original_message, deleted_at')
    .eq('id', id)
    .maybeSingle()

  if (selectError) return NextResponse.json({ error: selectError.message }, { status: 500 })
  if (!existing) return NextResponse.json({ error: 'Message not found' }, { status: 404 })
  if (existing.deleted_at) return NextResponse.json({ error: 'Cannot edit a deleted message' }, { status: 409 })
  if (existing.sender_type !== 'admin') {
    return NextResponse.json({ error: 'Only admin messages can be edited' }, { status: 403 })
  }
  if (existing.message === newText) return NextResponse.json({ ok: true, changed: false })

  const updates: Record<string, unknown> = {
    message: newText,
    edited_at: new Date().toISOString(),
  }
  // Preserve the original text only on the first edit
  if (!existing.original_message) {
    updates.original_message = existing.message
  }

  const { error: updateError } = await supabaseAdmin
    .from('portal_messages')
    .update(updates)
    .eq('id', id)

  if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 })

  return NextResponse.json({ ok: true, changed: true })
}

/**
 * DELETE /api/portal/chat/message/[id]
 * Soft-delete a single portal chat message. Admin only.
 *
 * Sets deleted_at = now() and deleted_by = <admin user id>. The row is kept
 * for audit; the client's GET /api/portal/chat filters out deleted rows, and
 * the realtime UPDATE event tells the client to drop the message from view.
 * Admin view keeps the row and renders a tombstone with the deleted-by line.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Dashboard access required' }, { status: 403 })
  }

  const id = params.id
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const { data: existing, error: selectError } = await supabaseAdmin
    .from('portal_messages')
    .select('id, deleted_at')
    .eq('id', id)
    .maybeSingle()

  if (selectError) return NextResponse.json({ error: selectError.message }, { status: 500 })
  if (!existing) return NextResponse.json({ error: 'Message not found' }, { status: 404 })
  if (existing.deleted_at) return NextResponse.json({ error: 'Message already deleted' }, { status: 409 })

  const { error: updateError } = await supabaseAdmin
    .from('portal_messages')
    .update({ deleted_at: new Date().toISOString(), deleted_by: user.id })
    .eq('id', id)

  if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}
