/**
 * TD Communication — server-side data layer.
 *
 * comm_messages has RLS ON with a participant-scoped SELECT policy (so realtime
 * postgres_changes only reach participants); comm_conversations/comm_participants
 * are RLS-on with no policy. EVERY function here uses the service role
 * (supabaseAdmin, which bypasses RLS) and assumes the caller has already been
 * authenticated + authorized by the API layer (staff via isDashboardUser,
 * partner via getCommPartner). These helpers are the only write path.
 *
 * The comm_* tables are not in the generated Supabase types yet, so we go
 * through an untyped client and shape rows into the interfaces in ./types.
 */

import type { User } from '@supabase/supabase-js'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getUserDisplayName, isDashboardUser } from '@/lib/auth'
import { getCommPartner } from '@/lib/partner-auth'
import { messagePreview, normalizeSubject } from './helpers'
import type {
  CommAttachment,
  CommConversation,
  CommConversationListItem,
  CommMessage,
  CommParticipant,
  CommPartyType,
} from './types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

/**
 * Resolve the authenticated caller into a TD Communication participant.
 * Partner with td_communication scope → { type: 'partner', id: client_partners.id }.
 * Staff (admin/team) → { type: 'staff', id: auth uid }.
 * Anyone else → null (no access).
 *
 * IMPORTANT: partner is checked FIRST. A partner has role='partner', which is
 * NOT 'client', so isDashboardUser() returns true for them — checking staff
 * first would misclassify every partner as staff (tagging their messages
 * sender_type='staff' and showing them the staff/tombstone view).
 */
export async function resolveCommParticipant(
  user: User | null,
): Promise<CommParticipant | null> {
  if (!user) return null
  const partner = await getCommPartner(user)
  if (partner) {
    // Prefer the cosmetic display_title (e.g. "Communication Expert") as the
    // partner's chat sender name; this is what gets stamped onto comm_messages
    // and shown to staff. Falls back to the partner name.
    return {
      type: 'partner',
      id: partner.id,
      name: partner.display_title ?? partner.partner_name ?? 'Partner',
    }
  }
  if (isDashboardUser(user)) {
    return { type: 'staff', id: user.id, name: getUserDisplayName(user) }
  }
  return null
}

/** All conversations (staff view), newest activity first, with partner name + preview. */
export async function listConversationsForStaff(): Promise<CommConversationListItem[]> {
  const { data, error } = await db
    .from('comm_conversations')
    .select('*, partner:client_partners(partner_name)')
    .order('last_message_at', { ascending: false })
    .limit(200)
  if (error) throw new Error(error.message)
  return enrichConversations(data ?? [])
}

