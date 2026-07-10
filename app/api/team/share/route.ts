import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser, getUserDisplayName } from '@/lib/auth'
import { findOrCreateDm } from '@/lib/team/dm'
import { listTeamMembers } from '@/lib/team/directory'
import { buildShareCards, composeShareMessage, MAX_SHARE_ITEMS } from '@/lib/team/share'
import { getSupportPersonUserId } from '@/lib/settings'
import { findOrCreateConversation } from '@/lib/team/find-conversation'
import { parseClientRef } from '@/lib/team/conversations'
import { sendPushToAdminUsers } from '@/lib/portal/web-push'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/team/share
 *
 * Share one or more items (a client portal message, or an email from the Inbox)
 * into the internal Team Workspace as a DM — either to a chosen teammate ("discuss")
 * or to the configured support person ("Send to Support"). Each item becomes its
 * OWN message (note + client_message card) so a multi-share creates one message
 * per item, never a merged blob.
 *
 * Notifies ONLY the recipient (sendPushToAdminUsers) — deliberately NOT the
 * team-chat send route, which broadcasts DM/thread activity to the whole staff
 * (sendPushToAdminExcluding). Reusing that route here would ping everyone on
 * every share.
 *
 * Body:
 *   {
 *     target: 'support' | { user_id: string },
 *     note?: string,
 *     items: Array<{ kind?, title, subtitle?, url?, color?, entity_type?, entity_id? }>
 *   }
 */
export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }

  const body = await request.json().catch(() => ({}))
  const note: string = typeof body.note === 'string' ? body.note.trim() : ''

  // Validate + normalize the items into cards (pure, unit-tested).
  const built = buildShareCards(body.items, MAX_SHARE_ITEMS)
  if (built.error) {
    return NextResponse.json({ error: built.error }, { status: 400 })
  }
  const cards = built.cards

  const now = new Date().toISOString()
  const displayName = getUserDisplayName(user)

  // Resolve WHERE the share lands (threadId) and WHO gets pinged (pushIds).
  // Three targets:
  //   'support'                        → the support person's DM (legacy)
  //   { user_id }                      → a chosen teammate's DM (legacy)
  //   { conversation: { client, topic }} → a team-visible CLIENT CONVERSATION
  let threadId: string
  let pushIds: string[] = []
  let openLabel = 'teammate'

  const convTarget =
    body.target && typeof body.target === 'object' && body.target.conversation
      ? body.target.conversation
      : null

  if (convTarget) {
    // ── Client conversation (team-visible discussion on a client + topic) ──
    const ref = parseClientRef((convTarget.client ?? '').toString())
    if (!ref) return NextResponse.json({ error: 'A valid client is required.' }, { status: 400 })
    const topic: string | null = (convTarget.topic ?? '').toString().trim() || null

    const found = await findOrCreateConversation({
      ref,
      topic,
      createdBy: user.id,
      createdByName: displayName,
      forceNew: convTarget.force_new === true,
    })
    if ('error' in found) {
      return NextResponse.json({ error: found.error }, { status: found.status })
    }
    threadId = found.thread.id
    openLabel = found.thread.title ?? found.clientName

    // Notify the support person (Luca) by default — the person picking up client
    // work. If the sharer IS the support person, fall back to notifying admins so
    // it never rings the sharer alone. (Full @tag routing is a later slice.)
    const supportId = await getSupportPersonUserId()
    if (supportId && supportId !== user.id) {
      pushIds = [supportId]
    } else {
      const members = await listTeamMembers()
      pushIds = members.filter(m => m.role === 'admin' && m.id !== user.id).map(m => m.id)
    }
  } else {
    // ── Legacy DM targets (support person, or a chosen teammate) ──
    let recipientId: string
    if (body.target === 'support') {
      const supportId = await getSupportPersonUserId()
      if (!supportId) {
        return NextResponse.json(
          { error: 'No support person is configured. Set one before sharing to Support.' },
          { status: 409 },
        )
      }
      recipientId = supportId
    } else if (body.target && typeof body.target === 'object' && typeof body.target.user_id === 'string') {
      recipientId = body.target.user_id.trim()
    } else {
      return NextResponse.json({ error: 'A share target is required.' }, { status: 400 })
    }
    if (!recipientId) {
      return NextResponse.json({ error: 'A share target is required.' }, { status: 400 })
    }

    // The recipient must be a real, active staff member.
    const members = await listTeamMembers()
    const recipient = members.find(m => m.id === recipientId)
    if (!recipient) {
      return NextResponse.json({ error: 'That teammate was not found.' }, { status: 404 })
    }
    openLabel = recipient.name

    // Find-or-create the DM (order-independent, race-safe).
    try {
      const { thread } = await findOrCreateDm(user.id, recipientId)
      threadId = thread.id
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Could not open the conversation.' },
        { status: 500 },
      )
    }
    pushIds = recipientId !== user.id ? [recipientId] : []
  }

  // One message per item. The message body = the sharer's note + the item's full
  // source text (whole email / portal message), capped; the card is the titled
  // link back. Bulk insert keeps them in order.
  const rawItems = Array.isArray(body.items) ? body.items : []
  const rows = cards.map((card, i) => ({
    thread_id: threadId,
    sender_id: user.id,
    sender_name: displayName,
    message: composeShareMessage(note, rawItems[i]?.body),
    card,
    mentions: [],
    mentioned_user_ids: [],
    attachments: [],
    read_at: now,
  }))

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: insErr } = await (supabaseAdmin as any)
    .from('internal_messages')
    .insert(rows)
  if (insErr) {
    return NextResponse.json({ error: insErr.message }, { status: 500 })
  }

  // Bump thread activity so it re-sorts to the top of the sidebar.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabaseAdmin as any)
    .from('internal_threads')
    .update({ last_activity_at: now })
    .eq('id', threadId)

  // Sender has implicitly read their own messages.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabaseAdmin as any)
    .from('internal_thread_reads')
    .upsert(
      { thread_id: threadId, user_id: user.id, last_read_at: now, updated_at: now },
      { onConflict: 'thread_id,user_id' },
    )

  // Notify the resolved recipient(s). Empty when you shared to your own DM.
  try {
    const count = cards.length
    await sendPushToAdminUsers(pushIds, {
      title: `${displayName} shared ${count > 1 ? `${count} items` : 'an item'} — ${openLabel}`,
      body: note ? note.slice(0, 120) : (cards[0].title || 'Shared to team chat'),
      url: `/team-chat?thread=${threadId}`,
      tag: `team-share-${threadId}`,
    })
  } catch {
    // non-critical
  }

  return NextResponse.json({ thread_id: threadId, count: cards.length })
}
