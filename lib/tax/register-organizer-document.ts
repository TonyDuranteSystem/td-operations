/**
 * Register the tax organizer PDF (the client's submitted questionnaire) as a
 * real document on the client's record.
 *
 * WHY (card c5ff8b4d, Antonio 2026-08-12): the PDF was generated at submission
 * and written to Drive — and then registered NOWHERE. It was invisible in the
 * client's document list and in the staff room's documents panel. Registration
 * was never lost; it never existed (the Drive-save helper has no documents
 * insert). The only rows that ever appeared came from an unrelated Drive folder
 * scan run Apr–May 2026, which is why they stop dead on 2026-05-07.
 *
 * CLIENT-VISIBLE COMPANY DOCUMENT — Antonio's ruling (card c5ff8b4d): "The tax
 * data sent by the client is not something secret for the members, so it must
 * go in the company folder and documents." Members of one LLC file a SINGLE
 * return together; the data they jointly submitted — including each member's
 * tax identifiers — is not confidential between them. No masking, no
 * staff-only. DECISION CLOSED: do not re-open it, and do not "harden" this
 * back to staff-only on privacy instinct.
 *
 * Attached to the service delivery so it appears in the tax room's documents
 * panel, which is where staff work. Idempotent by Drive file id (the helper
 * checks), so a re-submit or a re-run cannot duplicate the row.
 */

import { autoSaveDocument } from "@/lib/portal/auto-save-document"

/** Drive category 3 = Tax (see autoSaveDocument's category contract). */
const CATEGORY_TAX = 3

export interface RegisterOrganizerParams {
  accountId: string
  driveFileId: string
  companyName?: string | null
  taxYear?: number | null
  /** Links the document into the tax room's documents panel. */
  serviceDeliveryId?: string | null
}

export interface RegisterOrganizerResult {
  registered: boolean
  id?: string
  reason?: string
}

export function organizerDocumentName(companyName?: string | null, taxYear?: number | null): string {
  const company = (companyName ?? "").trim()
  const year = taxYear ? ` ${taxYear}` : ""
  return company ? `Tax Questionnaire${year} — ${company}` : `Tax Questionnaire${year}`
}

/**
 * Never throws: a registration failure must not break the submission chain the
 * client already saw succeed. Returns why it skipped so the caller can log it.
 */
export async function registerOrganizerDocument(
  params: RegisterOrganizerParams,
): Promise<RegisterOrganizerResult> {
  const { accountId, driveFileId, companyName, taxYear, serviceDeliveryId } = params
  if (!accountId || !driveFileId) {
    return { registered: false, reason: "missing account or drive file id" }
  }
  try {
    const res = await autoSaveDocument({
      accountId,
      fileName: organizerDocumentName(companyName, taxYear),
      documentType: "Tax Questionnaire",
      category: CATEGORY_TAX,
      driveFileId,
      // Client-visible by ruling — the company's own submitted tax data.
      portalVisible: true,
      serviceDeliveryId: serviceDeliveryId ?? null,
    })
    if (res.error) return { registered: false, reason: res.error }
    return { registered: true, id: res.id }
  } catch (e) {
    return { registered: false, reason: e instanceof Error ? e.message : String(e) }
  }
}
