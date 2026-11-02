/**
 * Bank application intake — SUBMITS a reviewed application to the bank contact (the "Submit to …" button).
 *
 * Antonio 2026-11-02: an application is never emailed on its own any more. It waits; staff mark it Reviewed; a person presses
 * Submit. This file is the ONLY place that sends the application outside the company, and the Reviewed rule is enforced
 * INSIDE the send claim, so no route, button or script can get around it.
 *
 * R037 shape: (1) atomically CLAIM the send (email_status -> 'sending', only for a Reviewed, not-sent-back application, from
 * null / failed / a send stuck for 5 minutes), (2) send, (3) record the outcome AFTER. A double click or a retry can never
 * email twice. A failed send is retried by pressing Submit again (there is no separate Resend: it used to be the way
 * around the review).
 *
 * The addresses come from the Forms-card setting, read now, and the caller must pass the list its confirm box showed:
 * if the setting changed in between, nothing is sent.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { BOFA_DOC_SLOTS } from "./schema"
import { readSubmissionFile, signedUrlForSubmissionFile, type SubmissionFile } from "./files"
import { BOFA_MAX_ATTACH_BYTES, buildDeliveryHtml, buildMime, buildSubject, type DeliveryFile } from "./email"
import { loadBofaSettings, sameAddresses } from "./settings"

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

/** Why a claim found nothing, in words for the person who pressed the button. */
async function whyNotReady(id: string): Promise<string> {
  const { data } = await table().select("status, email_status, reviewed_at, returned_at").eq("id", id).maybeSingle()
  if (!data) return "Application not found."
  if (data.status !== "completed") return "This application has not been submitted by the client yet."
  if (data.returned_at) return "This application was sent back to the client. Review the new one when it arrives."
  if (!data.reviewed_at) return "Mark it Reviewed first."
  if (data.email_status === "sent") return "This application was already submitted."
  if (data.email_status === "sending") return "It is being submitted right now. Wait a moment, then reload."
  return "This application is not ready to submit."
}

/**
 * @param by        the staff login pressing Submit (recorded as sent_by)
 * @param confirmTo the addresses the confirm box showed; must still be the saved setting
 */
export async function deliverSubmission(id: string, opts: { by: string; confirmTo: string[] }): Promise<DeliverResult> {
  // 0. where it goes: the saved setting, which must be what the person just confirmed
  const settings = await loadBofaSettings()
  if (!settings.readable) return { ok: false, error: "Could not read the Submit settings. Nothing was sent." }
  const recipients = settings.submitTo?.emails ?? []
  if (recipients.length === 0) return { ok: false, error: "No address is set for submitting applications. Set it on the Forms page, in the Bank account application card." }
  if (!sameAddresses(recipients, opts.confirmTo)) {
    return { ok: false, error: "The submit address changed after you opened this. Reload the page and check it again. Nothing was sent." }
  }

  // 1. claim — only one caller can move the row into 'sending', and only a Reviewed, not-sent-back application
  const startedAt = new Date().toISOString()
  const claimBase = () =>
    table()
      .update({ email_status: "sending", email_error: null, sent_by: opts.by, updated_at: startedAt })
      .eq("id", id)
      .eq("status", "completed")
      .not("reviewed_at", "is", null)
      .is("returned_at", null)
  const select = "id, form_data, files"
  let claim = await claimBase().is("email_status", null).select(select).maybeSingle()
  if (!claim?.data && !claim?.error) claim = await claimBase().eq("email_status", "failed").select(select).maybeSingle()
  if (!claim?.data && !claim?.error) {
    // A send that died mid-way leaves 'sending' behind; after 5 minutes Submit may take it over.
    claim = await claimBase()
      .eq("email_status", "sending")
      .lt("updated_at", new Date(Date.now() - 5 * 60 * 1000).toISOString())
      .select(select)
      .maybeSingle()
  }
  if (claim?.error) return { ok: false, error: "Could not start the submit." }
  const row = claim?.data as { form_data: Record<string, string>; files: SubmissionFile[] } | null
  if (!row) return { ok: false, error: await whyNotReady(id) }

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

    const raw = buildMime({ to: recipients, subject: buildSubject(row.form_data), html: buildDeliveryHtml(row.form_data, files), files })
    const { gmailPost } = await import("@/lib/gmail")
    await gmailPost("/messages/send", { raw: Buffer.from(raw).toString("base64url") })

    // 3. record the outcome AFTER the send
    // The email is already out, so a failed write here must not be shrugged off: try once more, then say so loudly. The row
    // would stay 'sending'; the staff page shows that as "may already have been sent" (review-state.ts::isStaleSending).
    const record = () =>
      table()
        .update({ email_status: "sent", email_sent_at: new Date().toISOString(), email_error: null, sent_to: recipients, updated_at: new Date().toISOString() })
        .eq("id", id)
    let { error: recordErr } = await record()
    if (recordErr) {
      await new Promise((r) => setTimeout(r, 500))
      recordErr = (await record()).error
    }
    if (recordErr) console.error("[bofa-intake] the application WAS SENT to the bank contact but the record could not be saved:", id, recordErr.message)
    return { ok: true, sentTo: recipients }
  } catch (e) {
    return fail(e instanceof Error ? e.message : "The email could not be sent.")
  }
}
