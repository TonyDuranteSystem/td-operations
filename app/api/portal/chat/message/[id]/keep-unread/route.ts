import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { getClientContactId, getClientAccountIds } from '@/lib/portal-auth'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/portal/chat/message/[id]/keep-unread
 * Client-only "Mark as Unread" for a single admin chat message. The client
 * flags an admin (team) message so it keeps counting toward their unread badge
 * even after it has been read. Staff have no equivalent need — they get 403.
 *
 * Body: { kept: boolean }
 *
 * Only admin-authored messages (sender_type='admin') can be kept unread — a
 * client keeping their OWN message unread is meaningless. The caller must own
 * the conversation (message contact_id matches, or message account_id is one
 * of theirs) — same scope check as the pin route.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Client-only: staff unread tracking is separate.
  if (isDashboardUser(user)) {
    return NextResponse.json({ error: 'Clients only' }, { status: 403 })
  }

  const id = params.id
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  let body: { kept?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const kept = body.kept === true

  const { data: msg, error: selErr } = await supabaseAdmin
    .from('portal_messages')
    .select('id, account_id, contact_id, sender_type, deleted_at')
    .eq('id', id)
    .maybeSingle()
  if (selErr) return NextResponse.json({ error: selErr.message }, { status: 500 })
  if (!msg) return NextResponse.json({ error: 'Message not found' }, { status: 404 })
  if (msg.deleted_at) return NextResponse.json({ error: 'Cannot mark a deleted message' }, { status: 409 })
  if (msg.sender_type !== 'admin') {
    return NextResponse.json({ error: 'Only team messages can be marked unread' }, { status: 400 })
  }

  // Authorize scope — message must be in the caller's conversation.
  const authContactId = getClientContactId(user)
  if (!authContactId) return NextResponse.json({ error: 'Access denied' }, { status: 403 })
  let inScope = msg.contact_id === authContactId
  if (!inScope && msg.account_id) {
    const accountIds = await getClientAccountIds(authContactId)
    inScope = accountIds.includes(msg.account_id)
  }
  if (!inScope) return NextResponse.json({ error: 'Access denied' }, { status: 403 })

  const { error: updErr } = await supabaseAdmin
    .from('portal_messages')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- new column predates generated types
    .update({ client_kept_unread: kept } as any)
    .eq('id', id)
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 })

  return NextResponse.json({ ok: true, kept })
}
