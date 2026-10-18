/**
 * Upload a document for an account (company-level).
 *
 * Parallel to upload-document/route.ts (which is contact-centric). Uploads
 * land in the company's CRM storage under the category folder, and a documents
 * row is listed with account_id set and contact_id=null. A company with no
 * storage gets one plain sentence back (409).
 *
 * Accepts JSON body (file already in Supabase Storage):
 *   { account_id, storage_path, file_name, mime_type, document_type, category, display_name? }
 */

export const maxDuration = 60
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { NO_STORAGE_SENTENCE, NO_STORAGE_STATUS, noStorageDecisionFor } from '@/lib/crm-store/no-storage'

const CATEGORY_MAP: Record<string, { num: number; subfolder: string }> = {
  Company: { num: 1, subfolder: '1. Company' },
  Tax: { num: 3, subfolder: '3. Tax' },
  Banking: { num: 4, subfolder: '4. Banking' },
  Correspondence: { num: 5, subfolder: '5. Correspondence' },
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const {
      account_id: accountId,
      storage_path: storagePath,
      file_name: fileName,
      mime_type: mimeType,
      document_type: documentType = 'Other',
      category = 'Company',
      display_name: displayName,
    } = body

    if (!accountId || !storagePath || !fileName) {
      return NextResponse.json({ success: false, detail: 'Missing account_id, storage_path, or file_name' }, { status: 400 })
    }

    const catInfo = CATEGORY_MAP[category] || CATEGORY_MAP.Correspondence

    // Download from Supabase Storage
    const { data: blob, error: dlErr } = await supabaseAdmin.storage
      .from('onboarding-uploads')
      .download(storagePath)

    if (dlErr || !blob) {
      return NextResponse.json({ success: false, detail: `Storage download failed: ${dlErr?.message || 'no data'}` }, { status: 500 })
    }

    // A refused upload must not leave the staged object behind.
    const discardStaged = () => { supabaseAdmin.storage.from('onboarding-uploads').remove([storagePath]).catch(() => {}) }

    const buffer = Buffer.from(await blob.arrayBuffer())
    const fileMime = mimeType || blob.type || 'application/pdf'

    // Get account info
    const { data: account } = await supabaseAdmin
      .from('accounts')
      .select('company_name')
      .eq('id', accountId)
      .single()

    if (!account) {
      return NextResponse.json({ success: false, detail: 'Account not found' }, { status: 404 })
    }

    // Choose the final filename — prefer explicit display_name (preserving
    // the extension from the original file), else keep the original name.
    const ext = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.')) : ''
    const sanitizedDisplay = (displayName || '').trim()
    const finalFileName = sanitizedDisplay
      ? sanitizedDisplay.toLowerCase().endsWith(ext.toLowerCase())
        ? sanitizedDisplay
        : `${sanitizedDisplay}${ext}`
      : fileName

    // The file (and its CRM record) is saved in the company's storage.
    {
      const { saveDocumentForAccount, CompanyMovingError } = await import('@/lib/crm-store/save-for-account')
      const { createHash } = await import('crypto')
      let routed
      try {
        routed = await saveDocumentForAccount({
          accountId, name: finalFileName, bytes: buffer, mimeType: fileMime,
          folder: catInfo.num === 1 ? 'company' : catInfo.num === 3 ? 'tax' : catInfo.num === 4 ? 'banking' : 'correspondence',
          documentType: null,
          callerKey: `staff-account-upload:${accountId}:${catInfo.num}:${createHash('sha256').update(buffer).digest('hex')}`,
          portalVisible: body.visible === true,   // hidden from the client unless chosen on purpose (Antonio 2026-10-13)
          row: { document_type_name: documentType, category: catInfo.num, category_name: category, status: 'classified', contact_id: null },
        })
      } catch (e) {
        if (e instanceof CompanyMovingError) return NextResponse.json({ success: false, detail: e.message }, { status: 409 }) // transient: the staged file is kept so "try again" works
        throw e
      }
      if (routed.route === 'store') {
        const { notifyClientsOfNewDocument } = await import('@/lib/portal/document-alerts')
        notifyClientsOfNewDocument(routed.documentRowId).catch((e) =>
          console.warn('[upload-account-document] new-document alert failed:', e instanceof Error ? e.message : String(e)))
        await supabaseAdmin.from('action_log').insert({
          actor: 'crm-admin',
          action_type: 'upload_account_document',
          table_name: 'documents',
          record_id: routed.pointer,
          account_id: accountId,
          summary: `Account document uploaded to the new storage: ${finalFileName} (${documentType})`,
          details: { file_name: finalFileName, document_type: documentType, category, account_id: accountId, store_file_id: routed.fileId },
        })
        supabaseAdmin.storage.from('onboarding-uploads').remove([storagePath]).catch(() => {})
        return NextResponse.json({
          success: true,
          detail: `${finalFileName} saved to ${catInfo.subfolder}`,
          driveFileId: routed.pointer,
          side_effects: [`Saved to the new storage: ${finalFileName}`, 'Document record created'],
        })
      }
    }

    // No storage: a company left on its old folder carries on as before; everyone else gets one plain sentence.
    const decision = await noStorageDecisionFor(accountId)
    if (decision.route === 'refuse') {
      discardStaged()
      return NextResponse.json({ success: false, detail: NO_STORAGE_SENTENCE }, { status: NO_STORAGE_STATUS })
    }

    // Find target subfolder
    const { listFolderAnyDrive, uploadBinaryToDrive } = await import('@/lib/google-drive')
    const foldersRes = await listFolderAnyDrive(decision.folderId)
    const folders = (foldersRes as { files?: Array<{ id: string; name: string; mimeType: string }> }).files ?? []
    const targetFolder = folders.find(
      (f: { name: string; mimeType: string }) => f.name === catInfo.subfolder && f.mimeType === 'application/vnd.google-apps.folder',
    )
    const uploadFolderId = targetFolder?.id || decision.folderId

    // Upload to Drive
    const driveFile = await uploadBinaryToDrive(finalFileName, buffer, fileMime, uploadFolderId) as { id: string; name: string }

    const sideEffects: string[] = [`Uploaded to Drive: ${finalFileName}`]

    // Create document record (idempotent on drive_file_id)
    const { data: existingDoc } = await supabaseAdmin
      .from('documents')
      .select('id')
      .eq('drive_file_id', driveFile.id)
      .limit(1)

    if (!existingDoc?.length) {
      const { data: newDoc } = await supabaseAdmin.from('documents').insert({
        file_name: finalFileName,
        drive_file_id: driveFile.id,
        drive_link: `https://drive.google.com/file/d/${driveFile.id}/view`,
        document_type_name: documentType,
        category: catInfo.num,
        category_name: category,
        status: 'classified',
        account_id: accountId,
        contact_id: null,
        portal_visible: true,
      }).select('id').single()
      sideEffects.push('Document record created')

      // Alert the client of the new document (in-portal + push; digest email for
      // non-push users). Fire-and-forget — never block the upload response.
      if (newDoc?.id) {
        const { notifyClientsOfNewDocument } = await import('@/lib/portal/document-alerts')
        notifyClientsOfNewDocument(newDoc.id as string).catch((e) =>
          console.warn('[upload-account-document] new-document alert failed:', e instanceof Error ? e.message : String(e)))
      }
    }

    // Log action
    await supabaseAdmin.from('action_log').insert({
      actor: 'crm-admin',
      action_type: 'upload_account_document',
      table_name: 'documents',
      record_id: driveFile.id,
      account_id: accountId,
      summary: `Account document uploaded: ${finalFileName} (${documentType})`,
      details: { file_name: finalFileName, document_type: documentType, category, account_id: accountId },
    })

    // Clean up storage file (best-effort)
    supabaseAdmin.storage.from('onboarding-uploads').remove([storagePath]).catch(() => {})

    return NextResponse.json({
      success: true,
      detail: `${finalFileName} uploaded to ${catInfo.subfolder}`,
      driveFileId: driveFile.id,
      side_effects: sideEffects,
    })
  } catch (e) {
    console.error('[upload-account-document] Error:', e)
    return NextResponse.json({ success: false, detail: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
