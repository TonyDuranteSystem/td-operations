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
      status: 'classified',
      confidence: 1.0,
      processed_at: new Date().toISOString(),
      portal_visible: params.portalVisible ?? false,
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
