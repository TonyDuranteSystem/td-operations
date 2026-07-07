/**
 * Auto-save a document to the portal's documents table.
 *
 * Called when signed documents are created (contract, OA, lease, ITIN forms)
 * so they automatically appear in the client's portal Documents page.
 *
 * Does NOT do OCR/classification — just creates a record with known type.
 *
 * Phase B (ITIN Chain Fix 2026-05-11): supports contact-only documents
 * (contactId without accountId) for pure contact-only ITIN clients who don't
 * own an LLC. Exactly one of accountId / contactId must be set.
 */

import { supabaseAdmin } from '@/lib/supabase-admin'

interface AutoSaveDocumentParams {
  /** Set when the document belongs to a company account. */
  accountId?: string
  /** Set when the document belongs to a contact only (e.g. contact-only ITIN). */
  contactId?: string
  fileName: string
  documentType: string  // e.g. 'Signed Contract', 'Operating Agreement', 'Lease Agreement', 'ITIN W-7'
  category: number      // 1=Company, 2=Contacts, 3=Tax, 4=Banking, 5=Correspondence
  driveFileId?: string
  portalVisible?: boolean  // true = visible to client in portal Documents page
  /** Link the document to a service_delivery (flow) so it appears in the flow
   *  workspace / portal flow detail page (which query by service_delivery_id). */
  serviceDeliveryId?: string | null
}

export async function autoSaveDocument(params: AutoSaveDocumentParams): Promise<{ id?: string; error?: string }> {
  const { accountId, contactId, fileName, documentType, category, driveFileId } = params

  if (!accountId && !contactId) {
    return { error: 'autoSaveDocument requires accountId or contactId' }
  }

  try {
    // Check if already exists (idempotent)
    if (driveFileId) {
      const { data: existing } = await supabaseAdmin
        .from('documents')
        .select('id')
        .eq('drive_file_id', driveFileId)
        .limit(1)
        .maybeSingle()

      if (existing) {
        return { id: existing.id }
      }
    }

    const record: Record<string, unknown> = {
      account_id: accountId ?? null,
      contact_id: contactId ?? null,
      file_name: fileName,
      document_type_name: documentType,
      category,
      drive_file_id: driveFileId || null,
      // The CRM account Documents tab and portal viewers render a clickable
      // link ONLY from drive_link — rows without it show a dead "No link"
      // (171 such rows existed before the 2026-07-07 fix + backfill). The
      // Drive view URL is derived from the file id. Sentinel ids (they carry
      // a ':', e.g. "storage:<path>" / "ss4-live:<token>") are NOT Drive
      // files — never fabricate a drive.google.com URL for them.
      drive_link: driveFileId && !driveFileId.includes(':')
        ? `https://drive.google.com/file/d/${driveFileId}/view`
        : null,
      status: 'classified',
      // Must be one of 'high' | 'medium' | 'low' — the production `documents`
      // table has a CHECK constraint (documents_confidence_check) enforcing
      // exactly those values. The previous numeric `1.0` violated it, so EVERY
      // autoSaveDocument insert (ITIN W-7/1040-NR/Schedule OI, signed OA, lease,
      // contract) failed in production and was silently swallowed — the root
      // cause of "docs in Drive but not in the documents table" (Daniel Pasztor,
      // 2026-06-25). Sandbox lacks the constraint, which masked it. 'high' =
      // these are deterministically-generated/known docs (full confidence).
      confidence: 'high',
      processed_at: new Date().toISOString(),
      portal_visible: params.portalVisible ?? false,
      // service_delivery_id isn't in the generated DB types yet; included in the
      // untyped record (insert is cast `as never`).
      ...(params.serviceDeliveryId ? { service_delivery_id: params.serviceDeliveryId } : {}),
    }

    const { data, error } = await supabaseAdmin
      .from('documents')
      .insert(record as never)
      .select('id')
      .single()

    if (error) {
      console.error('[auto-save-doc] Insert error:', error.message)
      return { error: error.message }
    }

    return { id: data.id }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[auto-save-doc] Error:', msg)
    return { error: msg }
  }
}
