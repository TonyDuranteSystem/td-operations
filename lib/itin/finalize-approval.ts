/**
 * ITIN approval finalization — runs when the IRS approval letter (CP565) is
 * uploaded at the workspace "ITIN Approved" stage.
 *
 * Born from the Martin Csordas case (2026-07-06, Luca's report): the workspace
 * upload just filed the letter and the flow dead-ended — no ITIN number on the
 * contact, no client message, banner + pipeline stuck "in progress" forever.
 * The CRM contact-page upload has always done the smart part (OCR → extract →
 * stamp); this module brings the same behavior to the workspace door and adds
 * the missing finalization step.
 *
 * Pipeline (each step gated on the previous one succeeding):
 *   1. OCR the letter bytes (Document AI, ocrRawContent — no Drive round-trip,
 *      works in sandbox where Drive is mocked).
 *   2. Extract the ITIN (shared extractItinFromOcr) + issue date from the text.
 *   3. Stamp contacts.itin_number / itin_issue_date / itin_renewal_date via
 *      writeITINFields (the canonical single write path).
 *   4. Complete the SD in place (completeSDInPlace, TOCTOU-guarded — the
 *      terminal "ITIN Approved" stage never flips status by name). This is
 *      what clears the CRM "in progress" banner and turns the pipeline green.
 *   5. ONLY when this call won the completion (guards double-upload races):
 *      notify the client via the standard 3-channel dispatcher
 *      (notifyClientActionRequired: flow-threaded chat + bell/push + immediate
 *      bilingual email, deep link /portal/documents).
 *
 * OCR/extraction failures NEVER fail the upload — the letter is already
 * filed. They surface as warnings so staff can fix the scan or enter the
 * ITIN manually on the contact. The SD then stays active for a retry upload.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { extractItinFromOcr, parseItinIssueDateFromOcr } from "@/lib/ocr-helpers"

/** Mime types Document AI accepts — same list the CRM upload route uses. */
const OCR_SUPPORTED_MIME = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/tiff",
  "image/gif",
  "image/bmp",
  "image/webp",
]

export interface ItinFinalizeResult {
  /** False only when the guard checks skipped the whole pipeline. */
  attempted: boolean
  /** True when contact stamped + SD completed (client notified best-effort). */
  finalized: boolean
  itin_number?: string
  itin_issue_date?: string
  itin_renewal_date?: string | null
  /** Staff-facing messages: what didn't happen and what to do about it. */
  warnings: string[]
  /** Per-channel client-notification outcomes (when dispatched). */
  notify?: { chat: string; notification: string; email: string }
}

export async function finalizeItinApproval(opts: {
  serviceDeliveryId: string
  contactId: string
  fileName: string
  /** Raw letter bytes (already downloaded by the upload route). */
  content: ArrayBuffer
  mimeType: string
}): Promise<ItinFinalizeResult> {
  const warnings: string[] = []
  const result: ItinFinalizeResult = { attempted: true, finalized: false, warnings }

  try {
    // 0. Guards — an already-completed flow never re-finalizes or re-notifies.
    const { data: sd } = await supabaseAdmin
      .from("service_deliveries")
      .select("id, status, stage, service_type, contact_id, account_id, service_name, due_date, stage_entered_at, created_at")
      .eq("id", opts.serviceDeliveryId)
      .single()
    if (!sd) {
      warnings.push("Flow not found — ITIN not extracted. Enter it manually on the contact.")
      return result
    }
    if (sd.status !== "active") {
      warnings.push(`Flow is already ${sd.status} — letter filed, nothing re-processed.`)
      return result
    }
    if (!OCR_SUPPORTED_MIME.includes(opts.mimeType)) {
      warnings.push(`File type ${opts.mimeType} can't be OCR'd — upload a PDF or image, or enter the ITIN manually on the contact.`)
      return result
    }

    // 1. OCR.
    let fullText = ""
    try {
      const { ocrRawContent } = await import("@/lib/docai")
      const ocr = await ocrRawContent(opts.content, opts.mimeType, opts.fileName)
      fullText = ocr.fullText ?? ""
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      warnings.push(
        `OCR failed (${msg.includes("too large") ? "file too large for OCR — max 15MB" : msg}). ` +
          "Letter filed; enter the ITIN manually on the contact or re-upload a smaller scan.",
      )
      return result
    }

    // 2. Extract.
    const itin = extractItinFromOcr(fullText)
    if (!itin) {
      warnings.push(
        "OCR ran but found no ITIN number (expected 9XX-XX-XXXX). " +
          "Letter filed; check the scan quality or enter the ITIN manually on the contact.",
      )
      return result
    }
    const issueDate = parseItinIssueDateFromOcr(fullText)

    // 3. Stamp the contact (canonical write path — computes the renewal date).
    const { writeITINFields } = await import("@/lib/itin/write-itin-fields")
    const { itin_renewal_date } = await writeITINFields(opts.contactId, {
      itin_number: itin,
      itin_issue_date: issueDate,
    })
    result.itin_number = itin
    result.itin_issue_date = issueDate
    result.itin_renewal_date = itin_renewal_date

    // 4. Complete the flow in place. Only the call that flips active→completed
    // sends the client notification (double-upload race guard).
    const { completeSDInPlace } = await import("@/lib/operations/service-delivery")
    const { completed } = await completeSDInPlace(opts.serviceDeliveryId, {
      actor: "itin-finalize",
      notes: `ITIN approval letter processed (${opts.fileName}) — ITIN saved to contact, flow completed`,
    })
    if (!completed) {
      warnings.push("Contact updated, but the flow was already completed — client not re-notified.")
      return result
    }
    result.finalized = true

    // 5. Notify the client (best-effort — never fails the finalize).
    const { notifyClientActionRequired } = await import("@/lib/portal/action-required")
    const { buildFlowTopic, deriveFlowYear } = await import("@/lib/flows/resolve-flows")
    const topic = buildFlowTopic(sd.service_type, deriveFlowYear(sd)) || null
    const notify = await notifyClientActionRequired({
      contact_id: opts.contactId,
      account_id: sd.account_id ?? null,
      service_delivery_id: opts.serviceDeliveryId,
      topic,
      title: {
        en: "Your ITIN is ready",
        it: "Il tuo ITIN è pronto",
      },
      message: {
        en: "Great news — the IRS has approved your ITIN application! Your official ITIN letter (CP565) is now available in your portal under Documents.",
        it: "Ottima notizia — l'IRS ha approvato la tua richiesta ITIN! La lettera ufficiale (CP565) è ora disponibile nel tuo portale nella sezione Documenti.",
      },
      link: "/portal/documents",
      ctaLabel: { en: "View document", it: "Vedi documento" },
    })
    result.notify = { chat: notify.chat, notification: notify.notification, email: notify.email }

    return result
  } catch (err) {
    // Backstop: the upload that triggered us already succeeded — never throw.
    warnings.push(`ITIN finalize failed: ${err instanceof Error ? err.message : String(err)}`)
    return result
  }
}
