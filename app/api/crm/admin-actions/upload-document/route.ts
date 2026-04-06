/**
 * Upload a document for a contact.
 *
 * POST (multipart/form-data):
 *   file: File
 *   contact_id: string
 *   document_type: string (e.g., "Passport", "ID Document", "EIN Letter")
 *   category: string ("Contacts", "Company", "Tax", "Banking", "Correspondence")
 *
 * Flow:
 * 1. Upload file to contact's Drive folder (correct subfolder by category)
 * 2. If passport: OCR → parse MRZ → update contact record
 * 3. Create/update document record in DB
 * 4. Return { success, driveFileId, ocrData? }
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
    const formData = await req.formData()
    const file = formData.get('file') as File | null
    const contactId = formData.get('contact_id') as string
    const documentType = formData.get('document_type') as string || 'Other'
    const category = formData.get('category') as string || 'Contacts'

    if (!file || !contactId) {
      return NextResponse.json({ success: false, detail: 'Missing file or contact_id' }, { status: 400 })
    }

    const catInfo = CATEGORY_MAP[category] || CATEGORY_MAP.Correspondence

    // Get contact's Drive folder
    const { data: contact } = await supabaseAdmin
      .from('contacts')
      .select('full_name, gdrive_folder_url')
      .eq('id', contactId)
      .single()

    if (!contact) {
      return NextResponse.json({ success: false, detail: 'Contact not found' }, { status: 404 })
    }

    // Resolve Drive folder — contact folder or linked account folder
    let driveFolderId: string | null = null

    // Try contact's own folder first
    if (contact.gdrive_folder_url) {
      const match = (contact.gdrive_folder_url as string).match(/folders\/([a-zA-Z0-9_-]+)/)
      if (match) driveFolderId = match[1]
    }

    // If no contact folder, try linked account folder
    if (!driveFolderId) {
      const { data: acLinks } = await supabaseAdmin
        .from('account_contacts')
        .select('account_id, accounts:account_id(drive_folder_id)')
        .eq('contact_id', contactId)
        .limit(1)

      const acct = acLinks?.[0]?.accounts as unknown as { drive_folder_id: string | null } | null
      if (acct?.drive_folder_id) {
        driveFolderId = acct.drive_folder_id
      }
    }

    // If still no folder, create one
    if (!driveFolderId) {
      const { ensureContactFolder } = await import('@/lib/drive-folder-utils')
      const folderResult = await ensureContactFolder(contactId, contact.full_name || 'Unknown')
      driveFolderId = folderResult.folderId
    }

    // Find the target subfolder
    const { listFolderAnyDrive, uploadBinaryToDrive } = await import('@/lib/google-drive')
    const foldersRes = await listFolderAnyDrive(driveFolderId)
    const folders = (foldersRes as { files?: Array<{ id: string; name: string; mimeType: string }> }).files ?? []
    const targetFolder = folders.find(
      (f: { name: string; mimeType: string }) => f.name === catInfo.subfolder && f.mimeType === 'application/vnd.google-apps.folder',
    )
    const uploadFolderId = targetFolder?.id || driveFolderId

    // Upload to Drive
    const buffer = Buffer.from(await file.arrayBuffer())
    const driveFile = await uploadBinaryToDrive(file.name, buffer, file.type, uploadFolderId) as { id: string; name: string }

    const sideEffects: string[] = [`Uploaded to Drive: ${file.name}`]

    // Get linked account for document record
    const { data: acLink } = await supabaseAdmin
      .from('account_contacts')
      .select('account_id')
      .eq('contact_id', contactId)
      .limit(1)
    const accountId = acLink?.[0]?.account_id ?? null

    // If passport: OCR + parse
    let ocrData: Record<string, unknown> | null = null
    const isPassport = documentType.toLowerCase().includes('passport')
    const ocrSupported = ['application/pdf', 'image/jpeg', 'image/png', 'image/tiff', 'image/gif', 'image/bmp', 'image/webp']

    if (isPassport && ocrSupported.includes(file.type)) {
      try {
        const { ocrDriveFile } = await import('@/lib/docai')
        const { parsePassportFromOcr } = await import('@/lib/passport-processing')
        const ocrResult = await ocrDriveFile(driveFile.id)

        if (ocrResult.fullText) {
          const parsed = parsePassportFromOcr(ocrResult.fullText)
          ocrData = parsed as unknown as Record<string, unknown>

          // Update contact with extracted data
          const updates: Record<string, unknown> = { passport_on_file: true, updated_at: new Date().toISOString() }
          if (parsed.passportNumber) updates.passport_number = parsed.passportNumber
          if (parsed.expiryDate) updates.passport_expiry_date = parsed.expiryDate
          if (parsed.dateOfBirth) updates.date_of_birth = parsed.dateOfBirth

          await supabaseAdmin.from('contacts').update(updates).eq('id', contactId)

          const extracted = Object.keys(updates).filter(k => k !== 'passport_on_file' && k !== 'updated_at')
          if (extracted.length > 0) {
            sideEffects.push(`OCR extracted: ${extracted.join(', ')}`)
          } else {
            sideEffects.push('OCR ran but no passport data found in MRZ')
          }
        }
      } catch (ocrErr) {
        sideEffects.push(`OCR error: ${ocrErr instanceof Error ? ocrErr.message : String(ocrErr)}`)
      }
    } else if (isPassport) {
      await supabaseAdmin.from('contacts')
        .update({ passport_on_file: true, updated_at: new Date().toISOString() })
        .eq('id', contactId)
      sideEffects.push('Passport marked on file (OCR not supported for this format)')
    }

    // Create document record (dedup by drive_file_id)
    const { data: existingDoc } = await supabaseAdmin
      .from('documents')
      .select('id')
      .eq('drive_file_id', driveFile.id)
      .limit(1)

    if (!existingDoc?.length) {
      await supabaseAdmin.from('documents').insert({
        file_name: file.name,
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
      summary: `Document uploaded: ${file.name} (${documentType})`,
      details: { file_name: file.name, document_type: documentType, category, contact_id: contactId },
    })

    return NextResponse.json({
      success: true,
      detail: `${file.name} uploaded to ${catInfo.subfolder}`,
      driveFileId: driveFile.id,
      ocrData,
      side_effects: sideEffects,
    })
  } catch (e) {
    console.error('[upload-document] Error:', e)
    return NextResponse.json({ success: false, detail: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
