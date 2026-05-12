/**
 * Upload a document attached to a specific DBA (dba_details row).
 *
 * Flow (mirrors upload-account-document):
 *  1. Download file from Supabase Storage (onboarding-uploads bucket).
 *  2. Upload to the account's Drive folder under "1. Company".
 *  3. Insert a documents row with document_type_name='DBA Application' and
 *     account_id set (no contact_id).
 *  4. Best-effort OCR via lib/docai.ts::ocrDriveFile. If text is returned,
 *     attempt conservative regex extraction of filed_date and
 *     registration_number. Only fill fields that are currently empty on the
 *     dba_details row — never overwrite operator-entered data.
 *
 * Accepts JSON body:
 *   { storage_path, file_name, mime_type? }
 */

export const maxDuration = 60
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { extractDbaFieldsFromOcr } from '@/lib/dba-ocr'

type DbaDetailRow = {
  id: string
  delivery_id: string
  filed_date: string | null
  registration_number: string | null
}

type DbaUpdate = Partial<{
  filed_date: string | null
  registration_number: string | null
  updated_at: string
}>

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; dbaId: string } },
) {
  try {
    const accountId = params.id
    const dbaId = params.dbaId

    const body = await req.json().catch(() => ({}))
    const storagePath: string | undefined = body.storage_path
    const fileName: string | undefined = body.file_name
    const mimeType: string | undefined = body.mime_type

    if (!storagePath || !fileName) {
      return NextResponse.json(
        { success: false, detail: 'Missing storage_path or file_name' },
        { status: 400 },
      )
    }

    // 1. Resolve DBA detail row + confirm it belongs to this account.
    const adminUntyped = supabaseAdmin as unknown as {
      from: (table: string) => {
        select: (sel: string) => {
          eq: (col: string, val: string) => {
            single: () => Promise<{ data: DbaDetailRow | null; error: { message: string } | null }>
          }
        }
        update: (row: DbaUpdate) => {
          eq: (col: string, val: string) => Promise<{ error: { message: string } | null }>
        }
      }
    }

    const { data: dba, error: dbaErr } = await adminUntyped
      .from('dba_details')
      .select('id, delivery_id, filed_date, registration_number')
      .eq('id', dbaId)
      .single()

    if (dbaErr || !dba) {
      return NextResponse.json(
        { success: false, detail: 'DBA detail row not found' },
        { status: 404 },
      )
    }

    const { data: sd, error: sdErr } = await supabaseAdmin
      .from('service_deliveries')
      .select('account_id')
      .eq('id', dba.delivery_id)
      .single()

    if (sdErr || !sd || sd.account_id !== accountId) {
      return NextResponse.json(
        { success: false, detail: 'DBA does not belong to this account' },
        { status: 403 },
      )
    }

    // 2. Download file from Storage.
    const { data: blob, error: dlErr } = await supabaseAdmin.storage
      .from('onboarding-uploads')
      .download(storagePath)

    if (dlErr || !blob) {
      return NextResponse.json(
        { success: false, detail: `Storage download failed: ${dlErr?.message || 'no data'}` },
        { status: 500 },
      )
    }

    const buffer = Buffer.from(await blob.arrayBuffer())
    const fileMime = mimeType || blob.type || 'application/pdf'

    // 3. Resolve Drive folder for the account.
    const { data: account } = await supabaseAdmin
      .from('accounts')
      .select('drive_folder_id, gdrive_folder_url')
      .eq('id', accountId)
      .single()

    let driveFolderId: string | null = account?.drive_folder_id ?? null
    if (!driveFolderId && account?.gdrive_folder_url) {
      const match = (account.gdrive_folder_url as string).match(/folders\/([a-zA-Z0-9_-]+)/)
      if (match) driveFolderId = match[1]
    }
    if (!driveFolderId) {
      return NextResponse.json(
        { success: false, detail: 'Account has no Drive folder. Create or link one first.' },
        { status: 400 },
      )
    }

    // 4. Find "1. Company" subfolder (DBA registrations live with company docs).
    const { listFolderAnyDrive, uploadBinaryToDrive } = await import('@/lib/google-drive')
    const foldersRes = await listFolderAnyDrive(driveFolderId)
    const folders = (foldersRes as { files?: Array<{ id: string; name: string; mimeType: string }> }).files ?? []
    const targetFolder = folders.find(
      f => f.name === '1. Company' && f.mimeType === 'application/vnd.google-apps.folder',
    )
    const uploadFolderId = targetFolder?.id || driveFolderId

    // 5. Upload to Drive.
    const driveFile = await uploadBinaryToDrive(fileName, buffer, fileMime, uploadFolderId) as { id: string; name: string }
    const sideEffects: string[] = [`Uploaded to Drive: ${fileName}`]

    // 6. Insert documents row (idempotent on drive_file_id).
    const { data: existingDoc } = await supabaseAdmin
      .from('documents')
      .select('id')
      .eq('drive_file_id', driveFile.id)
      .limit(1)

    if (!existingDoc?.length) {
      await supabaseAdmin.from('documents').insert({
        file_name: fileName,
        drive_file_id: driveFile.id,
        drive_link: `https://drive.google.com/file/d/${driveFile.id}/view`,
        document_type_name: 'DBA Application',
        category: 1,
        category_name: 'Company',
        status: 'classified',
        account_id: accountId,
        contact_id: null,
        portal_visible: true,
      })
      sideEffects.push('Document record created')
    }

    // 7. Audit log.
    await supabaseAdmin.from('action_log').insert({
      actor: 'crm-admin',
      action_type: 'upload_dba_document',
      table_name: 'documents',
      record_id: driveFile.id,
      account_id: accountId,
      summary: `DBA document uploaded: ${fileName}`,
      details: { file_name: fileName, dba_id: dbaId, delivery_id: dba.delivery_id },
    })

    // 8. Best-effort OCR + extraction. Only fill fields that are currently
    //    empty — never overwrite anything an operator already typed.
    let ocrData: { filed_date?: string | null; registration_number?: string | null } | null = null
    const ocrSupported = ['application/pdf', 'image/jpeg', 'image/png', 'image/tiff', 'image/gif', 'image/bmp', 'image/webp']

    if (ocrSupported.includes(fileMime)) {
      try {
        const { ocrDriveFile } = await import('@/lib/docai')
        const ocrResult = await ocrDriveFile(driveFile.id)

        if (ocrResult.fullText) {
          // Persist raw OCR text on the documents row for searchability.
          await supabaseAdmin
            .from('documents')
            .update({ ocr_text: ocrResult.fullText, processed_at: new Date().toISOString() })
            .eq('drive_file_id', driveFile.id)

          const extracted = extractDbaFieldsFromOcr(ocrResult.fullText)
          const patch: DbaUpdate = {}
          if (extracted.filed_date && !dba.filed_date) {
            patch.filed_date = extracted.filed_date
          }
          if (extracted.registration_number && !dba.registration_number) {
            patch.registration_number = extracted.registration_number
          }

          if (Object.keys(patch).length > 0) {
            patch.updated_at = new Date().toISOString()
            const { error: updErr } = await adminUntyped
              .from('dba_details')
              .update(patch)
              .eq('id', dbaId)
            if (updErr) {
              sideEffects.push(`OCR ran but DBA auto-fill failed: ${updErr.message}`)
            } else {
              const filled = Object.keys(patch).filter(k => k !== 'updated_at')
              sideEffects.push(`OCR auto-filled: ${filled.join(', ')}`)
            }
          } else if (extracted.filed_date || extracted.registration_number) {
            sideEffects.push('OCR found data but fields already set — kept existing values')
          } else {
            sideEffects.push('OCR ran but no DBA fields auto-detected')
          }

          ocrData = extracted
        }
      } catch (ocrErr) {
        const errMsg = ocrErr instanceof Error ? ocrErr.message : String(ocrErr)
        sideEffects.push(`OCR skipped: ${errMsg.includes('too large') ? 'File too large for OCR (max 15MB)' : errMsg}`)
      }
    }

    // 9. Clean up storage file (best-effort).
    supabaseAdmin.storage.from('onboarding-uploads').remove([storagePath]).catch(() => {})

    return NextResponse.json({
      success: true,
      detail: `${fileName} uploaded`,
      driveFileId: driveFile.id,
      ocrData,
      side_effects: sideEffects,
    })
  } catch (e) {
    console.error('[dba-upload-document] Error:', e)
    return NextResponse.json(
      { success: false, detail: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }
}
