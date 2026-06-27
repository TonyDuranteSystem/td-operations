/**
 * Job Handler: esign_send_email
 *
 * Sends one signer their invite email (durable: retried by the worker on
 * failure). Payload: { signer_id, base_url }. Marks the signer `sent` + writes a
 * `sent` audit event. In sandbox the actual send is a no-op (email blocked).
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { sendSignerInvite } from "@/lib/esign/send"
import type { Job, JobResult } from "../queue"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export async function handleEsignSendEmail(job: Job): Promise<JobResult> {
  const ts = () => new Date().toISOString()
  const steps: JobResult["steps"] = []

  const signerId = job.payload.signer_id as string | undefined
  const baseUrl = (job.payload.base_url as string | undefined) || ""
  if (!signerId) {
    return { steps: [{ name: "validate", status: "error", detail: "missing signer_id", timestamp: ts() }], summary: "No signer_id" }
  }

  const { data: signer } = await db
    .from("esign_signers")
    .select("id, envelope_id, name, email, token, access_code, status")
    .eq("id", signerId)
    .maybeSingle()
  if (!signer) {
    return { steps: [{ name: "load_signer", status: "error", detail: "not found", timestamp: ts() }], summary: "Signer not found" }
  }
  if (!signer.email) {
    return { steps: [{ name: "check_email", status: "skipped", detail: "signer has no email", timestamp: ts() }], summary: "No email" }
  }

  const { data: env } = await db
    .from("esign_envelopes")
    .select("document_name, contact_id, status")
    .eq("id", signer.envelope_id)
    .maybeSingle()
  if (env && (env.status === "voided" || env.status === "expired" || env.status === "completed")) {
    return { steps: [{ name: "check_envelope", status: "skipped", detail: `envelope ${env.status}`, timestamp: ts() }], summary: "Envelope not sendable" }
  }

  // Signer language (best-effort) from a linked contact.
  let language: string | null = null
  const { data: contact } = await db.from("contacts").select("language").eq("email", signer.email).maybeSingle()
  if (contact?.language) language = contact.language

  const signUrl = `${baseUrl}/sign/${signer.token}/${signer.access_code}`
  await sendSignerInvite({
    to: signer.email,
    signerName: signer.name,
    documentName: env?.document_name || "Document",
    signUrl,
    requesterName: "Tony Durante LLC",
    language,
  })
  steps.push({ name: "send_email", status: "ok", detail: signer.email, timestamp: ts() })

  const now = ts()
  if (job.payload.reminder === true) {
    // Reminder: keep status, just record the nudge.
    await db.from("esign_events").insert({ envelope_id: signer.envelope_id, signer_id: signer.id, event_type: "reminder_sent" })
    steps.push({ name: "reminder_sent", status: "ok", timestamp: ts() })
    return { steps, summary: `Reminder sent to ${signer.email}` }
  }
  await db
    .from("esign_signers")
    .update({ status: signer.status === "pending" ? "sent" : signer.status, sent_at: now, updated_at: now })
    .eq("id", signer.id)
  await db.from("esign_events").insert({ envelope_id: signer.envelope_id, signer_id: signer.id, event_type: "sent" })
  steps.push({ name: "mark_sent", status: "ok", timestamp: ts() })

  return { steps, summary: `Invite sent to ${signer.email}` }
}
