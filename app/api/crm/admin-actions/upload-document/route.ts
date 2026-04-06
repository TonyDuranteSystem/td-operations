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

    const isPassport = (documentType as string).toLowerCase().includes('passport')

    // Mark passport on file immediately
    if (isPassport) {
      await supabaseAdmin.from('contacts')
        .update({ passport_on_file: true, updated_at: new Date().toISOString() })
        .eq('id', contactId)
    }

    // Create document record FIRST (before OCR — so it's saved even if OCR crashes)
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

    // Log action BEFORE OCR (ensures it's recorded even if OCR times out)
    await supabaseAdmin.from('action_log').insert({
      actor: 'crm-admin',
      action_type: 'upload_document',
      table_name: 'documents',
      record_id: driveFile.id,
      account_id: accountId,
      summary: `Document uploaded: ${fileName} (${documentType})`,
      details: { file_name: fileName, document_type: documentType, category, contact_id: contactId },
    })

    // OCR for smart document types (best-effort — file is already saved above)
    let ocrData: Record<string, unknown> | null = null
    const ocrSupported = ['application/pdf', 'image/jpeg', 'image/png', 'image/tiff', 'image/gif', 'image/bmp', 'image/webp']
    const docTypeLower = (documentType as string).toLowerCase()
    const isItinLetter = docTypeLower.includes('itin')
    const isEinLetter = docTypeLower.includes('ein')

    if ((isPassport || isItinLetter || isEinLetter) && ocrSupported.includes(fileMime)) {
      try {
        const { ocrDriveFile } = await import('@/lib/docai')
        const ocrResult = await ocrDriveFile(driveFile.id)

        if (ocrResult.fullText) {
          if (isPassport) {
            // Passport MRZ parsing
            const { parsePassportFromOcr } = await import('@/lib/passport-processing')
            const parsed = parsePassportFromOcr(ocrResult.fullText)
            ocrData = parsed as unknown as Record<string, unknown>

            const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
            if (parsed.passportNumber) updates.passport_number = parsed.passportNumber
            if (parsed.expiryDate) updates.passport_expiry_date = parsed.expiryDate
            if (parsed.dateOfBirth) updates.date_of_birth = parsed.dateOfBirth

            const extracted = Object.keys(updates).filter(k => k !== 'updated_at')
            if (extracted.length > 0) {
              await supabaseAdmin.from('contacts').update(updates).eq('id', contactId)
              sideEffects.push(`OCR extracted: ${extracted.join(', ')}`)
            } else {
              sideEffects.push('OCR ran but no MRZ data found')
            }
          } else if (isItinLetter) {
            // ITIN number extraction: format 9XX-XX-XXXX
            const itinMatch = ocrResult.fullText.match(/\b(9\d{2}[- ]?\d{2}[- ]?\d{4})\b/)
            if (itinMatch) {
              const rawItin = itinMatch[1].replace(/[- ]/g, '')
              const itinFormatted = `${rawItin.slice(0, 3)}-${rawItin.slice(3, 5)}-${rawItin.slice(5)}`
              ocrData = { itinNumber: itinFormatted }

              await supabaseAdmin.from('contacts').update({
                itin_number: itinFormatted,
                itin_issue_date: new Date().toISOString().split('T')[0],
                updated_at: new Date().toISOString(),
              }).eq('id', contactId)
              sideEffects.push(`ITIN extracted: ${itinFormatted}`)
            } else {
              sideEffects.push('OCR ran but no ITIN number found (expected format: 9XX-XX-XXXX)')
            }
          } else if (isEinLetter) {
            // EIN number extraction: format XX-XXXXXXX
            const einMatch = ocrResult.fullText.match(/\b(\d{2}[- ]?\d{7})\b/)
            if (einMatch) {
              const rawEin = einMatch[1].replace(/[- ]/g, '')
              const einFormatted = `${rawEin.slice(0, 2)}-${rawEin.slice(2)}`
              ocrData = { einNumber: einFormatted }
              sideEffects.push(`EIN found in document: ${einFormatted} (use Enter EIN on the SS-4 card to save it)`)
            } else {
              sideEffects.push('OCR ran but no EIN number found (expected format: XX-XXXXXXX)')
            }
          }
        }
      } catch (ocrErr) {
        const errMsg = ocrErr instanceof Error ? ocrErr.message : String(ocrErr)
        sideEffects.push(`OCR skipped: ${errMsg.includes('too large') ? 'File too large for OCR (max 15MB). Reduce PDF size.' : errMsg}`)
      }
    }

    // Notify client via portal notification + chat message + immediate email
    const docLabel = isItinLetter ? 'Your ITIN letter is ready'
      : isEinLetter ? 'Your EIN letter is ready'
      : isPassport ? 'Your passport has been uploaded'
      : `New document: ${documentType}`
    const chatMsg = `${docLabel}\n\n${fileName} is now available in your portal Documents section.`

    try {
      const { createPortalNotification } = await import('@/lib/portal/notifications')
      await createPortalNotification({
        contact_id: contactId,
        account_id: accountId ?? undefined,
        type: 'document_uploaded',
        title: docLabel,
        body: `${fileName} is now available in your portal Documents section.`,
        link: '/portal/documents',
      })
      sideEffects.push('Portal notification sent')
    } catch {
      // Non-critical
    }

    // Send portal chat message so client sees it in chat
    try {
      await supabaseAdmin.from('portal_messages').insert({
        contact_id: contactId,
        account_id: accountId,
        sender_type: 'admin',
        message: chatMsg,
      })
      sideEffects.push('Chat message sent to client')
    } catch {
      // Non-critical
    }

    // Send email immediately (don't rely on digest cron)
    try {
      const { data: contactForEmail } = await supabaseAdmin
        .from('contacts')
        .select('email, full_name, language')
        .eq('id', contactId)
        .single()

      if (contactForEmail?.email) {
        const { gmailPost } = await import('@/lib/gmail')
        const clientName = contactForEmail.full_name?.split(' ')[0] || 'there'
        const isItalian = contactForEmail.language === 'Italian'

        const subject = isItalian
          ? `Nuovo documento disponibile — ${docLabel}`
          : `New document available — ${docLabel}`
        const body = isItalian
          ? `Ciao ${clientName},\n\n${fileName} è ora disponibile nella sezione Documenti del tuo portale.\n\nAccedi al portale: https://portal.tonydurante.us/portal/documents\n\nCordiali saluti,\nTony Durante LLC`
          : `Hi ${clientName},\n\n${fileName} is now available in your portal Documents section.\n\nAccess your portal: https://portal.tonydurante.us/portal/documents\n\nBest regards,\nTony Durante LLC`

        const encodedSubject = `=?utf-8?B?${Buffer.from(subject).toString('base64')}?=`
        const rawEmail = [
          'From: Tony Durante LLC <support@tonydurante.us>',
          `To: ${contactForEmail.email}`,
          `Subject: ${encodedSubject}`,
          'MIME-Version: 1.0',
          'Content-Type: text/plain; charset=utf-8',
          'Content-Transfer-Encoding: base64',
          '',
          Buffer.from(body).toString('base64'),
        ].join('\r\n')

        await gmailPost('/messages/send', { raw: Buffer.from(rawEmail).toString('base64url') })
        sideEffects.push(`Email sent to ${contactForEmail.email}`)
      }
    } catch {
      // Non-critical — email failure shouldn't block upload
    }

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
