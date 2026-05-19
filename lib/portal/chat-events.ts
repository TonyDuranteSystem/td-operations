/**
 * Central emitter for client-action portal-chat events.
 *
 * Why this exists:
 * Per Antonio (2026-05-18): "every different submission or thing that the
 * client does and need our attention for the next step" must produce a topic
 * in their portal-chat thread with a red unread badge. Without this primitive,
 * the dispatcher only created tasks — the topic itself never materialized in
 * the conversation, so there was no red dot.
 *
 * Design:
 * - Single function `emitClientChatEvent` called from every event source
 *   (workflow dispatcher, document upload, payment webhooks, signature handlers).
 * - Writes a `portal_messages` row with `sender_type='system'` and
 *   `topic = <slug>` (resolved against the `topic_templates` catalog when
 *   given a slug, falls back to the literal string if not a known slug).
 * - Idempotent: the (source_table, source_id, event_kind) triple is encoded
 *   in the message body via an HTML-comment marker; a pre-check skips insert
 *   if the same marker already exists for this contact/account. Re-running a
 *   webhook or backfill never produces duplicates.
 * - Excluded from R103 admin-email cron: the cron must filter
 *   sender_type='client' only (system messages don't email anyone — they're
 *   already visible in the staff portal-chats page with realtime).
 *
 * What this is NOT:
 * - Not a task. Tasks live in the `tasks` table and are created separately
 *   by the dispatcher / per-route handlers. This emit is the visibility layer
 *   on top of the conversation thread.
 * - Not an email. R103 suppression applies — system messages don't notify
 *   the client (they're staff-side context only).
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

export type ChatEventKind =
  | "workflow_spawned"        // dispatcher fired a workflow task
  | "wizard_submitted"        // client completed a wizard
  | "document_uploaded"       // client uploaded a doc to their portal
  | "payment_received"        // client payment landed (any rail)
  | "ss4_signed"              // client signed SS-4 (critical — staff faxes IRS)

export interface ChatEventSource {
  /** Origin table — e.g. 'tasks', 'payments', 'documents', 'ss4_applications' */
  table: string
  /** Row id in that table */
  id: string
}

export interface EmitClientChatEventParams {
  /** Either contact_id or account_id (or both) must be set, mirroring
   *  portal_messages convention. */
  contact_id?: string | null
  account_id?: string | null

  /** Topic name. Pass either a slug from the `topic_templates` catalog
   *  (preferred — keeps topic naming consistent) or a literal string. */
  topic: string

  /** Message body. Plain text. Will be wrapped server-side with an
   *  idempotency marker; do not include HTML comments. */
  message: string

  /** What caused this event. Used for dedup and audit. */
  source: ChatEventSource

  /** Discriminator for the dedup key — lets one source row produce multiple
   *  distinct events over time without colliding. E.g. a single payment row
   *  may only emit one 'payment_received' event ever, but a single task row
   *  could emit 'workflow_spawned' once and a follow-up event later. */
  event_kind: ChatEventKind
}

export interface EmitResult {
  emitted: boolean
  message_id?: string
  reason?: "already_emitted" | "missing_recipient" | "insert_failed"
  error?: string
}

const MARKER_PREFIX = "<!-- chat-event:"
const MARKER_SUFFIX = " -->"

function buildMarker(source: ChatEventSource, kind: ChatEventKind): string {
  return `${MARKER_PREFIX} kind=${kind} src=${source.table}:${source.id}${MARKER_SUFFIX}`
}

/** Resolve a topic slug → display name via the `topic_templates` catalog.
 *  When the input isn't a known slug, returns the input verbatim — supports
 *  callers passing a literal topic name when no catalog entry exists.
 */
async function resolveTopicName(slugOrLiteral: string): Promise<string> {
  const { data } = await supabaseAdmin
    .from("catalog_entries")
    .select("display_name")
    .eq("catalog_id", "topic_templates")
    .eq("slug", slugOrLiteral.toLowerCase())
    .eq("status", "active")
    .maybeSingle()
  return (data?.display_name as string | undefined) ?? slugOrLiteral
}

/**
 * Emit a system-authored portal-chat message under the given topic. Idempotent
 * on (source.table, source.id, event_kind) — re-running is safe.
 */
export async function emitClientChatEvent(
  params: EmitClientChatEventParams,
): Promise<EmitResult> {
  if (!params.contact_id && !params.account_id) {
    return { emitted: false, reason: "missing_recipient" }
  }

  const topicName = await resolveTopicName(params.topic)
  const marker = buildMarker(params.source, params.event_kind)

  // Idempotency: search portal_messages for an existing row whose body
  // contains this exact marker AND targets the same recipient. Cheap because
  // the marker is unique by construction.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let dedupQuery: any = supabaseAdmin
    .from("portal_messages")
    .select("id")
    .eq("sender_type", "system")
    .like("message", `%${marker}%`)
    .is("deleted_at", null)
    .limit(1)
  if (params.contact_id) dedupQuery = dedupQuery.eq("contact_id", params.contact_id)
  if (params.account_id) dedupQuery = dedupQuery.eq("account_id", params.account_id)
  const { data: existing } = await dedupQuery.maybeSingle()
  if (existing) {
    return { emitted: false, reason: "already_emitted", message_id: existing.id as string }
  }

  // System sender_id placeholder — portal_messages.sender_id is NOT NULL so
  // we use a deterministic UUID for the system author. The portal-chats UI
  // renders sender_type='system' with a distinct style regardless of sender_id.
  const SYSTEM_SENDER_ID = "00000000-0000-0000-0000-000000000000"

  const messageBody = `${params.message}\n\n${marker}`

  const { data: inserted, error: insertErr } = await supabaseAdmin
    .from("portal_messages")
    .insert({
      contact_id: params.contact_id ?? null,
      account_id: params.account_id ?? null,
      sender_type: "system",
      sender_id: SYSTEM_SENDER_ID,
      message: messageBody,
      topic: topicName,
    })
    .select("id")
    .single()

  if (insertErr || !inserted) {
    return {
      emitted: false,
      reason: "insert_failed",
      error: insertErr?.message ?? "insert returned no row",
    }
  }

  return { emitted: true, message_id: inserted.id as string }
}
