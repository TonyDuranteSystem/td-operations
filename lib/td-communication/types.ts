/**
 * TD Communication — shared types for the staff<->partner conversation model.
 *
 * Tables (see scripts/migrations/20260627-1400-comm-conversations-foundation.sql):
 *   comm_conversations, comm_participants, comm_messages
 */

/** Who an actor is on this channel. */
export type CommPartyType = 'staff' | 'partner'

export type CommConversationStatus = 'open' | 'closed' | 'archived'

/** Resolved identity of the authenticated caller on the TD Communication channel. */
export interface CommParticipant {
  type: CommPartyType
  /** staff: supabase auth user id; partner: client_partners.id */
  id: string
  name: string
}

export interface CommConversation {
  id: string
  subject: string | null
  status: CommConversationStatus
  partner_id: string | null
  created_by_type: CommPartyType | null
  created_by_id: string | null
  created_by_name: string | null
  last_message_at: string
  created_at: string
  updated_at: string
}

/** A chat attachment (mirrors the portal chat's ChatAttachment shape). */
export interface CommAttachment {
  url: string
  name: string
  mime_type?: string
  size?: number
}

export interface CommMessage {
  id: string
  conversation_id: string
  sender_type: CommPartyType
  sender_id: string | null
  sender_name: string | null
  body: string
  attachment_url: string | null
  attachment_name: string | null
  attachments: CommAttachment[] | null
  read_at: string | null
  reply_to_id: string | null
  edited_at: string | null
  original_body: string | null
  pinned_at: string | null
  pinned_by: string | null
  pinned_by_type: CommPartyType | null
  kept_unread: boolean
  deleted_at: string | null
  deleted_by: string | null
  created_at: string
}

/** A conversation row enriched with the partner name + last message preview for list views. */
export interface CommConversationListItem extends CommConversation {
  partner_name: string | null
  last_message_preview: string | null
}
