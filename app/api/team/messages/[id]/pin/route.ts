import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/team/messages/[id]/pin  — toggle pin on a message.
 * Any staff member can pin/unpin. Body: {} (toggles based on current state).
 */
export async function POST(
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
    .select('id, pinned_at, deleted_at')
    .eq('id', msgId)
    .single()
  if (!existing) return NextResponse.json({ error: 'Message not found' }, { status: 404 })
  if (existing.deleted_at) return NextResponse.json({ error: 'Cannot pin a deleted message' }, { status: 400 })

  const nowPinned = !existing.pinned_at
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: updated, error } = await (supabaseAdmin as any)
    .from('internal_messages')
    .update({
      pinned_at: nowPinned ? new Date().toISOString() : null,
      pinned_by: nowPinned ? user.id : null,
    })
    .eq('id', msgId)
    .select('id, pinned_at, pinned_by')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ message: updated, pinned: nowPinned })
}
