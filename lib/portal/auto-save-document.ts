/**
 * Auto-save a document to the portal's documents table.
 *
 * Called when signed documents are created (contract, OA, lease)
 * so they automatically appear in the client's portal Documents page.
 *
 * Does NOT do OCR/classification — just creates a record with known type.
 */

import { supabaseAdmin } from '@/lib/supabase-admin'

interface AutoSaveDocumentParams {
  accountId: string
  fileName: string
  documentType: string  // e.g. 'Signed Contract', 'Operating Agreement', 'Lease Agreement'
  category: number      // 1=Company, 2=Contacts, 3=Tax, 4=Banking, 5=Correspondence
  driveFileId?: string
  storagePath?: string  // Supabase Storage path
  storageBucket?: string
}

export async function autoSaveDocument(params: AutoSaveDocumentParams): Promise<{ id?: string; error?: string }> {
  const { accountId, fileName, documentType, category, driveFileId, storagePath, storageBucket } = params

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

    const { data, error } = await supabaseAdmin
      .from('documents')
      .insert({
        account_id: accountId,
        file_name: fileName,
        document_type_name: documentType,
        category,
        drive_file_id: driveFileId || null,
        storage_path: storagePath || null,
        storage_bucket: storageBucket || null,
        status: 'classified',
        confidence: 1.0,
        processed_at: new Date().toISOString(),
      })
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
