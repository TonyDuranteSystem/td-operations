/**
 * POST /api/tools/fax/send — send a fax via the Faxage HTTPS API.
 *
 * Staff-only (dashboard auth). Accepts JSON:
 *   {
 *     faxno: string,                 // recipient fax number (formatting stripped)
 *     // ONE of the following two file sources:
 *     file_base64?: string,          // uploaded file (data: URI tolerated)
 *     file_name?: string,            // name for the uploaded file
 *     document_id?: string,          // a `documents` row → downloaded from Drive
 *     // optional metadata:
 *     cover_message?: string,        // logged; see note below
 *     recip_name?: string,
 *     account_id?: string,
 *     service_delivery_id?: string,
 *     // upload source only — where the sent file is kept (the "Where should this be saved?" window; dev job c43a8b2e):
 *     save_choice?: { mode: 'save', purpose, ownerId, folderId, newFolderName?, fileName } | { mode: 'dont_save' },
 *   }
 *
 * The chosen place is CHECKED BEFORE the fax goes out (staff-only, the folder belongs to that owner, not in the trash, the company
 * has live storage and is not being moved …): a place that is not allowed stops the send with a 422 and the plain sentence. Only after
 * a successful send is the file filed there; a filing failure never fails the fax (ONE system error, the old bucket copy is kept).
 * No save_choice (an older caller sending a file that is already stored) = "Don't save": the internal bucket copy only.
 *
 * Credentials come from env (FAXAGE_USERNAME / FAXAGE_PASSWORD / FAXAGE_COMPANY)
 * — never from the client. The request shaping + response parsing live in
 * lib/fax/faxage.ts (unit-tested).
 *
 * NOTE on cover_message: the documented Faxage sendfax fields do not include a
 * cover-page message param we can rely on, so the message is recorded in
 * action_log but NOT transmitted. Wire it to the real Faxage cover param once
 * confirmed from their docs.
 */

export const dynamic = 'force-dynamic'
export const maxDuration = 60

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { downloadFileBinary } from '@/lib/google-drive'
import { sendFax, isValidFaxNo, normalizeFaxNo, DEFAULT_IRS_FAX_NUMBER, stripBase64Prefix } from '@/lib/fax/faxage'
import { isStoreStaffUser } from '@/lib/crm-store/access'
import { parseSaveChoice, validateDestination, verifyProposalStillHolds, realResolveDeps, saveToDestination, realDestinationDeps, realFileDeps, type FiledCopy, type SaveChoiceSave } from '@/lib/crm-store/save-destination'
import { looksPersonal } from '@/lib/fax/save-sent-upload'
import { taxYearFromName } from '@/lib/crm-store/save-where'

const MAX_COVER_LENGTH = 2000

/** Best-effort MIME from a filename extension (uploads carry no MIME). */
function mimeFromName(name: string): string {
  const ext = name.toLowerCase().split('.').pop() || ''
  if (ext === 'pdf') return 'application/pdf'
  if (ext === 'png') return 'image/png'
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'tif' || ext === 'tiff') return 'image/tiff'
  if (ext === 'gif') return 'image/gif'
  return 'application/octet-stream'
}

