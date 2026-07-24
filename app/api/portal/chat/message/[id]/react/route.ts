import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser, getUserDisplayName } from '@/lib/auth'
import { getClientContactId, getClientAccountIds } from '@/lib/portal-auth'
import { requirePortalCapability } from '@/lib/portal/team/gate'
import { createPortalNotification } from '@/lib/portal/notifications'
import { isValidReactionEmoji } from '@/lib/portal/reactions'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/portal/chat/message/[id]/react
 * Toggle an emoji reaction on a single chat message. Usable by BOTH staff (CRM)
 * and the client / their teammates (portal). Reactions are shared — both sides
 * see them. Slack-style toggle: re-sending the same emoji removes the caller's
 * own reaction; a caller may add several distinct emojis.
 *
 * Body: { emoji: string }
 *
 * Authorization mirrors the pin route:
 *  - Staff (dashboard user): may react on any message. reactor_type='staff'.
 *  - Client contact: only messages in THEIR conversation. reactor_type='client'.
 *  - Teammate (Portal Team Access): only their own account's thread, with 'chat'.
 *
 * Notifications (Antonio 2026-06-30): IN-APP / PUSH ONLY, never email. Only on
 * ADD (not removal), only when reacting to the OTHER party's message, throttled.
 */

// Throttle reaction notifications: at most one per (message, direction) per window.
// Module-level — best-effort de-spam within a warm serverless instance.
const recentReactionNotifs = new Map<string, number>()
const REACTION_NOTIFY_WINDOW_MS = 60_000

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const id = params.id
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  let body: { emoji?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const emoji = typeof body.emoji === 'string' ? body.emoji.trim() : ''
  if (!isValidReactionEmoji(emoji)) {
    return NextResponse.json({ error: 'A valid emoji is required.' }, { status: 400 })
  }

  const { data: msg, error: selErr } = await supabaseAdmin
    .from('portal_messages')
    .select('id, account_id, contact_id, deleted_at, sender_type')
    .eq('id', id)
    .maybeSingle()
  if (selErr) return NextResponse.json({ error: selErr.message }, { status: 500 })
  if (!msg) return NextResponse.json({ error: 'Message not found' }, { status: 404 })
  if (msg.deleted_at) return NextResponse.json({ error: 'Cannot react to a deleted message' }, { status: 409 })

  // Resolve actor + authorize scope.
  const staff = isDashboardUser(user)
  let reactorType: 'staff' | 'client'
  let reactorId: string
  let reactorName: string | null

  if (staff) {
    reactorType = 'staff'
    reactorId = user.id
    reactorName = null // staff reactions render generically (no identity leak to clients)
  } else {
    const authContactId = getClientContactId(user)
    if (authContactId) {
      // Normal client contact.
      let inScope = msg.contact_id === authContactId
      if (!inScope && msg.account_id) {
        const accountIds = await getClientAccountIds(authContactId)
        inScope = accountIds.includes(msg.account_id)
      }
      if (!inScope) return NextResponse.json({ error: 'Access denied' }, { status: 403 })
      reactorType = 'client'
      reactorId = authContactId
      const { data: c } = await supabaseAdmin
        .from('contacts')
        .select('full_name')
        .eq('id', authContactId)
        .maybeSingle()
      reactorName = c?.full_name || null
    } else {
      // Teammate (Portal Team Access): no contact_id; gate on 'chat' + own account.
      const access = await requirePortalCapability(user, 'chat')
      if (!access.allowed || access.kind !== 'teammate' || !access.accountId || access.accountId !== msg.account_id) {
        return NextResponse.json({ error: 'Access denied' }, { status: 403 })
      }
      reactorType = 'client'
      reactorId = user.id
      reactorName = access.displayName || null
    }
  }

  // Atomic toggle — the Postgres fn locks the row (no lost-update race).
  const { data: result, error: rpcErr } = await supabaseAdmin.rpc('toggle_message_reaction', {
    p_message_id: id,
    p_emoji: emoji,
    p_reactor_id: reactorId,
    p_reactor_type: reactorType,
    p_reactor_name: reactorName,
  })
  if (rpcErr) return NextResponse.json({ error: rpcErr.message }, { status: 500 })

  const parsed = (result as unknown) as { added?: boolean; reactions?: unknown } | null
  const added = !!parsed?.added
  const reactions = parsed?.reactions ?? []

  // Notify the OTHER party — in-app / push only, never email, only on ADD.
  if (added) {
    const reactedToClientMessage = msg.sender_type === 'client'
    const reactedToTeamMessage = msg.sender_type === 'admin' || msg.sender_type === 'system'

    if (staff && reactedToClientMessage) {
      // Staff reacted to a client's message → notify the client (push + in-app bell).
      const throttleKey = `to-client:${id}`
      if (!throttled(throttleKey)) {
        createPortalNotification({
          account_id: msg.account_id || undefined,
          contact_id: msg.contact_id || undefined,
          type: 'reaction', // excluded from the digest email in /api/cron/portal-digest
          title: 'New reaction from Tony Durante Team',
          body: `${emoji} on your message`,
          link: '/portal/chat',
        }).catch(() => {})
      }
    } else if (!staff && reactedToTeamMessage) {
      // Client / teammate reacted to a team message → push to staff (no email).
      const throttleKey = `to-staff:${id}`
      if (!throttled(throttleKey)) {
        notifyAdminOfReaction(msg.account_id, msg.contact_id, emoji).catch(() => {})
      }
    }
  }

  // 🧠 ADDED by STAFF → save this message to memory (WS1: Antonio's Slack
  // "react 🧠 to save" behavior, now in the CRM). STAFF ONLY — clients can react
  // on portal messages, so this must never fire for a client 🧠. Best-effort.
  try {
    if (staff && added) {
      const { isBrainEmoji, saveChatMessageAsMemory } = await import('@/lib/ai-agent/chat-memory-reaction')
      if (isBrainEmoji(emoji)) {
        const { data: full } = await supabaseAdmin
          .from('portal_messages')
          .select('message')
          .eq('id', id)
          .maybeSingle()
        if (full?.message) {
          await saveChatMessageAsMemory({
            messageText: full.message,
            savedByName: getUserDisplayName(user),
            surface: 'portal',
            messageId: id,
            accountId: msg.account_id,
            contactId: msg.contact_id,
          })
        }
      }
    }
  } catch (err) {
    console.warn('[portal react] 🧠 memory save failed (non-fatal):', err)
  }

  return NextResponse.json({ ok: true, added, reactions })
}

function throttled(key: string): boolean {
  const now = Date.now()
  const last = recentReactionNotifs.get(key) ?? 0
  if (now - last < REACTION_NOTIFY_WINDOW_MS) return true
  recentReactionNotifs.set(key, now)
  return false
}

async function notifyAdminOfReaction(accountId: string | null, contactId: string | null, emoji: string) {
  let displayName = 'Client'
  if (accountId) {
    const { data: account } = await supabaseAdmin
      .from('accounts')
      .select('company_name')
      .eq('id', accountId)
      .maybeSingle()
    displayName = account?.company_name || displayName
  } else if (contactId) {
    const { data: contact } = await supabaseAdmin
      .from('contacts')
      .select('full_name')
      .eq('id', contactId)
      .maybeSingle()
    displayName = contact?.full_name || displayName
  }

  const { sendPushToStaff } = await import('@/lib/team/notify')
  await sendPushToStaff({
    title: `Reaction: ${displayName}`,
    body: `${emoji} on your message`,
    url: `/portal-chats${accountId ? `?account=${accountId}` : ''}`,
    tag: `admin-chat-reaction-${accountId || contactId || 'unknown'}`,
  })
}
