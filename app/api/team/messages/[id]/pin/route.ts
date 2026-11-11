import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { assertThreadAccess, THREAD_DENIED_MESSAGE } from '@/lib/team/groups'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/team/messages/[id]/pin  — toggle pin on a message.
 * Any staff member can pin/unpin. Body: {} (toggles based on current state).
 *
 * Optional `pinned: boolean` = SET instead of toggle: "I want this message pinned / unpinned". If it is already in that state nothing
 * is written and the current pin is returned. TD Talk sends this, so a double-tap or an answer that was lost can never flip a pin back.
 * Without `pinned` (the CRM Team Chat page sends no body) the behaviour is exactly the old toggle.
 */
export async function POST(
  request: NextRequest,
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
    .select('id, thread_id, pinned_at, pinned_by, deleted_at')
    .eq('id', msgId)
    .single()
  if (!existing) return NextResponse.json({ error: 'Message not found' }, { status: 404 })
  if (existing.thread_id) {
    const access = await assertThreadAccess(existing.thread_id, user.id)
    if (!access.allowed) return NextResponse.json({ error: THREAD_DENIED_MESSAGE }, { status: 403 })
  }
  if (existing.deleted_at) return NextResponse.json({ error: 'Cannot pin a deleted message' }, { status: 400 })

  // An explicit target (TD Talk) is read from the body; the CRM sends no body at all, so a missing or unreadable body means "toggle".
  const body = await request.json().catch(() => null)
  const wanted: boolean | null = body && typeof body.pinned === 'boolean' ? body.pinned : null
  const isPinned = !!existing.pinned_at
  if (wanted !== null && wanted === isPinned) {
    // already in the state asked for: change nothing (keeps who pinned it and when)
    return NextResponse.json({ message: { id: existing.id, pinned_at: existing.pinned_at ?? null, pinned_by: existing.pinned_by ?? null }, pinned: isPinned })
  }

  const nowPinned = wanted ?? !isPinned
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
