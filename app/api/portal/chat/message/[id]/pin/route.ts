import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { getClientContactId, getClientAccountIds } from '@/lib/portal-auth'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/portal/chat/message/[id]/pin
 * Pin or unpin a single chat message. Usable by BOTH staff (CRM) and the client
 * (their portal). Pinned messages are shared — both sides see them in the
 * "Pinned" strip at the top of the conversation. No limit.
 *
 * Body: { pinned: boolean }
 *
 * Authorization:
 *  - Staff (dashboard user): may pin/unpin any message. Tagged pinned_by_type='staff'.
 *  - Client: may pin/unpin only messages in THEIR conversation (message contact_id
 *    matches, or message account_id is one of theirs). Tagged pinned_by_type='client'.
 * Either side may unpin (the pin is shared on the conversation).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const id = params.id
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  let body: { pinned?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const pinned = body.pinned === true

  const { data: msg, error: selErr } = await supabaseAdmin
    .from('portal_messages')
    .select('id, account_id, contact_id, deleted_at')
    .eq('id', id)
    .maybeSingle()
  if (selErr) return NextResponse.json({ error: selErr.message }, { status: 500 })
  if (!msg) return NextResponse.json({ error: 'Message not found' }, { status: 404 })
  if (msg.deleted_at) return NextResponse.json({ error: 'Cannot pin a deleted message' }, { status: 409 })

  // Resolve actor + authorize scope.
  const staff = isDashboardUser(user)
  let pinnedByType: 'staff' | 'client'
  let pinnedBy: string

  if (staff) {
    pinnedByType = 'staff'
    pinnedBy = user.id
  } else {
    const authContactId = getClientContactId(user)
    if (!authContactId) return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    let inScope = msg.contact_id === authContactId
    if (!inScope && msg.account_id) {
      const accountIds = await getClientAccountIds(authContactId)
      inScope = accountIds.includes(msg.account_id)
    }
    if (!inScope) return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    pinnedByType = 'client'
    pinnedBy = authContactId
  }

  const updates = pinned
    ? { pinned_at: new Date().toISOString(), pinned_by: pinnedBy, pinned_by_type: pinnedByType }
    : { pinned_at: null, pinned_by: null, pinned_by_type: null }

  const { error: updErr } = await supabaseAdmin
    .from('portal_messages')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- new pin columns predate generated types
    .update(updates as any)
    .eq('id', id)
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 })

  return NextResponse.json({ ok: true, pinned })
}
