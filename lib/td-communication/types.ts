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
  /** Automatic SLA deadline = base + package.delivery_days (Phase 10). Null until set. */
  deadline_at: string | null
  created_at: string
  updated_at: string
}

/** An enrollment shaped for the board/list: subject resolved, deadline/notes lifted out of metadata. */
export interface CommEnrollment extends CommEnrollmentRow {
  subject: EnrollmentSubject
  /** Effective deadline: deadline_at (Phase 10) when set, else legacy metadata.deadline. */
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

/* -------------------------------------------------------------------------- */
/* Phase 8 — Admin panel (td_comm_packages, td_comm_questions, settings)        */
/* -------------------------------------------------------------------------- */

/** When the client pays for a package. */
export type PackagePaymentTiming = 'upfront' | 'on_approval'

/** A purchasable TD Communication branding package (td_comm_packages row). */
export interface TdCommPackage {
  /** Stable identifier; matches enrollments.package_slug + PACKAGE_LABELS keys. Immutable after create. */
  slug: string
  name_en: string
  name_it: string | null
  description_en: string | null
  description_it: string | null
  price_usd: number | null
  delivery_days: number | null
  max_revisions: number
  payment_timing: PackagePaymentTiming
  /** "Most Popular" badge. */
  highlighted: boolean
  /** Soft-delete flag — false = retired (hidden from active lists). */
  active: boolean
  sort_order: number
  /** Bullet list of what's included. */
  includes: string[]
  /** Slugs this package can be upsold from. */
  upsell_from: string[]
  created_at: string
  updated_at: string
}

export type QuestionFieldType = 'text' | 'textarea' | 'select' | 'number' | 'file'
export type QuestionAudience = 'new_brand' | 'rebrand' | 'both'

/**
 * A single option for a `select` question. Bilingual label + an optional
 * bilingual description (e.g. the psychological meaning of a colour). The
 * wizard folds `description_*` into the rendered option label (the wizard's
 * FieldConfig option shape has no description slot). Legacy rows may still
 * store a bare string `"X"`; the reader (`shapeQuestion`) coerces that to
 * `{ value: "X", label_en: "X" }`.
 */
export interface TdCommOption {
  value: string
  label_en: string
  label_it?: string | null
  description_en?: string | null
  description_it?: string | null
}

/** A brand-audit question (td_comm_questions row), operator-editable. */
export interface TdCommQuestion {
  id: string
  /** form_data key the answer is stored under (consumed by groupBrief). */
  key: string
  label_en: string
  label_it: string | null
  type: QuestionFieldType
  required: boolean
  /** Wizard step grouping (1-based). */
  step: number
  /** Which enrollment type the question applies to. */
  audience: QuestionAudience
  /** Options used when type='select' (value + bilingual label/description). */
  options: TdCommOption[]
  /** When true, the wizard renders the ✨ "Generate with AI" button on this
   *  question (textarea only — see question-to-field.ts). Operator-editable. */
  ai_assist: boolean
  active: boolean
  sort_order: number
  created_at: string
  updated_at: string
}

/** System settings for TD Communication (stored in app_settings under key 'td_communication_settings'). */
export interface TdCommSettings {
  /** Whether the client-facing portal TD Communication tab is shown. */
  enabled: boolean
  disclaimer_en: string
  disclaimer_it: string
  /** Fallback SLA when a package has no delivery_days. */
  default_sla_days: number
  /** Master kill-switch for the TD Communication AI features (wizard ✨ + brand
   *  profile). When false, both AI routes return 503 without calling the model —
   *  lets an admin disable AI from the CRM Settings tab with no deploy. */
  ai_enabled: boolean
}

/** Aggregate stats for the enrollments admin tab. */
export interface EnrollmentStats {
  total: number
  byStatus: Record<string, number>
  /** Average days from enrollment to delivery, over enrollments with a delivered_at; null when none. */
  avgDeliveryDays: number | null
  /** SLA compliance % = delivered-on-time / delivered-with-a-deadline-and-delivered_at × 100; null when none qualify (Phase 10). */
  slaCompliancePct: number | null
  /** Count of SLA-tracked (non-terminal) enrollments currently past their deadline (Phase 10). */
  overdueCount: number
}

/* -------------------------------------------------------------------------- */
/* Phase 9 — Landing page content editor (td_communication_landing setting)    */
/* -------------------------------------------------------------------------- */

/** A single portfolio showcase item on the public landing page. */
export interface PortfolioItem {
  /** Public image URL (uploaded to the `assets` bucket or pasted). */
  image_url: string
  client_name: string
  description_en: string
  description_it: string
}

/**
 * The editable content of the TD Communication landing page. The layout is
 * fixed (hero → problem → packages → portfolio → CTA); only this content is
 * editable. `coming_soon` toggles the teaser variant vs the full landing page.
 * Bilingual EN/IT from day one (IT falls back to EN at render when blank).
 */
export interface LandingContent {
  hero_headline_en: string
  hero_headline_it: string
  hero_subheadline_en: string
  hero_subheadline_it: string
  problem_body_en: string
  problem_body_it: string
  cta_text_en: string
  cta_text_it: string
  portfolio_items: PortfolioItem[]
  /** When true the page shows the "Coming Soon" teaser; when false, the full landing. */
  coming_soon: boolean
}

/**
 * The full stored state in app_settings under key 'td_communication_landing'.
 * Two snapshots: `draft` is the editor workspace, `published` is what clients
 * see. Publish promotes draft → published. (Mirrors the /workflows Draft/Publish
 * model; stored as one JSONB blob like td_communication_settings.)
 */
export interface TdCommLandingState {
  draft: LandingContent
  published: LandingContent
  published_at: string | null
  published_by: string | null
  updated_at: string | null
  updated_by: string | null
}

/** What the editor reads: both snapshots + whether the draft has unpublished changes. */
export interface LandingEditorState extends TdCommLandingState {
  hasUnpublishedChanges: boolean
}
