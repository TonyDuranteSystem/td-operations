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
 * STAFF-ONLY, DELIBERATELY (Antonio's ruling, same day, after we checked the
 * PDF's contents): on a multi-member LLC this document prints EVERY member's
 * personal tax identifiers — "ITIN", "ITIN / SSN", "Home-Country Tax ID",
 * plus the owner's local tax number and the ultimate owner's tax ID. One
 * member must never be handed another member's tax ID, and a REMOVED member
 * can still hold portal access. So `portalVisible: false` here is a privacy
 * control, not a default — do not flip it without masking those fields first.
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
      // PRIVACY: carries other members' tax IDs — see the header note.
      portalVisible: false,
      serviceDeliveryId: serviceDeliveryId ?? null,
    })
    if (res.error) return { registered: false, reason: res.error }
    return { registered: true, id: res.id }
  } catch (e) {
    return { registered: false, reason: e instanceof Error ? e.message : String(e) }
  }
}
