import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'

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
