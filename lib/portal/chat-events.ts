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
  | "members_updated"         // client submitted the member-info form (multi-member LLC)
  | "contact_updated"         // client submitted the contact-request form (add/update contact)
  | "offer_signed"            // client signed the offer/contract (awaiting payment)

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
      // topic intentionally null: the What's New panel derives the category
      // label from the event_key encoded in the marker (kind=... / workflow_slug),
      // so the per-message topic field is no longer needed for system notes.
      // Callers still pass `topic` in params for documentation/future use.
      topic: null,
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

// ────────────────────────────────────────────────────────────────────────────
// Source-specific emit helpers — each call site below uses one of these so
// the message body + topic stay consistent across the codebase. New event
// sources tomorrow add a helper here; no other code changes.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Emit a "payment received" event when a payment row flips to Paid.
 * Reads the payment row by id, formats the body with invoice number + amount
 * + payment method, and emits under the Billing topic.
 *
 * Non-fatal: any failure logs and swallows. Idempotent on payment id.
 */
export async function emitPaymentReceivedEvent(params: {
  payment_id: string
  /** Optional override for the payment_method label when the row doesn't
   *  yet carry one (some webhooks emit before back-fill). */
  method_hint?: string
}): Promise<EmitResult> {
  try {
    const { data: payment } = await supabaseAdmin
      .from("payments")
      .select("id, contact_id, account_id, invoice_number, total, amount, amount_currency, payment_method")
      .eq("id", params.payment_id)
      .maybeSingle()
    if (!payment) {
      return { emitted: false, reason: "insert_failed", error: "payment row not found" }
    }
    const amount = (payment.total as number | null) ?? (payment.amount as number | null) ?? null
    const currency = (payment.amount_currency as string | null) ?? "USD"
    const method = (payment.payment_method as string | null) ?? params.method_hint ?? "payment"
    const inv = (payment.invoice_number as string | null) ?? "invoice"
    const amountFmt = amount != null ? `${currency === "EUR" ? "€" : "$"}${amount}` : ""
    const message = `Client paid ${inv}${amountFmt ? " · " + amountFmt : ""} via ${method}.`
    return await emitClientChatEvent({
      contact_id: (payment.contact_id as string | null) ?? null,
      account_id: (payment.account_id as string | null) ?? null,
      topic: "billing",
      message,
      source: { table: "payments", id: params.payment_id },
      event_kind: "payment_received",
    })
  } catch (err) {
    console.warn(
      `[emitPaymentReceivedEvent] non-fatal for payment ${params.payment_id}:`,
      err instanceof Error ? err.message : String(err),
    )
    return { emitted: false, reason: "insert_failed", error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Emit a "document uploaded by client" event.
 * Caller provides the metadata since the documents row may not yet exist
 * at the moment of emit (some upload paths emit before commit).
 */
export async function emitDocumentUploadedEvent(params: {
  document_id: string
  contact_id?: string | null
  account_id?: string | null
  file_name: string
  document_type_name?: string | null
}): Promise<EmitResult> {
  const label = params.document_type_name
    ? `${params.document_type_name}: ${params.file_name}`
    : params.file_name
  const message = `Client uploaded a document — ${label}.`
  return await emitClientChatEvent({
    contact_id: params.contact_id ?? null,
    account_id: params.account_id ?? null,
    topic: "documents",
    message,
    source: { table: "documents", id: params.document_id },
    event_kind: "document_uploaded",
  })
}

/**
 * Emit an "SS-4 signed" event — critical for EIN application kickoff.
 * Per Antonio: when the client signs, staff must see this in portal-chats
 * immediately so Luca can fax the form to the IRS.
 */
export async function emitSs4SignedEvent(params: {
  ss4_id: string
  contact_id?: string | null
  account_id?: string | null
  company_name: string
}): Promise<EmitResult> {
  const message = `Client signed SS-4 for ${params.company_name} — fax to IRS to start EIN application.`
  return await emitClientChatEvent({
    contact_id: params.contact_id ?? null,
    account_id: params.account_id ?? null,
    topic: "formation",
    message,
    source: { table: "ss4_applications", id: params.ss4_id },
    event_kind: "ss4_signed",
  })
}

/**
 * Emit an "offer/contract signed" event when a client signs their offer.
 * Scoped to the CONTACT (the new company does not exist yet at sign time — and
 * never will until the SoS issues Articles — so there is no account thread to
 * attach to; the contact is the permanent center). For an existing client
 * signing a standalone service on an existing account, pass that account_id.
 *
 * Idempotent on the offer id — a webhook retry never double-posts. Non-fatal.
 */
export async function emitOfferSignedEvent(params: {
  offer_id: string
  contact_id?: string | null
  account_id?: string | null
  client_name: string
  amount?: number | null
  currency?: string | null
  payment_method?: string | null
}): Promise<EmitResult> {
  const amountFmt =
    params.amount != null && params.amount > 0
      ? `${params.currency === "EUR" ? "€" : "$"}${params.amount}`
      : ""
  const method =
    params.payment_method && params.payment_method !== "unknown"
      ? ` via ${params.payment_method.replace(/_/g, " ")}`
      : ""
  const message = `Client signed the contract${amountFmt ? " — " + amountFmt : ""}${method}. Awaiting payment.`
  return await emitClientChatEvent({
    contact_id: params.contact_id ?? null,
    account_id: params.account_id ?? null,
    topic: "Contract",
    message,
    source: { table: "offers", id: params.offer_id },
    event_kind: "offer_signed",
  })
}
