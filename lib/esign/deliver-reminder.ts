/**
 * Deliver ONE reminder to ONE signer, through whichever channel that signer
 * uses. Shared by the automatic cron and the staff "Send reminder" button so
 * the two can never drift apart.
 *
 * WHY THIS IS NOT `dispatchSignerDelivery` (the existing send helper):
 * that helper is for the FIRST delivery. Reusing it for reminders breaks three
 * things at once — it rewrites `sent_at` (which is the clock the quiet period
 * is measured from, so every nudge would restart the timer), it writes a `sent`
 * audit event (a legal trail claiming the document was sent five times when it
 * was sent once), and for an email signer its pending→sent claim makes it a
 * silent no-op. Reminders need their own path.
 *
 * PORTAL SIGNERS: the reminder is a fresh portal notification — bell row, web
 * push, and the portal-digest email nudge. It is NOT an email carrying the
 * direct signing link: portal signers are deliberately reached through the
 * portal, and mailing them a bare link would bypass that decision.
 *
 * EVERY path writes a `reminder_sent` event tagged with its source. That row is
 * the cadence counter AND the throttle: if it is missing, the automatic job has
 * no memory and re-nudges the same person every time it runs.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { enqueueJob } from "@/lib/jobs/queue"
import { createPortalNotification } from "@/lib/portal/notifications"
import { insertEsignEvent, type ReminderSource } from "@/lib/esign/events"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export type ReminderOutcome = "email" | "portal" | "undeliverable"

export interface ReminderSigner {
  id: string
  envelope_id: string
  name: string | null
  email: string | null
  contact_id: string | null
  delivery_channel: string | null
}

/**
 * Send one reminder. `baseUrl` must be the CALLER's link base (the request
 * origin on sandbox/preview), never a hardcoded production URL — otherwise a
 * sandbox reminder mails a production link that cannot resolve the token.
 */
export async function deliverReminder(opts: {
  signer: ReminderSigner
  envelope: { id: string; document_name: string | null; owner_account_id: string | null }
  baseUrl: string
  source: ReminderSource
  createdBy?: string
}): Promise<ReminderOutcome> {
  const { signer, envelope, baseUrl, source } = opts

  // PORTAL — re-notify in place. No sent_at rewrite, no 'sent' event.
  if (signer.delivery_channel === "portal") {
    if (!signer.contact_id) return "undeliverable"
    try {
      await createPortalNotification({
        contact_id: signer.contact_id,
        account_id: envelope.owner_account_id || undefined,
        type: "sign_document",
        title: `Reminder — document to sign: ${envelope.document_name || "Document"}`,
        body: envelope.document_name || "Document",
        link: "/portal/sign",
      })
    } catch {
      return "undeliverable"
    }
    await insertEsignEvent({
      envelope_id: envelope.id,
      signer_id: signer.id,
      event_type: "reminder_sent",
      metadata: { source, channel: "portal", by: opts.createdBy || null },
    })
    return "portal"
  }

  // EMAIL — durable job, retried by the worker. The handler writes no
  // reminder event of its own (it cannot know the source), so the event is
  // written here, at the decision point.
  if (!signer.email) return "undeliverable"
  await enqueueJob({
    job_type: "esign_send_email",
    payload: { signer_id: signer.id, base_url: baseUrl, reminder: true },
    related_entity_type: "esign_envelope",
    related_entity_id: envelope.id,
    created_by: opts.createdBy || "system",
  })
  await insertEsignEvent({
    envelope_id: envelope.id,
    signer_id: signer.id,
    event_type: "reminder_sent",
    metadata: { source, channel: "email", by: opts.createdBy || null },
  })
  return "email"
}

/**
 * Load the reminder timestamps for a set of signers in ONE query.
 * Returns a map of signer id → reminder times, newest first.
 */
export async function loadReminderTimes(signerIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  if (!signerIds.length) return out
  const { data } = await db
    .from("esign_events")
    .select("signer_id, created_at")
    .in("signer_id", signerIds)
    .eq("event_type", "reminder_sent")
    .order("created_at", { ascending: false })
  for (const row of (data ?? []) as Array<{ signer_id: string | null; created_at: string }>) {
    if (!row.signer_id) continue
    const list = out.get(row.signer_id) ?? []
    list.push(row.created_at)
    out.set(row.signer_id, list)
  }
  return out
}

/** When was this envelope last reopened? Anchors the reminder cycle. */
export async function lastReopenedAt(envelopeId: string): Promise<string | null> {
  const { data } = await db
    .from("esign_events")
    .select("created_at")
    .eq("envelope_id", envelopeId)
    .eq("event_type", "reopened")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  return data?.created_at ?? null
}
