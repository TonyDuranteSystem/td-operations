import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isAdmin } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'

/**
 * DELETE /api/internal/threads/[id]/messages/[msgId]
 * Soft-delete a message. Antonio-only.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; msgId: string }> }
) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const { id: threadId, msgId } = await params

  // Verify message belongs to this thread
  const { data: msg } = await supabaseAdmin
    .from('internal_messages')
    .select('id, thread_id')
    .eq('id', msgId)
    .eq('thread_id', threadId)
    .single()

  if (!msg) {
    return NextResponse.json({ error: 'Message not found' }, { status: 404 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabaseAdmin as any)
    .from('internal_messages')
    .update({ deleted_at: new Date().toISOString(), deleted_by: user.id })
    .eq('id', msgId)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ deleted: true })
}
