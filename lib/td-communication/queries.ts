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
  CommConversation,
  CommConversationListItem,
  CommMessage,
  CommParticipant,
} from './types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

/**
 * Resolve the authenticated caller into a TD Communication participant.
 * Staff (admin/team) → { type: 'staff', id: auth uid }.
 * Partner with td_communication scope → { type: 'partner', id: client_partners.id }.
 * Anyone else → null (no access).
 */
export async function resolveCommParticipant(
  user: User | null,
): Promise<CommParticipant | null> {
  if (!user) return null
  if (isDashboardUser(user)) {
    return { type: 'staff', id: user.id, name: getUserDisplayName(user) }
  }
  const partner = await getCommPartner(user)
  if (partner) {
    return { type: 'partner', id: partner.id, name: partner.partner_name ?? 'Partner' }
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

/** Messages in a conversation (excludes soft-deleted), oldest first. */
export async function listMessages(conversationId: string): Promise<CommMessage[]> {
  const { data, error } = await db
    .from('comm_messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .is('deleted_at', null)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(500)
  if (error) throw new Error(error.message)
  return (data ?? []) as CommMessage[]
}

/** Insert a message and bump the conversation's last_message_at. */
export async function insertMessage(params: {
  conversationId: string
  sender: CommParticipant
  body: string
}): Promise<CommMessage> {
  const { conversationId, sender, body } = params
  const { data, error } = await db
    .from('comm_messages')
    .insert({
      conversation_id: conversationId,
      sender_type: sender.type,
      sender_id: sender.id,
      sender_name: sender.name,
      body,
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
