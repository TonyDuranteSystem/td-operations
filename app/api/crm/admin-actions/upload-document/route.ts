/**
 * Upload a document for a contact.
 *
 * Accepts JSON body (file already in Supabase Storage):
 *   { contact_id, storage_path, file_name, mime_type, document_type, category }
 *
 * Flow:
 * 1. Download from Supabase Storage
 * 2. Upload to contact's Drive folder (correct subfolder by category)
 * 3. If passport: OCR → parse MRZ → update contact record
 * 4. Create document record in DB
 */

export const maxDuration = 60
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

const CATEGORY_MAP: Record<string, { num: number; subfolder: string }> = {
  Contacts: { num: 2, subfolder: '2. Contacts' },
  Company: { num: 1, subfolder: '1. Company' },
  Tax: { num: 3, subfolder: '3. Tax' },
  Banking: { num: 4, subfolder: '4. Banking' },
  Correspondence: { num: 5, subfolder: '5. Correspondence' },
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { contact_id: contactId, storage_path: storagePath, file_name: fileName, mime_type: mimeType, document_type: documentType = 'Other', category = 'Contacts' } = body

    if (!contactId || !storagePath || !fileName) {
      return NextResponse.json({ success: false, detail: 'Missing contact_id, storage_path, or file_name' }, { status: 400 })
    }

    const catInfo = CATEGORY_MAP[category] || CATEGORY_MAP.Correspondence

    // Download from Supabase Storage
    const { data: blob, error: dlErr } = await supabaseAdmin.storage
      .from('onboarding-uploads')
      .download(storagePath)

    if (dlErr || !blob) {
      return NextResponse.json({ success: false, detail: `Storage download failed: ${dlErr?.message || 'no data'}` }, { status: 500 })
    }

    const buffer = Buffer.from(await blob.arrayBuffer())
    const fileMime = mimeType || blob.type || 'application/pdf'

    // Get contact info
    const { data: contact } = await supabaseAdmin
      .from('contacts')
      .select('full_name, gdrive_folder_url')
      .eq('id', contactId)
      .single()

    if (!contact) {
      return NextResponse.json({ success: false, detail: 'Contact not found' }, { status: 404 })
    }

    // Resolve Drive folder
    let driveFolderId: string | null = null

    if (contact.gdrive_folder_url) {
      const match = (contact.gdrive_folder_url as string).match(/folders\/([a-zA-Z0-9_-]+)/)
      if (match) driveFolderId = match[1]
    }

    if (!driveFolderId) {
      const { data: acLinks } = await supabaseAdmin
        .from('account_contacts')
        .select('account_id, accounts:account_id(drive_folder_id)')
        .eq('contact_id', contactId)
        .limit(1)

      const acct = acLinks?.[0]?.accounts as unknown as { drive_folder_id: string | null } | null
      if (acct?.drive_folder_id) driveFolderId = acct.drive_folder_id
    }

    if (!driveFolderId) {
      const { ensureContactFolder } = await import('@/lib/drive-folder-utils')
      const folderResult = await ensureContactFolder(contactId, contact.full_name || 'Unknown')
      driveFolderId = folderResult.folderId
    }

    // Find target subfolder
    const { listFolderAnyDrive, uploadBinaryToDrive } = await import('@/lib/google-drive')
    const foldersRes = await listFolderAnyDrive(driveFolderId)
    const folders = (foldersRes as { files?: Array<{ id: string; name: string; mimeType: string }> }).files ?? []
    const targetFolder = folders.find(
      (f: { name: string; mimeType: string }) => f.name === catInfo.subfolder && f.mimeType === 'application/vnd.google-apps.folder',
    )
    const uploadFolderId = targetFolder?.id || driveFolderId

    // Upload to Drive
    const driveFile = await uploadBinaryToDrive(fileName, buffer, fileMime, uploadFolderId) as { id: string; name: string }

    const sideEffects: string[] = [`Uploaded to Drive: ${fileName}`]

    // Get linked account
    const { data: acLink } = await supabaseAdmin
      .from('account_contacts')
      .select('account_id')
      .eq('contact_id', contactId)
      .limit(1)
    const accountId = acLink?.[0]?.account_id ?? null

    // Passport OCR
    const isPassport = (documentType as string).toLowerCase().includes('passport')
    const ocrSupported = ['application/pdf', 'image/jpeg', 'image/png', 'image/tiff', 'image/gif', 'image/bmp', 'image/webp']
    let ocrData: Record<string, unknown> | null = null

    if (isPassport && ocrSupported.includes(fileMime)) {
      try {
        const { ocrDriveFile } = await import('@/lib/docai')
        const { parsePassportFromOcr } = await import('@/lib/passport-processing')
        const ocrResult = await ocrDriveFile(driveFile.id)

        if (ocrResult.fullText) {
          const parsed = parsePassportFromOcr(ocrResult.fullText)
          ocrData = parsed as unknown as Record<string, unknown>

          const updates: Record<string, unknown> = { passport_on_file: true, updated_at: new Date().toISOString() }
          if (parsed.passportNumber) updates.passport_number = parsed.passportNumber
          if (parsed.expiryDate) updates.passport_expiry_date = parsed.expiryDate
          if (parsed.dateOfBirth) updates.date_of_birth = parsed.dateOfBirth

          await supabaseAdmin.from('contacts').update(updates).eq('id', contactId)
          const extracted = Object.keys(updates).filter(k => k !== 'passport_on_file' && k !== 'updated_at')
          sideEffects.push(extracted.length > 0 ? `OCR extracted: ${extracted.join(', ')}` : 'OCR: no MRZ data found')
        }
      } catch (ocrErr) {
        sideEffects.push(`OCR error: ${ocrErr instanceof Error ? ocrErr.message : String(ocrErr)}`)
      }
    } else if (isPassport) {
      await supabaseAdmin.from('contacts')
        .update({ passport_on_file: true, updated_at: new Date().toISOString() })
        .eq('id', contactId)
    }

    // Create document record (dedup)
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
        document_type_name: documentType,
        category: catInfo.num,
        category_name: category,
        status: 'classified',
        contact_id: contactId,
        account_id: accountId,
        portal_visible: true,
      })
      sideEffects.push('Document record created')
    }

    // Log
    await supabaseAdmin.from('action_log').insert({
      actor: 'crm-admin',
      action_type: 'upload_document',
      table_name: 'documents',
      record_id: driveFile.id,
      account_id: accountId,
      summary: `Document uploaded: ${fileName} (${documentType})`,
      details: { file_name: fileName, document_type: documentType, category, contact_id: contactId },
    })

    // Clean up storage file (best-effort)
    supabaseAdmin.storage.from('onboarding-uploads').remove([storagePath]).catch(() => {})

    return NextResponse.json({
      success: true,
      detail: `${fileName} uploaded to ${catInfo.subfolder}`,
      driveFileId: driveFile.id,
      ocrData,
      side_effects: sideEffects,
    })
  } catch (e) {
    console.error('[upload-document] Error:', e)
    return NextResponse.json({ success: false, detail: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
