/**
 * E-sign per-signer delivery dispatch — the single place that decides HOW a
 * signer is reached, used by both the initial send (send route) and the
 * sequential hand-off to the next signer (submit route).
 *
 * Channel rule (Antonio, 2026-06-27):
 *  - CRM client (contact_id set) WITH a real portal login → PORTAL: the document
 *    shows in their /portal/sign list; we drop a `sign_document` portal
 *    notification (instant push + the portal-digest email nudge to log in). No
 *    direct signing link is emailed.
 *  - CRM client WITHOUT a portal login → EMAIL the direct signing link (fallback).
 *  - Third party (no contact_id) → EMAIL the direct signing link (email required,
 *    enforced at create time).
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { enqueueJob } from "@/lib/jobs/queue"
import { findAuthUserByEmail } from "@/lib/auth-admin-helpers"
import { createPortalNotification } from "@/lib/portal/notifications"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export type EsignChannel = "portal" | "email" | "none"

/**
 * Pure channel decision (unit-tested). `hasPortalLogin` is resolved by the
 * caller (a live auth lookup) so this stays side-effect-free.
 */
export function decideSignerChannel(opts: {
  contactId: string | null | undefined
  email: string | null | undefined
  hasPortalLogin: boolean
}): EsignChannel {
  if (opts.contactId && opts.hasPortalLogin) return "portal"
  if (opts.email && opts.email.trim()) return "email"
  return "none"
}

/**
 * Deliver one signer through the right channel. Returns the channel actually
 * used ("none" = undeliverable: a third party with no email, which create-time
 * validation should already prevent, or a terminal envelope).
 */
export async function dispatchSignerDelivery(opts: {
  signerId: string
  baseUrl: string
  createdBy?: string
}): Promise<EsignChannel> {
  const { data: signer } = await db
    .from("esign_signers")
    .select("id, envelope_id, name, email, contact_id, status")
    .eq("id", opts.signerId)
    .maybeSingle()
  if (!signer) return "none"

  const hasPortalLogin =
    signer.contact_id && signer.email
      ? !!(await findAuthUserByEmail(signer.email).catch(() => null))
      : false
  const channel = decideSignerChannel({
    contactId: signer.contact_id,
    email: signer.email,
    hasPortalLogin,
  })

  if (channel === "none") return "none"

  // EMAIL — reuse the durable invite-email job (retries, sandbox no-op).
  // Idempotency: atomically claim the signer (pending → sent) BEFORE enqueueing,
  // and only enqueue if we won the claim. A double "Send" click or a retry then
  // finds the signer already 'sent' and enqueues NOTHING, so the signer never
  // gets a duplicate invite email. Reminders use a separate path (not affected).
  if (channel === "email") {
    const now = new Date().toISOString()
    const { data: claimed } = await db
      .from("esign_signers")
      .update({ status: "sent", sent_at: now, updated_at: now })
      .eq("id", signer.id)
      .eq("status", "pending")
      .select("id")
      .maybeSingle()
    if (claimed) {
      await enqueueJob({
        job_type: "esign_send_email",
        payload: { signer_id: signer.id, base_url: opts.baseUrl },
        related_entity_type: "esign_envelope",
        related_entity_id: signer.envelope_id,
        created_by: opts.createdBy || "staff",
      })
    }
    return "email"
  }

  // PORTAL — surface in /portal/sign + notify (push now, digest email nudge).
  const { data: env } = await db
    .from("esign_envelopes")
    .select("document_name, owner_account_id, status")
    .eq("id", signer.envelope_id)
    .maybeSingle()
  if (env && ["voided", "expired", "completed"].includes(env.status)) return "none"

  const now = new Date().toISOString()
  await db
    .from("esign_signers")
    .update({ status: signer.status === "pending" ? "sent" : signer.status, sent_at: now, updated_at: now })
    .eq("id", signer.id)
  await db.from("esign_events").insert({
    envelope_id: signer.envelope_id,
    signer_id: signer.id,
    event_type: "sent",
    metadata: { channel: "portal" },
  })

  // Best-effort: the notification is a nudge, not the delivery itself (the doc is
  // already visible in /portal/sign). Never fail the send over a notification.
  try {
    await createPortalNotification({
      contact_id: signer.contact_id,
      account_id: env?.owner_account_id || undefined,
      type: "sign_document",
      title: `Document to sign: ${env?.document_name || "Document"}`,
      body: env?.document_name || "Document",
      link: "/portal/sign",
    })
  } catch {
    /* notification is best-effort */
  }

  return "portal"
}