/** Conversations belonging to one partner (partner view). */
export async function listConversationsForPartner(
  partnerId: string,
): Promise<CommConversationListItem[]> {
  const { data, error } = await db
    .from('comm_conversations')
    .select('*, partner:client_partners(partner_name)')
    .eq('partner_id', partnerId)
    .order('last_message_at', { ascending: false })
    .limit(200)
  if (error) throw new Error(error.message)
  return enrichConversations(data ?? [])
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function enrichConversations(rows: any[]): Promise<CommConversationListItem[]> {
  if (rows.length === 0) return []
  const ids = rows.map((r) => r.id as string)
  // Latest non-deleted message per conversation, for the list preview.
  const { data: msgs } = await db
    .from('comm_messages')
    .select('conversation_id, body, deleted_at, created_at')
    .in('conversation_id', ids)
    .is('deleted_at', null)
    // id as a deterministic tiebreak when two messages share a created_at.
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const latestByConv = new Map<string, any>()
  for (const m of msgs ?? []) {
    if (!latestByConv.has(m.conversation_id)) latestByConv.set(m.conversation_id, m)
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return rows.map((r: any) => ({
    ...(r as CommConversation),
    partner_name: r.partner?.partner_name ?? null,
    last_message_preview: messagePreview(latestByConv.get(r.id) ?? null),
  }))
}

export async function getConversation(id: string): Promise<CommConversation | null> {
  const { data, error } = await db.from('comm_conversations').select('*').eq('id', id).maybeSingle()
  if (error) throw new Error(error.message)
  return (data as CommConversation) ?? null
}

/**
 * Can this participant access this conversation?
 * Staff → every conversation. Partner → only their own conversations.
 */
export async function participantCanAccess(
  conversationId: string,
  participant: CommParticipant,
): Promise<boolean> {
  if (participant.type === 'staff') return true
  const conv = await getConversation(conversationId)
  return !!conv && conv.partner_id === participant.id
}

export interface CreateConversationInput {
  subject?: unknown
  partnerId?: string | null
  creator: CommParticipant
}

/** Create a conversation and seed its participants (creator + the partner). */
export async function createConversation(
  input: CreateConversationInput,
): Promise<CommConversation> {
  const subject = normalizeSubject(input.subject)
  const partnerId = input.partnerId ?? (input.creator.type === 'partner' ? input.creator.id : null)

  const { data, error } = await db
    .from('comm_conversations')
    .insert({
      subject,
      partner_id: partnerId,
      created_by_type: input.creator.type,
      created_by_id: input.creator.id,
      created_by_name: input.creator.name,
    })
    .select('*')
    .single()
  if (error) throw new Error(error.message)
  const conv = data as CommConversation

  // Seed participants. The creator is always a participant; if the conversation
  // is tied to a partner (and the creator isn't that partner), add the partner.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const participants: any[] = [
    {
      conversation_id: conv.id,
      participant_type: input.creator.type,
      participant_id: input.creator.id,
      participant_name: input.creator.name,
    },
  ]
  if (partnerId && !(input.creator.type === 'partner' && input.creator.id === partnerId)) {
    const { data: p } = await db
      .from('client_partners')
      .select('partner_name')
      .eq('id', partnerId)
      .maybeSingle()
    participants.push({
      conversation_id: conv.id,
      participant_type: 'partner',
      participant_id: partnerId,
      participant_name: p?.partner_name ?? 'Partner',
    })
  }
  await db
    .from('comm_participants')
    .upsert(participants, { onConflict: 'conversation_id,participant_type,participant_id' })

  return conv
}

/**
 * Messages in a conversation, oldest first. A partner NEVER receives
 * soft-deleted rows (R100 — the body must not leave the server); staff receive
 * deleted rows so the CRM can render a tombstone for moderation/audit.
 */
export async function listMessages(
  conversationId: string,
  viewerType: CommPartyType,
): Promise<CommMessage[]> {
  let q = db
    .from('comm_messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(1000)
  if (viewerType !== 'staff') q = q.is('deleted_at', null)
  const { data, error } = await q
  if (error) throw new Error(error.message)
  return (data ?? []) as CommMessage[]
}

/** Insert a message (text and/or attachments, optional reply) and bump last_message_at. */
export async function insertMessage(params: {
  conversationId: string
  sender: CommParticipant
  body: string
  attachments?: CommAttachment[]
  replyToId?: string | null
}): Promise<CommMessage> {
  const { conversationId, sender, body } = params
  const attachments = params.attachments && params.attachments.length ? params.attachments : null
  const { data, error } = await db
    .from('comm_messages')
    .insert({
      conversation_id: conversationId,
      sender_type: sender.type,
      sender_id: sender.id,
      sender_name: sender.name,
      body,
      attachments,
      reply_to_id: params.replyToId ?? null,
    })
    .select('*')
    .single()
  if (error) throw new Error(error.message)

  await db
    .from('comm_conversations')
    .update({ last_message_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', conversationId)

  return data as CommMessage
}

/** Fetch a single message (for ownership/access checks). */
export async function getMessage(id: string): Promise<CommMessage | null> {
  const { data, error } = await db.from('comm_messages').select('*').eq('id', id).maybeSingle()
  if (error) throw new Error(error.message)
  return (data as CommMessage) ?? null
}

/** True when this participant sent the message. */
function isOwn(msg: CommMessage, p: CommParticipant): boolean {
  return msg.sender_type === p.type && msg.sender_id === p.id
}

/**
 * Edit a message's text. Only the sender may edit their own message; the
 * original text is preserved on the first edit and edited_at is stamped.
 * Returns { changed }. Throws on not-found / not-owner / deleted.
 */
export async function editMessage(
  id: string,
  editor: CommParticipant,
  newBody: string,
): Promise<{ changed: boolean }> {
  const msg = await getMessage(id)
  if (!msg) throw new Error('Message not found.')
  if (msg.deleted_at) throw new Error('Cannot edit a deleted message.')
  if (!isOwn(msg, editor)) throw new Error('You can only edit your own messages.')
  if (msg.body === newBody) return { changed: false }
  const updates: Record<string, unknown> = { body: newBody, edited_at: new Date().toISOString() }
  if (!msg.original_body) updates.original_body = msg.body
  const { error } = await db.from('comm_messages').update(updates).eq('id', id)
  if (error) throw new Error(error.message)
  return { changed: true }
}

/**
 * Soft-delete a message (R100). The sender may delete their own; staff may
 * delete any (moderation). Body is preserved for audit; partner queries filter
 * deleted rows out, the realtime UPDATE drops it live.
 */
export async function softDeleteMessage(id: string, deleter: CommParticipant): Promise<void> {
  const msg = await getMessage(id)
  if (!msg) throw new Error('Message not found.')
  if (msg.deleted_at) return
  if (deleter.type !== 'staff' && !isOwn(msg, deleter)) {
    throw new Error('You can only delete your own messages.')
  }
  const { error } = await db
    .from('comm_messages')
    .update({ deleted_at: new Date().toISOString(), deleted_by: `${deleter.type}:${deleter.id}` })
    .eq('id', id)
    .is('deleted_at', null)
  if (error) throw new Error(error.message)
}

/** Pin / unpin a message. Any participant of the conversation may pin. */
export async function setPinned(id: string, pinned: boolean, by: CommParticipant): Promise<void> {
  const updates = pinned
    ? { pinned_at: new Date().toISOString(), pinned_by: by.id, pinned_by_type: by.type }
    : { pinned_at: null, pinned_by: null, pinned_by_type: null }
  const { error } = await db.from('comm_messages').update(updates).eq('id', id)
  if (error) throw new Error(error.message)
}

/** Mark / unmark a message as deliberately kept-unread (recipient action). */
export async function setKeptUnread(id: string, kept: boolean): Promise<void> {
  const updates: Record<string, unknown> = { kept_unread: kept }
  // Re-marking unread also clears the read receipt so it counts again.
  if (kept) updates.read_at = null
  const { error } = await db.from('comm_messages').update(updates).eq('id', id)
  if (error) throw new Error(error.message)
}

/**
 * Mark every message NOT sent by the reader as read (sets read_at) — drives the
 * sender's ✓✓ receipt. Skips kept-unread messages so they keep counting.
 */
export async function markMessagesRead(conversationId: string, reader: CommParticipant): Promise<void> {
  await db
    .from('comm_messages')
    .update({ read_at: new Date().toISOString() })
    .eq('conversation_id', conversationId)
    .is('read_at', null)
    .eq('kept_unread', false)
    .not('sender_type', 'eq', reader.type)
}

/** Staff sidebar badge: count unread partner messages across all conversations. */
export async function unreadCountForStaff(): Promise<number> {
  const { count, error } = await db
    .from('comm_messages')
    .select('id', { count: 'exact', head: true })
    .eq('sender_type', 'partner')
    .is('read_at', null)
    .is('deleted_at', null)
  if (error) return 0
  return count ?? 0
}

/**
 * Ensure the caller is a participant of the conversation. Staff are not seeded
 * into every thread at creation, so this is called when they OPEN one — it is
 * what makes the participant-scoped comm_messages RLS policy deliver realtime
 * events to that staff member. Idempotent via the participant unique key.
 */
export async function ensureParticipant(
  conversationId: string,
  participant: CommParticipant,
): Promise<void> {
  await db
    .from('comm_participants')
    .upsert(
      {
        conversation_id: conversationId,
        participant_type: participant.type,
        participant_id: participant.id,
        participant_name: participant.name,
      },
      { onConflict: 'conversation_id,participant_type,participant_id', ignoreDuplicates: true },
    )
}

/** Mark a conversation read for a participant (updates last_read_at). */
export async function markConversationRead(
  conversationId: string,
  participant: CommParticipant,
): Promise<void> {
  await db
    .from('comm_participants')
    .update({ last_read_at: new Date().toISOString() })
    .eq('conversation_id', conversationId)
    .eq('participant_type', participant.type)
    .eq('participant_id', participant.id)
}
