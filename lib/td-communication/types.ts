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

/* -------------------------------------------------------------------------- */
/* Phase 2 — Project pipeline (td_comm_enrollments)                            */
/* -------------------------------------------------------------------------- */

/**
 * Lifecycle status of a creative-project enrollment. The board maps these 8
 * statuses onto 6 columns (see lib/td-communication/pipeline.ts); `cancelled`
 * is hidden from the board.
 */
export type EnrollmentStatus =
  | 'enrolled'
  | 'form_submitted'
  | 'in_progress'
  | 'concept_ready'
  | 'approved'
  | 'revision'
  | 'delivered'
  | 'cancelled'

export type EnrollmentClientType = 'new_brand' | 'rebrand'

/**
 * The "subject" of a project — the client it is for. Polymorphic: an enrollment
 * hangs on exactly one of account/contact/lead/partner (DB CHECK num_nonnulls >= 1).
 */
export type EnrollmentSubjectType = 'account' | 'contact' | 'lead' | 'partner'

/** A resolved subject for display (name + optional email + which actor it is). */
export interface EnrollmentSubject {
  type: EnrollmentSubjectType
  id: string
  name: string
  email: string | null
}

/** Raw td_comm_enrollments row (untyped table — shaped here). */
export interface CommEnrollmentRow {
  id: string
  account_id: string | null
  contact_id: string | null
  lead_id: string | null
  partner_id: string | null
  service_delivery_id: string | null
  client_type: EnrollmentClientType | null
  package_slug: string | null
  status: EnrollmentStatus
  form_data: Record<string, unknown>
  conversation_id: string | null
  metadata: Record<string, unknown>
  created_at: string
  updated_at: string
}

/** An enrollment shaped for the board/list: subject resolved, deadline/notes lifted out of metadata. */
export interface CommEnrollment extends CommEnrollmentRow {
  subject: EnrollmentSubject
  /** metadata.deadline (ISO date) when present. */
  deadline: string | null
  /** metadata.notes — Cris's private notes. */
  notes: string | null
}

/* -------------------------------------------------------------------------- */
/* Phase 3 — Deliverables (td_comm_deliverables)                               */
/* -------------------------------------------------------------------------- */

/** Category of a creative deliverable. Independent of is_draft (the release state). */
export type DeliverableType =
  | 'logo_draft'
  | 'logo_final'
  | 'landing_page'
  | 'brand_guide'
  | 'business_card'
  | 'other'

/**
 * A creative deliverable uploaded against an enrollment. Lives in the private
 * `td-comm-deliverables` storage bucket; `file_url` is the storage PATH, signed
 * on read. `preview_url`/`download_url` are NOT columns — the server attaches
 * short-lived signed URLs when it returns a deliverable to the client.
 */
export interface CommDeliverable {
  id: string
  enrollment_id: string
  type: DeliverableType
  /** Storage path in the private bucket (signed on read). */
  file_url: string | null
  drive_file_id: string | null
  file_name: string
  file_size: number | null
  mime_type: string | null
  /** Draft = watermark + download-block flags (client-side enforcement is future). */
  is_draft: boolean
  /** Concept grouping: 1 = A, 2 = B, 3 = C … */
  concept_number: number
  /** Revision within a concept: 1 = v1, 2 = v2 … */
  version_number: number
  watermark_applied: boolean
  /** Set when released to the client (null = not yet visible to them). */
  released_at: string | null
  released_by: string | null
  created_at: string
  /** Signed, short-lived. Inline preview (images). Added by the server on read. */
  preview_url?: string | null
  /** Signed, short-lived, forced-attachment download. Added by the server on read. */
  download_url?: string | null
}
