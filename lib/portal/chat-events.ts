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
  | "decision_responded"      // client answered a client_decision_request (approval/choice/text)
  | "aged_credit_applied"     // an old credit note reduced a bill (WS-A: credits never expire)
  | "financials_confirm_unlocked" // staff overrode the failed-statement hard block (card 4a39e0fd)
  | "plan_referrer_ready_to_release" // a payment-plan deal with a referrer/partner is now fully paid — release commission
  | "recurring_invoice_generated" // the recurring-invoices cron auto-generated a Draft invoice — review + send it
  | "banking_wizard_submitted" // client submitted a Payset/Relay banking application via the portal wizard
  | "financials_attested" // client confirmed their generated P&L / Balance Sheet

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
  reason?: "already_emitted" | "missing_recipient" | "insert_failed" | "not_applicable"
  error?: string
}

/**
 * `portal_messages.sender_id` and `deleted_by` are NOT NULL / uuid columns, so a system
 * author needs a deterministic uuid rather than a label. The portal-chats UI renders
 * `sender_type='system'` distinctly regardless of the id.
 */
const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-000000000000"

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
  // contains this exact marker. The marker alone is unique by construction
  // (event kind + source table:id), so match on it GLOBALLY — do NOT also
  // filter by contact_id/account_id: an older copy of the same event may carry
  // different recipient tags (e.g. account-only rows written before the
  // 2026-07-06 dual-tagging fix), and a webhook retry must still dedup
  // against it instead of double-posting.
  const { data: existing } = await supabaseAdmin
    .from("portal_messages")
    .select("id")
    .eq("sender_type", "system")
    .like("message", `%${marker}%`)
    .is("deleted_at", null)
    .limit(1)
    .maybeSingle()
  if (existing) {
    return { emitted: false, reason: "already_emitted", message_id: existing.id as string }
  }

  const messageBody = `${params.message}\n\n${marker}`

  const { data: inserted, error: insertErr } = await supabaseAdmin
    .from("portal_messages")
    .insert({
      contact_id: params.contact_id ?? null,
      account_id: params.account_id ?? null,
      sender_type: "system",
      sender_id: SYSTEM_ACTOR_ID,
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
 * WS-A: an OLD credit just reduced a bill — tell staff (dev job c0a61e44).
 *
 * Locked decision: paid-call credits never expire. The cost of "never" is that a
 * credit earned months ago can quietly cut a renewal invoice, and the invoice
 * line alone ("Credit applied −€257") reads to staff like a billing bug rather
 * than a remembered promise. This note gives it a name and a date.
 *
 * Only fires above the age threshold: a credit applied days after it was earned
 * is the normal, expected flow and needs no announcement.
 *
 * Non-fatal by construction — a notification failure must never break invoicing.
 */
export async function emitAgedCreditAppliedEvent(params: {
  invoice_id: string
  credit_id: string
  amount: number
  currency: string
  credit_created_at: string
  /** Age in days above which staff are told. Default 180 (~6 months). */
  threshold_days?: number
}): Promise<EmitResult> {
  try {
    const thresholdDays = params.threshold_days ?? 180
    const ageMs = Date.now() - new Date(params.credit_created_at).getTime()
    const ageDays = Math.floor(ageMs / 86_400_000)
    if (!Number.isFinite(ageDays) || ageDays < thresholdDays) {
      return { emitted: false, reason: "not_applicable" }
    }

    const { data: invoice } = await supabaseAdmin
      .from("payments")
      .select("id, contact_id, account_id, invoice_number")
      .eq("id", params.invoice_id)
      .maybeSingle()
    if (!invoice) return { emitted: false, reason: "insert_failed", error: "invoice row not found" }

    const symbol = params.currency === "EUR" ? "€" : "$"
    const inv = (invoice.invoice_number as string | null) ?? "invoice"
    const message =
      `A credit from ${ageDays} days ago (${symbol}${params.amount}) was applied to ${inv}. ` +
      `This is the client's own money coming back to them — not a billing error.`

    return await emitClientChatEvent({
      contact_id: (invoice.contact_id as string | null) ?? null,
      account_id: (invoice.account_id as string | null) ?? null,
      topic: "billing",
      message,
      source: { table: "payments", id: params.credit_id },
      event_kind: "aged_credit_applied",
    })
  } catch (err) {
    console.warn(
      `[emitAgedCreditAppliedEvent] non-fatal for invoice ${params.invoice_id}:`,
      err instanceof Error ? err.message : String(err),
    )
    return { emitted: false, reason: "insert_failed", error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Retire the "Client paid …" note for an invoice whose payment has been reversed.
 *
 * ⛔ THIS IS LUCA'S ORIGINAL BUG REPORT (2026-07-22). A $1,000 wire was auto-credited to the
 * wrong company; he corrected it by hand, and the staff What's New feed went on saying that
 * company's invoice had been paid. Nothing in the codebase un-emitted a chat-event note.
 *
 * SOFT-delete, deliberately, for two reasons:
 *  1. The row is the audit trail — what was announced, and when.
 *  2. The dedup pre-check in `emitClientChatEvent` filters `deleted_at IS NULL`, so retiring
 *     this note also UNBLOCKS a correct one later. The marker
 *     (`kind=payment_received src=payments:<id>`) is permanent otherwise, which is why the
 *     genuine payment that arrived hours later produced no note at all.
 *
 * Non-fatal: a reversal must never fail because a note could not be tidied up.
 */
export async function retirePaymentReceivedNote(params: {
  paymentId: string
  /**
   * The staff user's uuid, when one is known. ⚠️ `deleted_by` is a UUID COLUMN — passing an
   * actor label like "dashboard:unlink" makes Postgres reject the whole update, and since
   * supabase-js RETURNS errors rather than throwing, the note would silently stay visible.
   * Absent ⇒ recorded as the system actor.
   */
  deletedBy?: string | null
}): Promise<{ retired: number }> {
  const marker = buildMarker({ table: "payments", id: params.paymentId }, "payment_received")
  try {
    const { data, error } = await supabaseAdmin
      .from("portal_messages")
      .update({
        deleted_at: new Date().toISOString(),
        deleted_by: params.deletedBy ?? SYSTEM_ACTOR_ID,
      })
      .eq("sender_type", "system")
      .like("message", `%${marker}%`)
      .is("deleted_at", null)
      .select("id")

    if (error) {
      console.error(
        `[retirePaymentReceivedNote] could not retire the paid note for ${params.paymentId}:`,
        error.message,
      )
      return { retired: 0 }
    }
    return { retired: (data ?? []).length }
  } catch (err) {
    console.error(
      `[retirePaymentReceivedNote] non-fatal for ${params.paymentId}:`,
      err instanceof Error ? err.message : String(err),
    )
    return { retired: 0 }
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

/**
 * Emit a "client responded to a decision request" event so staff see the answer
 * in the What's New feed. `summary` is a short human description of the answer
 * (e.g. "Approved", "Rejected — wants a different name", "Selected: Aurora").
 * Idempotent on the request id. Non-fatal.
 */
export async function emitDecisionRespondedEvent(params: {
  request_id: string
  contact_id?: string | null
  account_id?: string | null
  title: string
  summary: string
}): Promise<EmitResult> {
  const message = `Client responded to "${params.title}" — ${params.summary}.`
  return await emitClientChatEvent({
    contact_id: params.contact_id ?? null,
    account_id: params.account_id ?? null,
    topic: "decision",
    message,
    source: { table: "client_decision_requests", id: params.request_id },
    event_kind: "decision_responded",
  })
}

/**
 * Emit a "payment-plan deal ready for commission release" event. Fired by the
 * `plan-referrer-notify` cron once a plan carrying a referrer/partner is
 * genuinely fully paid — never on every payment, only on the transition to
 * eligible. Idempotent on the settling payment's id, so re-running the sweep
 * (or a retry) never double-posts for the same deal. Non-fatal by the same
 * contract as every sibling emitter here.
 */
export async function emitPlanReferrerReadyToReleaseEvent(params: {
  payment_id: string
  contact_id?: string | null
  account_id?: string | null
  message: string
}): Promise<EmitResult> {
  return await emitClientChatEvent({
    contact_id: params.contact_id ?? null,
    account_id: params.account_id ?? null,
    topic: "Referral",
    message: params.message,
    source: { table: "payments", id: params.payment_id },
    event_kind: "plan_referrer_ready_to_release",
  })
}

/**
 * Emit a "recurring invoice generated" event. Fired by the
 * `recurring-invoices` cron immediately after createTDInvoice() succeeds for
 * a due template — never on a skip/error. Idempotent on the newly-created
 * payment's id, so a same-day cron retry never double-posts (createTDInvoice
 * itself would also just return the same payment id via its own idempotency
 * key, but this guard is independent of that).
 */
export async function emitRecurringInvoiceGeneratedEvent(params: {
  payment_id: string
  contact_id?: string | null
  account_id?: string | null
  message: string
}): Promise<EmitResult> {
  return await emitClientChatEvent({
    contact_id: params.contact_id ?? null,
    account_id: params.account_id ?? null,
    topic: "Billing",
    message: params.message,
    source: { table: "payments", id: params.payment_id },
    event_kind: "recurring_invoice_generated",
  })
}

/**
 * Emit a "banking wizard submitted" event when a client submits a Payset or
 * Relay application through the portal wizard (dev job fb527ac8). Staff-only —
 * this is a SEPARATE write from the client-visible plain-text confirmation
 * that the wizard route already posts to `portal_messages`; that message is
 * left untouched on purpose, since any marker-carrying message here is hidden
 * from the client's own chat view (see app/api/portal/chat/route.ts). Pass
 * `is_resubmission: true` when the caller has confirmed (by checking the
 * `banking_submissions` row's prior status) that this is a second-or-later
 * submission for the same provider — the message wording reflects that, and
 * the caller must call `retireBankingWizardSubmittedNote` first so the
 * dedup marker below doesn't swallow this new note.
 */
export async function emitBankingWizardSubmittedEvent(params: {
  banking_submission_id: string
  contact_id?: string | null
  account_id?: string | null
  provider: string
  is_resubmission?: boolean
}): Promise<EmitResult> {
  const message = params.is_resubmission
    ? `Client resubmitted a ${params.provider} banking application via the portal wizard.`
    : `Client submitted a ${params.provider} banking application via the portal wizard.`
  return await emitClientChatEvent({
    contact_id: params.contact_id ?? null,
    account_id: params.account_id ?? null,
    topic: "Banking",
    message,
    source: { table: "banking_submissions", id: params.banking_submission_id },
    event_kind: "banking_wizard_submitted",
  })
}

/**
 * Emit a "client confirmed their financials" event (dev job 9b7892d6) when a
 * client attests their generated P&L / Balance Sheet is correct. Staff-only —
 * this route has no client-visible chat message today, so unlike the banking
 * wizard fix there is nothing pre-existing to preserve alongside it.
 *
 * Pass `is_reattestation: true` when the caller has confirmed the submission's
 * `confirmation_accepted` was already true before this call — the same
 * before/after-value pattern the wizard resubmission fixes already use — and
 * call `retireFinancialsAttestedNote` first so the dedup marker below doesn't
 * swallow the new one (the client's attestation gets RESET and re-confirmed
 * across 9 separate correction paths in lib/tax/attestation.ts, so a second,
 * genuine confirmation on the SAME submission row is a real, designed flow,
 * not an edge case).
 */
export async function emitFinancialsAttestedEvent(params: {
  tax_return_submission_id: string
  account_id?: string | null
  contact_id?: string | null
  tax_year: number
  is_reattestation?: boolean
}): Promise<EmitResult> {
  const message = params.is_reattestation
    ? `Client re-confirmed the generated P&L and Balance Sheet for ${params.tax_year} after a correction.`
    : `Client confirmed the generated P&L and Balance Sheet for ${params.tax_year}.`
  return await emitClientChatEvent({
    contact_id: params.contact_id ?? null,
    account_id: params.account_id ?? null,
    topic: "Tax",
    message,
    source: { table: "tax_return_submissions", id: params.tax_return_submission_id },
    event_kind: "financials_attested",
  })
}

/**
 * Retire the "financials attested" note for a `tax_return_submissions` row so
 * a genuine re-attestation (client corrects data, gets asked to re-confirm)
 * can produce a fresh notification. Same soft-delete rationale as the other
 * retire helpers in this file — the old row stays as audit trail.
 */
export async function retireFinancialsAttestedNote(params: {
  taxReturnSubmissionId: string
  deletedBy?: string | null
}): Promise<{ retired: number }> {
  const marker = buildMarker({ table: "tax_return_submissions", id: params.taxReturnSubmissionId }, "financials_attested")
  try {
    const { data, error } = await supabaseAdmin
      .from("portal_messages")
      .update({
        deleted_at: new Date().toISOString(),
        deleted_by: params.deletedBy ?? SYSTEM_ACTOR_ID,
      })
      .eq("sender_type", "system")
      .like("message", `%${marker}%`)
      .is("deleted_at", null)
      .select("id")

    if (error) {
      console.error(
        `[retireFinancialsAttestedNote] could not retire the note for tax_return_submissions ${params.taxReturnSubmissionId}:`,
        error.message,
      )
      return { retired: 0 }
    }
    return { retired: (data ?? []).length }
  } catch (err) {
    console.error(
      `[retireFinancialsAttestedNote] non-fatal for ${params.taxReturnSubmissionId}:`,
      err instanceof Error ? err.message : String(err),
    )
    return { retired: 0 }
  }
}

/**
 * Retire the "banking wizard submitted" note for a `banking_submissions` row
 * so a genuine resubmission (client corrects data and resubmits the same
 * provider — dev job fb527ac8) can produce a fresh notification. Same
 * SOFT-delete rationale as `retirePaymentReceivedNote`: the old row stays as
 * audit trail, and the dedup pre-check in `emitClientChatEvent` filters
 * `deleted_at IS NULL`, so retiring it unblocks the next emit for the same
 * (source.table, source.id, event_kind) marker. Call this BEFORE
 * `emitBankingWizardSubmittedEvent` whenever the caller has confirmed the
 * `banking_submissions` row was already `status='completed'` prior to this
 * submission — i.e. this is submission #2+, not #1.
 */
export async function retireBankingWizardSubmittedNote(params: {
  bankingSubmissionId: string
  deletedBy?: string | null
}): Promise<{ retired: number }> {
  const marker = buildMarker({ table: "banking_submissions", id: params.bankingSubmissionId }, "banking_wizard_submitted")
  try {
    const { data, error } = await supabaseAdmin
      .from("portal_messages")
      .update({
        deleted_at: new Date().toISOString(),
        deleted_by: params.deletedBy ?? SYSTEM_ACTOR_ID,
      })
      .eq("sender_type", "system")
      .like("message", `%${marker}%`)
      .is("deleted_at", null)
      .select("id")

    if (error) {
      console.error(
        `[retireBankingWizardSubmittedNote] could not retire the note for banking_submissions ${params.bankingSubmissionId}:`,
        error.message,
      )
      return { retired: 0 }
    }
    return { retired: (data ?? []).length }
  } catch (err) {
    console.error(
      `[retireBankingWizardSubmittedNote] non-fatal for ${params.bankingSubmissionId}:`,
      err instanceof Error ? err.message : String(err),
    )
    return { retired: 0 }
  }
}
