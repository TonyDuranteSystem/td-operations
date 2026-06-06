import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { getClientContactId, getClientAccountIds } from '@/lib/portal-auth'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/portal/chat/read
 * Marks messages as read.
 * Accepts { account_id } or { contact_id } for contact-only chats.
 * - Admin calling: marks client messages as read (admin has seen them)
 * - Client calling: marks admin messages as read (client has seen them)
 *
 * Optional `topic` param (admin only):
 *   - Omitted: marks all messages (backwards compat)
 *   - null: marks only general (null-topic) messages
 *   - string: marks only messages in that specific topic
 */
export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const { account_id, contact_id } = body
  if (!account_id && !contact_id) {
    return NextResponse.json({ error: 'account_id or contact_id required' }, { status: 400 })
  }

  const dashUser = isDashboardUser(user)

  // Verify access for clients
  if (!dashUser) {
    const authContactId = getClientContactId(user)
    if (authContactId && account_id) {
      const accountIds = await getClientAccountIds(authContactId)
      if (!accountIds.includes(account_id)) {
        return NextResponse.json({ error: 'Access denied' }, { status: 403 })
      }
    }
    if (contact_id && contact_id !== authContactId) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }
  }

  // Mark opposite sender's messages as read
  const senderTypeToMark = dashUser ? 'client' : 'admin'

  // topic filter (admin only): null = general tab, string = named topic, absent = all
  const topicFilterPresent = dashUser && 'topic' in body
  const topicFilter: string | null = topicFilterPresent ? (body.topic ?? null) : null

  const now = new Date().toISOString()

  if (account_id) {
    let q = supabaseAdmin
      .from('portal_messages')
      .update({ read_at: now })
      .eq('account_id', account_id)
      .eq('sender_type', senderTypeToMark)
      .is('read_at', null)
    // Skip messages the client explicitly kept unread.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- client_kept_unread predates generated types
    q = (q as any).eq('client_kept_unread', false)
    if (topicFilterPresent) {
      q = topicFilter === null ? q.is('topic', null) : q.eq('topic', topicFilter)
    }
    const { error, count } = await q
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ marked: count ?? 0 })
  }

  // Contact-scoped: mark ALL messages for this contact across all accounts.
  // This covers:
  //   (a) messages with contact_id = X (any account_id, including null)
  //   (b) legacy messages with contact_id = NULL but account_id in linked accounts
  const { data: acRows } = await supabaseAdmin
    .from('account_contacts')
    .select('account_id')
    .eq('contact_id', contact_id)
  const linkedAccountIds = (acRows ?? []).map(r => r.account_id)

  // (a) messages tagged with contact_id
  let q1 = supabaseAdmin
    .from('portal_messages')
    .update({ read_at: now })
    .eq('contact_id', contact_id)
    .eq('sender_type', senderTypeToMark)
    .is('read_at', null)
  // Skip messages the client explicitly kept unread.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- client_kept_unread predates generated types
  q1 = (q1 as any).eq('client_kept_unread', false)
  if (topicFilterPresent) {
    q1 = topicFilter === null ? q1.is('topic', null) : q1.eq('topic', topicFilter)
  }
  const { error: e1, count: c1 } = await q1
  if (e1) return NextResponse.json({ error: e1.message }, { status: 500 })

  // (b) legacy messages with no contact_id but linked account
  let c2 = 0
  if (linkedAccountIds.length > 0) {
    let q2 = supabaseAdmin
      .from('portal_messages')
      .update({ read_at: now })
      .is('contact_id', null)
      .in('account_id', linkedAccountIds)
      .eq('sender_type', senderTypeToMark)
      .is('read_at', null)
    // Skip messages the client explicitly kept unread.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- client_kept_unread predates generated types
    q2 = (q2 as any).eq('client_kept_unread', false)
    if (topicFilterPresent) {
      q2 = topicFilter === null ? q2.is('topic', null) : q2.eq('topic', topicFilter)
    }
    const { error: e2, count } = await q2
    if (e2) return NextResponse.json({ error: e2.message }, { status: 500 })
    c2 = count ?? 0
  }

  return NextResponse.json({ marked: (c1 ?? 0) + c2 })
}
