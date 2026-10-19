/**
 * Upload a document for a contact.
 *
 * Accepts JSON body (file already in Supabase Storage):
 *   { contact_id, storage_path, file_name, mime_type, document_type, category }
 *
 * Flow:
 * 1. Download from Supabase Storage
 * 2. Save into the CRM storage (the person's own, or the linked company's, by category) — Stop Drive S2: never Google Drive
 * 3. If passport: OCR → parse MRZ → update contact record
 * 4. Create document record in DB
 */

export const maxDuration = 60
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { parseItinIssueDateFromOcr } from '@/lib/ocr-helpers'
import { writeITINFields } from '@/lib/itin/write-itin-fields'
import { requireStaffRoute } from '@/lib/auth/require-staff-route'

const CATEGORY_MAP: Record<string, { num: number; subfolder: string }> = {
  Contacts: { num: 2, subfolder: '2. Contacts' },
  Company: { num: 1, subfolder: '1. Company' },
  Tax: { num: 3, subfolder: '3. Tax' },
  Banking: { num: 4, subfolder: '4. Banking' },
  Correspondence: { num: 5, subfolder: '5. Correspondence' },
}

export async function POST(req: NextRequest) {
  // STAFF ONLY: /api/* inherits only "is logged in" from the middleware, and a portal client has a login.
  const denied = await requireStaffRoute()
  if (denied) return denied
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
      .select('full_name')
      .eq('id', contactId)
      .single()

    if (!contact) {
      return NextResponse.json({ success: false, detail: 'Contact not found' }, { status: 404 })
    }

    // Where do these files live? (Drive cutover, dev job ad09ea91.) A person's OWN documents (category Contacts) go to
    // their personal storage when it is live; a company document goes to the linked company's storage when that company
    // is in storage. Anything else is refused with one plain sentence below (nothing is written to Drive).
    let stored: { pointer: string; documentRowId: string } | null = null
    {
      const { saveDocumentForContact, saveDocumentForAccount, CompanyMovingError } = await import('@/lib/crm-store/save-for-account')
      const { createHash } = await import('crypto')
      // the person's company: only when there is exactly one (a person in several companies has no single "linked" one)
      const { data: acLinkEarly } = await supabaseAdmin.from('account_contacts').select('account_id').eq('contact_id', contactId).limit(30)
      const linkIds = ((acLinkEarly ?? []) as Array<{ account_id: string }>).map((l) => l.account_id)
      const linkedAccountId = linkIds.length === 1 ? linkIds[0] : null
      // A COMPANY document for a person who belongs to SEVERAL companies has no single company to go to: once any of those
      // companies lives in the new storage it would land in an arbitrary one (or fail on its locked Drive folder). Say so plainly
      // and ask for the upload to be made from the right company (Drive cutover Phase A2, dev job ad09ea91). All on Drive: unchanged.
      if (catInfo.num !== 2 && linkIds.length > 1) {
        const { companyDocState } = await import('@/lib/crm-store/switched-drive-guard')
        for (const id of linkIds) {
          if ((await companyDocState(id)) !== 'drive') {
            return NextResponse.json({ success: false, detail: 'This person belongs to several companies and one of them has moved to the new storage — upload a company document from that company in Storage, so it lands in the right place.' }, { status: 409 })
          }
        }
      }
      // A PERSON's own documents follow the person: if ANY company they belong to has been switched to the new storage,
      // their personal storage is used (never Drive, never an arbitrary one of their companies).
      let switchedViaAccountId: string | null = null
      if (catInfo.num === 2) {
        const { companyDocState } = await import('@/lib/crm-store/switched-drive-guard')
        for (const id of linkIds) {
          if ((await companyDocState(id)) !== 'drive') { switchedViaAccountId = id; break }
        }
      }
      const dt = (documentType as string).toLowerCase()
      const storeType = dt.includes('passport') ? 'passport' : dt.includes('itin') ? 'itin_letter' : /\bein\b/.test(dt) ? 'ein_letter_irs' : null
      const callerKey = `staff-contact-upload:${contactId}:${catInfo.num}:${createHash('sha256').update(buffer).digest('hex')}`
      const row = { document_type_name: documentType as string, category: catInfo.num, category_name: category as string, status: 'classified' }
      try {
        const routed = catInfo.num === 2
          ? await saveDocumentForContact({ contactId, name: fileName, bytes: buffer, mimeType: fileMime, documentType: storeType, callerKey, accountId: linkedAccountId, viaAccountId: switchedViaAccountId ?? linkedAccountId, contactName: (contact.full_name as string | null) ?? null, portalVisible: true, row })
          : linkedAccountId
            ? await saveDocumentForAccount({
                accountId: linkedAccountId, name: fileName, bytes: buffer, mimeType: fileMime,
                folder: catInfo.num === 1 ? 'company' : catInfo.num === 3 ? 'tax' : catInfo.num === 4 ? 'banking' : 'correspondence',
                documentType: storeType, callerKey, portalVisible: true, row: { ...row, contact_id: contactId },
              })
            : ({ route: 'drive' } as const)
        if (routed.route === 'store') stored = { pointer: routed.pointer, documentRowId: routed.documentRowId }
      } catch (e) {
        if (e instanceof CompanyMovingError) return NextResponse.json({ success: false, detail: e.message }, { status: 409 })
        throw e
      }
    }

    if (!stored) {
      // Stop Drive S2: nothing is ever written to Drive. Anyone without a storage to receive the file is refused with one plain
      // sentence — nothing is written. (A staff action: the person who clicked is told right here, so no separate alarm.)
      const { legacyDriveForContact, legacyDriveForAccount, LEGACY_REFUSAL_SENTENCE } = await import('@/lib/crm-store/legacy-drive')
      const { data: links } = await supabaseAdmin.from('account_contacts').select('account_id').eq('contact_id', contactId).limit(30)
      const verdicts = [await legacyDriveForContact(contactId)]
      for (const l of (links ?? []) as Array<{ account_id: string }>) verdicts.push(await legacyDriveForAccount(l.account_id))
      const reason = verdicts.find((v) => v.reason !== 'no_folder' && v.reason !== 'no_company')
      const why: keyof typeof LEGACY_REFUSAL_SENTENCE = reason ? reason.reason : (links ?? []).length === 0 ? 'no_company' : 'no_folder'
      return NextResponse.json({ success: false, detail: LEGACY_REFUSAL_SENTENCE[why] }, { status: 409 })
    }
    const driveFile: { id: string; name: string } = { id: stored.pointer, name: fileName }
    {
      // the client is told about the new document exactly as for any upload (the record already exists, so the insert below is skipped)
      const { notifyClientsOfNewDocument } = await import('@/lib/portal/document-alerts')
      notifyClientsOfNewDocument(stored.documentRowId).catch((e) =>
        console.warn('[upload-document] new-document alert failed:', e instanceof Error ? e.message : String(e)))
    }

    const sideEffects: string[] = [`Saved to the new storage: ${fileName}`]

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
      // eslint-disable-next-line no-restricted-syntax -- pre-existing contacts write, unrelated to new-document alerts change
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
      const { data: newDoc } = await supabaseAdmin.from('documents').insert({
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
      }).select('id').single()
      sideEffects.push('Document record created')

      // Alert the client of the new document (in-portal + push; digest email for
      // non-push users). Fire-and-forget — never block the upload response.
      if (newDoc?.id) {
        const { notifyClientsOfNewDocument } = await import('@/lib/portal/document-alerts')
        notifyClientsOfNewDocument(newDoc.id as string).catch((e) =>
          console.warn('[upload-document] new-document alert failed:', e instanceof Error ? e.message : String(e)))
      }
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
    const ocrSupported = ['application/pdf', 'image/jpeg', 'image/png', 'image/tiff', 'image/gif', 'image/bmp', 'image/webp', 'image/heic', 'image/heif']
    const docTypeLower = (documentType as string).toLowerCase()
    const isItinLetter = docTypeLower.includes('itin')
    const isEinLetter = docTypeLower.includes('ein')

    if ((isPassport || isItinLetter || isEinLetter) && ocrSupported.includes(fileMime)) {
      try {
        const { ocrByPointer } = await import('@/lib/crm-store/ocr')
        const ocrResult = await ocrByPointer(driveFile.id)

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
              // eslint-disable-next-line no-restricted-syntax -- pre-existing contacts write, unrelated to new-document alerts change
              await supabaseAdmin.from('contacts').update(updates).eq('id', contactId)
              sideEffects.push(`OCR extracted: ${extracted.join(', ')}`)
            } else {
              sideEffects.push('OCR ran but no MRZ data found')
            }
          } else if (isItinLetter) {
            // ITIN number extraction (shared parser, format 9XX-XX-XXXX)
            const { extractItinFromOcr } = await import('@/lib/ocr-helpers')
            const itinFormatted = extractItinFromOcr(ocrResult.fullText)
            if (itinFormatted) {
              ocrData = { itinNumber: itinFormatted }

              // Extract issue date from CP565 OCR text (format: "Month DD, YYYY")
              const issueDate = parseItinIssueDateFromOcr(ocrResult.fullText)

              const { itin_renewal_date } = await writeITINFields(contactId, {
                itin_number: itinFormatted,
                itin_issue_date: issueDate,
              })
              sideEffects.push(
                `ITIN extracted: ${itinFormatted}, issue date: ${issueDate}` +
                  (itin_renewal_date ? `, renewal date: ${itin_renewal_date}` : ''),
              )
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
        sender_id: 'system',
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
