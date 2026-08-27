import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { getClientContactId, getClientAccountIds } from '@/lib/portal-auth'
import { resolvePersonalNullInclusion } from '@/lib/portal/chat-scope-server'
import { multiMemberAccountIds } from '@/lib/portal/thread-scope'
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

  // Per-company scoped read (client side, 2026-06-24). scope=company marks the
  // company thread (+ personal NULLs only when sole-owned); scope=personal marks
  // the contact's own untagged thread. Mirrors the GET scope logic so the unread
  // set the client SEES is exactly the set marked read.
  const scope = typeof body.scope === 'string' ? body.scope : undefined
  if (scope === 'company' || scope === 'personal') {
    const authContactId = getClientContactId(user)
    let marked = 0

    const markPersonalNull = async (contactId: string) => {
      let q = supabaseAdmin
        .from('portal_messages')
        .update({ read_at: now })
        .is('account_id', null)
        .eq('contact_id', contactId)
        .eq('sender_type', senderTypeToMark)
        .is('read_at', null)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- client_kept_unread predates generated types
      q = (q as any).eq('client_kept_unread', false)
      const { error, count } = await q
      if (error) return { error }
      return { count: count ?? 0 }
    }

    if (scope === 'company') {
      if (!account_id) return NextResponse.json({ error: 'account_id required' }, { status: 400 })
      // Account-tagged messages (shared thread — every member's view marks the same set).
      let q = supabaseAdmin
        .from('portal_messages')
        .update({ read_at: now })
        .eq('account_id', account_id)
        .eq('sender_type', senderTypeToMark)
        .is('read_at', null)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- client_kept_unread predates generated types
      q = (q as any).eq('client_kept_unread', false)
      const { error, count } = await q
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      marked += count ?? 0
      // Personal NULLs only when this account is sole-owned by the viewer.
      if (authContactId && (await resolvePersonalNullInclusion(account_id, authContactId))) {
        const r = await markPersonalNull(authContactId)
        if (r.error) return NextResponse.json({ error: r.error.message }, { status: 500 })
        marked += r.count
      }
    } else {
      if (!authContactId) return NextResponse.json({ error: 'Access denied' }, { status: 403 })
      const r = await markPersonalNull(authContactId)
      if (r.error) return NextResponse.json({ error: r.error.message }, { status: 500 })
      marked += r.count
    }
    return NextResponse.json({ marked })
  }

  if (account_id) {
    // Admin reads also clear plain system notices (out-of-office autoreply and
    // similar) alongside client messages — otherwise a topic that ever got one
    // stays permanently "unread" no matter how many times it's opened (2026-08-27).
    // Chat-event marker rows are EXCLUDED: those are acknowledged via their own
    // handled_at flag (What's New panel), never via read_at — see chat-events.ts.
    let q = supabaseAdmin
      .from('portal_messages')
      .update({ read_at: now })
      .eq('account_id', account_id)
      .in('sender_type', dashUser ? [senderTypeToMark, 'system'] : [senderTypeToMark])
      .not('message', 'ilike', '%<!-- chat-event:%')
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

  // Contact-scoped: mark the messages that BELONG to the contact thread.
  // This covers:
  //   (a) messages with contact_id = X (any account_id, including null)
  //   (b) legacy messages with contact_id = NULL but account_id in linked accounts
  //
  // Staff reads (2026-07-08, "one message, one staff thread"): messages on
  // multi-member accounts belong to that account's own thread, are NOT shown
  // in the person thread, and must NOT be marked read from here — otherwise
  // opening a member's personal thread silently cleared the company thread's
  // unread badge for messages staff never saw. Client reads keep the full
  // superset (their scoped reads go through the scope=company/personal branch
  // above; this legacy path stays unchanged for them).
  const { data: acRows } = await supabaseAdmin
    .from('account_contacts')
    .select('account_id')
    .eq('contact_id', contact_id)
  const linkedAccountIds = (acRows ?? []).map(r => r.account_id)
  const excludedAccountIds = dashUser ? await multiMemberAccountIds(linkedAccountIds) : []
  const excludedSet = new Set(excludedAccountIds)

  // (a) messages tagged with contact_id
  // Same system-notice inclusion as the account_id branch above (2026-08-27):
  // admin reads also clear plain system notices, never chat-event marker rows.
  let q1 = supabaseAdmin
    .from('portal_messages')
    .update({ read_at: now })
    .eq('contact_id', contact_id)
    .in('sender_type', dashUser ? [senderTypeToMark, 'system'] : [senderTypeToMark])
    .not('message', 'ilike', '%<!-- chat-event:%')
    .is('read_at', null)
  if (excludedAccountIds.length > 0) {
    q1 = q1.or(`account_id.is.null,account_id.not.in.(${excludedAccountIds.join(',')})`)
  }
  // Skip messages the client explicitly kept unread.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- client_kept_unread predates generated types
  q1 = (q1 as any).eq('client_kept_unread', false)
  if (topicFilterPresent) {
    q1 = topicFilter === null ? q1.is('topic', null) : q1.eq('topic', topicFilter)
  }
  const { error: e1, count: c1 } = await q1
  if (e1) return NextResponse.json({ error: e1.message }, { status: 500 })

  // (b) legacy messages with no contact_id but linked account (staff: only
  // accounts without their own thread — see the exclusion note above)
  const companyOnlyAccountIds = linkedAccountIds.filter(id => !excludedSet.has(id))
  let c2 = 0
  if (companyOnlyAccountIds.length > 0) {
    let q2 = supabaseAdmin
      .from('portal_messages')
      .update({ read_at: now })
      .is('contact_id', null)
      .in('account_id', companyOnlyAccountIds)
      .in('sender_type', dashUser ? [senderTypeToMark, 'system'] : [senderTypeToMark])
      .not('message', 'ilike', '%<!-- chat-event:%')
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