export async function POST(req: NextRequest) {
  // Staff auth — middleware lets logged-in clients reach /api, so gate here.
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isDashboardUser(user)) {
    return NextResponse.json({ success: false, error: 'Dashboard access required' }, { status: 403 })
  }

  const username = process.env.FAXAGE_USERNAME
  const password = process.env.FAXAGE_PASSWORD
  const company = process.env.FAXAGE_COMPANY || username || ''
  if (!username || !password) {
    return NextResponse.json(
      { success: false, error: 'Fax service is not configured (missing FAXAGE credentials).' },
      { status: 500 },
    )
  }

  const body = await req.json().catch(() => ({}))
  const faxnoRaw: string = typeof body.faxno === 'string' ? body.faxno : ''
  const documentId: string | null = typeof body.document_id === 'string' && body.document_id.trim()
    ? body.document_id.trim()
    : null
  const coverMessage = typeof body.cover_message === 'string' ? body.cover_message.slice(0, MAX_COVER_LENGTH) : ''
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : ''
  const recipName = typeof body.recip_name === 'string' && body.recip_name.trim() ? body.recip_name.trim() : undefined
  const serviceDeliveryId: string | null = typeof body.service_delivery_id === 'string' && body.service_delivery_id.trim()
    ? body.service_delivery_id.trim()
    : null
  // Opt-in double-send guard. When set (the SS-4 fax panel passes it), refuse a
  // repeat fax for the same flow unless the caller explicitly confirms a resend
  // — faxing the IRS is irreversible. General fax-tool callers omit these, so
  // their behavior is unchanged.
  const dedupeSdId: string | null = typeof body.dedupe_service_delivery_id === 'string' && body.dedupe_service_delivery_id.trim()
    ? body.dedupe_service_delivery_id.trim()
    : null
  const confirmResend: boolean = body.confirm_resend === true

  // Validate the recipient number.
  if (!isValidFaxNo(faxnoRaw)) {
    return NextResponse.json(
      { success: false, error: 'A valid fax number (at least 10 digits) is required.' },
      { status: 400 },
    )
  }
  const faxno = normalizeFaxNo(faxnoRaw)

  // Double-send guard (opt-in). A prior 'fax_sent' for this flow → block with a
  // 409 the caller can turn into an explicit "send again?" confirm.
  if (dedupeSdId && !confirmResend) {
    const { data: prior } = await supabaseAdmin
      .from('action_log')
      .select('created_at, details')
      .eq('action_type', 'fax_sent')
      .eq('service_delivery_id', dedupeSdId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (prior) {
      const details = (prior.details as { job_id?: string; faxno?: string } | null) ?? {}
      return NextResponse.json(
        {
          success: false,
          already_faxed: { at: prior.created_at, job_id: details.job_id ?? null, faxno: details.faxno ?? null },
          error: 'A fax was already sent for this flow. Confirm to send it again.',
        },
        { status: 409 },
      )
    }
  }

  // Resolve the file to send: either a selected document (downloaded from Drive)
  // or an uploaded base64 file from the client.
  let fileBase64 = ''
  let fileName = 'document.pdf'
  let accountId: string | null = typeof body.account_id === 'string' && body.account_id.trim() ? body.account_id.trim() : null

  if (documentId) {
    const { data: doc, error: docErr } = await supabaseAdmin
      .from('documents')
      .select('id, file_name, drive_file_id, account_id')
      .eq('id', documentId)
      .single()
    if (docErr || !doc) {
      return NextResponse.json({ success: false, error: 'Selected document not found.' }, { status: 404 })
    }
    if (!doc.drive_file_id) {
      return NextResponse.json(
        { success: false, error: 'That document has no stored file to fax.' },
        { status: 400 },
      )
    }
    try {
      // CRM Store file (`store:<id>`) first — "store:" must never reach the Drive downloader.
      const { parseStorePointer, readStoreFile, staffOnlyStorePointers } = await import('@/lib/crm-store/document-pointer')
      const storeFileId = parseStorePointer(doc.drive_file_id)
      if (storeFileId && (await staffOnlyStorePointers([doc.drive_file_id])).size > 0) {
        return NextResponse.json(
          { success: false, error: 'That document is staff-only (it holds other people\'s personal data) and cannot be faxed.' },
          { status: 400 },
        )
      }
      if (storeFileId) {
        const f = await readStoreFile(storeFileId)
        fileBase64 = f.bytes.toString('base64')
        fileName = doc.file_name || f.name || 'document.pdf'
      } else {
        const binary = await downloadFileBinary(doc.drive_file_id)
        fileBase64 = binary.buffer.toString('base64')
        fileName = doc.file_name || binary.fileName || 'document.pdf'
      }
    } catch (e) {
      return NextResponse.json(
        { success: false, error: `Could not download the selected document: ${e instanceof Error ? e.message : String(e)}` },
        { status: 502 },
      )
    }
    if (!accountId && doc.account_id) accountId = doc.account_id as string
  } else {
    fileBase64 = typeof body.file_base64 === 'string' ? body.file_base64 : ''
    fileName = typeof body.file_name === 'string' && body.file_name.trim() ? body.file_name.trim() : 'document.pdf'
    if (!fileBase64) {
      return NextResponse.json(
        { success: false, error: 'Attach a file or select a document to fax.' },
        { status: 400 },
      )
    }
  }

  // Where the sent file is kept (upload source only; a stored document is not copied again). The place is checked NOW, before the fax
  // goes out: a place that is not allowed stops the send and staff are told in the window.
  const parsedChoice = documentId ? { ok: true, choice: null } : parseSaveChoice(body.save_choice)
  if (!parsedChoice.ok) {
    return NextResponse.json({ success: false, destination_error: true, error: parsedChoice.error }, { status: 400 })
  }
  const saveChoice = parsedChoice.choice
  let toSave: { choice: SaveChoiceSave; validated: Awaited<ReturnType<typeof validateDestination>> } | null = null
  if (saveChoice && saveChoice.mode === 'save') {
    if (!isStoreStaffUser(user)) {
      return NextResponse.json({ success: false, destination_error: true, error: 'Only staff can save a file into the storage.' }, { status: 403 })
    }
    try {
      // a place taken straight from the proposal must still be what the rules give for the CURRENT answers (a stale proposal is refused)
      const holds = await verifyProposalStillHolds(saveChoice, realResolveDeps())
      if (!holds.ok) {
        return NextResponse.json({ success: false, destination_error: true, error: holds.error }, { status: 422 })
      }
      const { isOwnerOnly } = await import('@/lib/auth')
      const validated = await validateDestination(saveChoice, realDestinationDeps({ id: user?.id ?? null, ownerOnly: isOwnerOnly(user) }), fileName)
      if (!validated.decision.ok) {
        return NextResponse.json({ success: false, destination_error: true, error: validated.decision.error }, { status: 422 })
      }
      toSave = { choice: saveChoice, validated }
    } catch (e) {
      return NextResponse.json({ success: false, destination_error: true, error: e instanceof Error ? e.message : 'Could not check the place you chose. Please try again.' }, { status: 503 })
    }
  }

  // Send via Faxage.
  let result
  try {
    result = await sendFax({
      credentials: { username, company, password },
      faxno,
      fileName,
      fileBase64,
      recipName,
    })
  } catch (e) {
    console.error('[fax] Faxage request failed (network/parse):', e)
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : 'Failed to reach the fax service.' },
      { status: 502 },
    )
  }

  if (!result.ok) {
    // Log the FULL raw Faxage response so the cause is visible in server logs.
    console.error('[fax] Faxage rejected the request. Raw response:', result.raw, '| faxno:', faxno, '| file:', fileName)
    // Faxage auth failures come back as "ERR02: Login incorrect" — surface a
    // credentials-specific message instead of a generic "rejected".
    const low = result.raw.toLowerCase()
    const isLogin = low.includes('login incorrect') || low.startsWith('err02') || low.includes('login failed')
    const error = isLogin
      ? `Faxage login failed — verify FAXAGE_USERNAME / FAXAGE_PASSWORD / FAXAGE_COMPANY in the Vercel env (these are the Faxage account's Company + Username, which are usually NOT the email). Faxage said: ${result.raw.slice(0, 200)}`
      : `Faxage rejected the request: ${result.raw.slice(0, 300) || 'unknown error'}`
    return NextResponse.json({ success: false, error }, { status: 502 })
  }

  // Keep the sent UPLOAD. The fax has already gone out, so nothing below can fail it.
  //  1. "Save here": file it at the place staff chose (storage writer, type IRS Fax for an IRS fax, hidden from the client).
  //  2. Anything else ("Don't save", no choice, or filing failed): the internal bucket copy only, as before, so Fax History's
  //     "View Document" still opens it. That bucket copy is not CRM storage. A place in Business / My files has no CRM row, so it also
  //     gets the bucket copy for the History link.
  let uploadedDocId: string | null = null
  let filed: FiledCopy | null = null
  let saveError: string | null = null
  if (!documentId && fileBase64) {
    if (toSave) {
      try {
        const { createHash } = await import('crypto')
        const bytes0 = Buffer.from(stripBase64Prefix(fileBase64), 'base64')
        filed = await saveToDestination(toSave.choice, toSave.validated.owner!, {
          bytes: bytes0, mimeType: mimeFromName(toSave.validated.finalName), sha256: createHash('sha256').update(bytes0).digest('hex'),
          actor: user?.id ?? null, unlinked: !!toSave.validated.decision.unlinked, finalName: toSave.validated.finalName,
          periodYear: toSave.choice.purpose === 'irs_tax_return' ? taxYearFromName(toSave.validated.finalName) : null,
        }, realFileDeps())
        uploadedDocId = filed.documentRowId
      } catch (e) {
        saveError = e instanceof Error ? e.message : String(e)
        filed = null
        try {
          const { reportSystemError } = await import('@/lib/system-errors')
          await reportSystemError({ source: 'server', route: '/api/tools/fax/send', method: 'POST', message: `A faxed file could not be saved where staff chose — ${saveError}`, context: { fileName, ownerId: toSave.choice.ownerId, folderId: toSave.choice.folderId } })
        } catch { /* an alarm never fails a sent fax */ }
      }
    }
  }
  if (!documentId && fileBase64 && !uploadedDocId) {
    const personalPaper = looksPersonal(fileName)
    try {
      const bytes = Buffer.from(stripBase64Prefix(fileBase64), 'base64')
      const safeName = (fileName.replace(/[^\w.\-]+/g, '_').slice(0, 120)) || 'document.pdf'
      const mime = mimeFromName(fileName)
      const storagePath = `fax-attachments/${crypto.randomUUID()}-${safeName}`
      const { error: upErr } = await supabaseAdmin.storage
        .from('onboarding-uploads')
        .upload(storagePath, bytes, { contentType: mime, upsert: false })
      if (!upErr) {
        const { data: signed } = await supabaseAdmin.storage
          .from('onboarding-uploads')
          .createSignedUrl(storagePath, 60 * 60 * 24 * 365) // 1 year
        const { data: docRow } = await supabaseAdmin
          .from('documents')
          .insert({
            file_name: fileName,
            drive_file_id: `storage:${storagePath}`,
            drive_link: signed?.signedUrl ?? `onboarding-uploads/${storagePath}`,
            mime_type: mime,
            file_size: bytes.length,
            status: 'classified',
            // a personal paper (passport, ID, SS-4, 1040 …) is NEVER listed on a company's Documents tab
            account_id: personalPaper ? null : accountId,
            portal_visible: false,
            notify_client: false,
          })
          .select('id')
          .single()
        uploadedDocId = (docRow?.id as string | undefined) ?? null
      }
    } catch {
      /* persistence is best-effort — never fail a sent fax */
    }
  }
  // A company chosen in the window is certain (staff picked it): it goes on that company's activity feed (the Documents tab is a separate rule).
  if (filed && toSave?.validated.owner?.kind === 'company') accountId = accountId ?? toSave.validated.owner.account_id

  // Audit trail (best-effort — never fail the send if logging fails).
  try {
    await supabaseAdmin.from('action_log').insert({
      actor: user?.email || 'dashboard',
      action_type: 'fax_sent',
      table_name: 'documents',
      // record_id points at the viewable document — the selected doc for a
      // document-source fax, or the just-persisted upload doc. Fax History links
      // "View Document" whenever record_id is present.
      record_id: documentId ?? uploadedDocId,
      account_id: accountId,
      service_delivery_id: serviceDeliveryId,
      summary: `Fax sent to ${faxno} — ${fileName}`,
      details: {
        faxno,
        recip_name: recipName || null,
        reason: reason || null,
        file_name: fileName,
        job_id: result.jobId,
        cover_message: coverMessage || null,
        source: documentId ? 'document' : 'upload',
        save_choice: documentId ? 'stored_document' : saveChoice ? saveChoice.mode : 'none',
        saved_at_place: filed?.path ?? null,
        saved_file_id: filed?.fileId ?? null,
        save_error: saveError,
        document_id: documentId ?? uploadedDocId,
        faxage_response: result.raw.slice(0, 500),
      },
    })
  } catch {
    /* logging is non-blocking */
  }

  return NextResponse.json({
    success: true,
    job_id: result.jobId,
    faxage_response: result.raw.slice(0, 500),
    saved: filed ? { path: filed.path, name: filed.name, file_id: filed.fileId } : null,
    save_error: saveError,
  })
}

/** Expose the configured IRS fax number to the staff fax UI (no secrets). */
export async function GET() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isDashboardUser(user)) {
    return NextResponse.json({ error: 'Dashboard access required' }, { status: 403 })
  }
  return NextResponse.json({ irs_fax_number: process.env.FAXAGE_IRS_NUMBER || DEFAULT_IRS_FAX_NUMBER })
}
