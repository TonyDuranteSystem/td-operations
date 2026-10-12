/**
 * Bank application intake — emails a SUBMITTED application to the addresses chosen at link creation.
 * Used by the submit route (automatic, once) and the staff "Resend email" button.
 *
 * Follows the R037 shape: (1) atomically CLAIM the send (email_status -> 'sending', only from null /
 * failed / — for an explicit resend — sent), (2) send, (3) write the outcome AFTER. A double submit or
 * a retry can therefore never email twice on its own.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { BOFA_DOC_SLOTS } from "./schema"
import { readSubmissionFile, signedUrlForSubmissionFile, type SubmissionFile } from "./files"
import { BOFA_MAX_ATTACH_BYTES, buildDeliveryHtml, buildMime, buildSubject, type DeliveryFile } from "./email"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- new table not in the generated DB types
const table = () => (supabaseAdmin as any).from("bofa_intake_requests")

export type DeliverResult = { ok: true; sentTo: string[] } | { ok: false; error: string }

const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  heic: "image/heic",
  heif: "image/heif",
  webp: "image/webp",
}

function mimeFor(name: string): string {
  return MIME_BY_EXT[name.toLowerCase().split(".").pop() ?? ""] ?? "application/octet-stream"
}

/** @param resend true for the staff button: allowed even when a previous send succeeded. */
export async function deliverSubmission(id: string, resend = false): Promise<DeliverResult> {
  const allowedFrom = resend ? ["failed", "sent"] : ["failed"]
  // 1. claim — only one caller can move the row into 'sending'
  let claim = await table()
    .update({ email_status: "sending", email_error: null, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "completed")
    .is("email_status", null)
    .select("id, recipients, form_data, files")
    .maybeSingle()
  if (!claim?.data && !claim?.error) {
    claim = await table()
      .update({ email_status: "sending", email_error: null, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("status", "completed")
      .in("email_status", allowedFrom)
      .select("id, recipients, form_data, files")
      .maybeSingle()
  }
  if (resend && !claim?.data && !claim?.error) {
    // A send that died mid-way leaves 'sending' behind; after 5 minutes the staff button may take it over.
    claim = await table()
      .update({ email_status: "sending", email_error: null, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("status", "completed")
      .eq("email_status", "sending")
      .lt("updated_at", new Date(Date.now() - 5 * 60 * 1000).toISOString())
      .select("id, recipients, form_data, files")
      .maybeSingle()
  }
  if (claim?.error) return { ok: false, error: "Could not start the email." }
  const row = claim?.data as { recipients: string[]; form_data: Record<string, string>; files: SubmissionFile[] } | null
  if (!row) return { ok: false, error: "This application is not ready to email, or an email is already being sent." }
  if (!row.recipients?.length) {
    await table().update({ email_status: null, updated_at: new Date().toISOString() }).eq("id", id)
    return { ok: false, error: "No email address was set for this link." }
  }

  const fail = async (error: string): Promise<DeliverResult> => {
    await table().update({ email_status: "failed", email_error: error.slice(0, 500), updated_at: new Date().toISOString() }).eq("id", id)
    return { ok: false, error }
  }

  try {
    // 2. load the documents, attach them when they fit, otherwise send 7-day links
    const loaded: { label: string; file: SubmissionFile; content: Buffer }[] = []
    let total = 0
    for (const f of row.files ?? []) {
      const content = await readSubmissionFile(f)
      if (!content) return fail(`Could not read the file "${f.name}" from storage.`)
      total += content.length
      loaded.push({ label: BOFA_DOC_SLOTS.find((s) => s.key === f.key)?.label ?? f.key, file: f, content })
    }
    let files: DeliveryFile[]
    if (total <= BOFA_MAX_ATTACH_BYTES) {
      files = loaded.map((f) => ({ label: f.label, name: f.file.name, content: f.content, contentType: mimeFor(f.file.name) }))
    } else {
      files = []
      for (const f of loaded) {
        const url = await signedUrlForSubmissionFile(f.file, 60 * 60 * 24 * 7)
        if (!url) return fail(`Could not make a download link for "${f.file.name}".`)
        files.push({ label: f.label, name: f.file.name, url })
      }
    }

    const raw = buildMime({ to: row.recipients, subject: buildSubject(row.form_data), html: buildDeliveryHtml(row.form_data, files), files })
    const { gmailPost } = await import("@/lib/gmail")
    await gmailPost("/messages/send", { raw: Buffer.from(raw).toString("base64url") })

    // 3. record the outcome AFTER the send
    await table()
      .update({ email_status: "sent", email_sent_at: new Date().toISOString(), email_error: null, updated_at: new Date().toISOString() })
      .eq("id", id)
    return { ok: true, sentTo: row.recipients }
  } catch (e) {
    return fail(e instanceof Error ? e.message : "The email could not be sent.")
  }
}
