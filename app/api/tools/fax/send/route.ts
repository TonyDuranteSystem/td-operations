/**
 * POST /api/tools/fax/send — send a fax via the Faxage HTTPS API.
 *
 * Staff-only (dashboard auth). Accepts JSON:
 *   {
 *     faxno: string,                 // recipient fax number (formatting stripped)
 *     // ONE of the following two file sources:
 *     file_base64?: string,          // uploaded file (data: URI tolerated)
 *     file_name?: string,            // name for the uploaded file
 *     staged_path?: string,          // a big upload staged by /api/tools/fax/upload-url (read and removed here)
 *     already_stored?: boolean,      // the file is ALREADY in the CRM storage ("Fax this file"): no internal copy is made of it
 *     document_id?: string,          // a `documents` row → downloaded from Drive
 *     // optional metadata:
 *     cover_message?: string,        // logged; see note below
 *     recip_name?: string,
 *     account_id?: string,
 *     service_delivery_id?: string,
 *     send_id?: string,              // one Send = one fax (see lib/fax/send-claim.ts)
 *     confirm_resend?: boolean,      // the user confirmed sending the same file to the same number again
 *     // upload source only — where the sent file is kept (the "Where should this be saved?" window; dev job c43a8b2e):
 *     save_choice?: { mode: 'save', purpose, ownerId, folderId, newFolderName?, fileName } | { mode: 'dont_save' },
 *   }
 *
 * The chosen place is CHECKED BEFORE the fax goes out (staff-only, the folder belongs to that owner, not in the trash, the company
 * has live storage and is not being moved …): a place that is not allowed stops the send with a 422 and the plain sentence. Only after
 * a successful send is the file filed there; a filing failure never fails the fax (ONE system error, the old bucket copy is kept).
 * No save_choice (an older caller) = "Don't save": the internal bucket copy only (not for an identity paper or My files).
 *
 * ONE fax per Send: a CLAIM row is written to the activity log BEFORE Faxage is called (lib/fax/send-claim.ts); it becomes the history
 * row the moment Faxage accepts, and is completed after the filing. Every lookup / write is checked: a database error before the send
 * stops it (503, "the fax was NOT sent"); a failure to write the history after the send raises an alarm and is told to staff plainly.
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
import { createHash } from 'crypto'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { downloadFileBinary } from '@/lib/google-drive'
import { sendFax, isValidFaxNo, normalizeFaxNo, DEFAULT_IRS_FAX_NUMBER, stripBase64Prefix, isProvablyNotSent } from '@/lib/fax/faxage'
import type { User } from '@supabase/supabase-js'
import { isStoreStaffUser } from '@/lib/crm-store/access'
import { parseSaveChoice, validateDestination, verifyProposalStillHolds, realResolveDeps, saveToDestination, realDestinationDeps, realFileDeps, type FiledCopy, type SaveChoiceSave } from '@/lib/crm-store/save-destination'
import { personalKind } from '@/lib/fax/save-sent-upload'
import { claimSend, finishClaim, abandonClaim, realClaimDeps, HISTORY_NOT_SAVED_SENTENCE } from '@/lib/fax/send-claim'
import { isFaxStagingPath, FAX_STAGING_BUCKET, faxSizeProblem } from '@/lib/fax/staged-upload'

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
  const body = await req.json().catch(() => ({}))
  // A big upload staged by the browser is removed on EVERY way out of this request (invalid number, missing credentials, a refused place,
  // a refused fax …), not only after it was read — so a failed Send leaves nothing behind (the browser stages a fresh file per attempt).
  const staged = isFaxStagingPath(body?.staged_path) ? (body.staged_path as string) : null
  try {
    return await handleSend(user, body)
  } finally {
    if (staged) {
      const { error } = await supabaseAdmin.storage.from(FAX_STAGING_BUCKET).remove([staged])
      if (error) console.error('[fax] could not remove the staged upload', staged, error.message)
    }
  }
}

async function handleSend(user: User | null, body: Record<string, any>): Promise<NextResponse> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const username = process.env.FAXAGE_USERNAME
  const password = process.env.FAXAGE_PASSWORD
  const company = process.env.FAXAGE_COMPANY || username || ''
  if (!username || !password) {
    return NextResponse.json(
      { success: false, error: 'Fax service is not configured (missing FAXAGE credentials).' },
      { status: 500 },
    )
  }

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
  const sendId: string | null = typeof body.send_id === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(body.send_id) ? body.send_id : null

  // Validate the recipient number.
  if (!isValidFaxNo(faxnoRaw)) {
    return NextResponse.json(
      { success: false, error: 'A valid fax number (at least 10 digits) is required.' },
      { status: 400 },
    )
  }
  const faxno = normalizeFaxNo(faxnoRaw)

  // Double-send guard (opt-in). A prior 'fax_sent' for this flow → block with a
  // 409 the caller can turn into an explicit "send again?" confirm. A lookup ERROR stops the send (it never fails open).
  if (dedupeSdId && !confirmResend) {
    const { data: prior, error: priorErr } = await supabaseAdmin
      .from('action_log')
      .select('created_at, details, action_type')
      .in('action_type', ['fax_sent', 'fax_claim'])
      .eq('service_delivery_id', dedupeSdId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (priorErr) {
      return NextResponse.json({ success: false, error: 'Could not check whether this flow was already faxed. The fax was NOT sent. Please try again.' }, { status: 503 })
    }
    if (prior) {
      const details = (prior.details as { job_id?: string; faxno?: string } | null) ?? {}
      // an UNCONFIRMED send is not "already sent": say what it is, and never offer a blind re-send
      const unconfirmed = (prior as { action_type?: string }).action_type === 'fax_claim'
      return NextResponse.json(
        {
          success: false,
          already_faxed: { at: prior.created_at, job_id: details.job_id ?? null, faxno: details.faxno ?? null, unconfirmed },
          error: unconfirmed
            ? 'A send for this flow was started but never confirmed, so it is not known whether the fax went out. Check Faxage, then say what happened in Fax History before sending again. This attempt was NOT sent.'
            : 'A fax was already sent for this flow. Confirm to send it again.',
        },
        { status: 409 },
      )
    }
  }

  // Resolve the file to send: a selected document, a file already in the storage, a big upload staged by the browser, or a base64 upload.
  let fileBase64 = ''
  let fileName = 'document.pdf'
  // "Fax this file" from the storage: the file is already stored, so NO internal copy of it is made (a skipped copy is always the safe side)
  const alreadyStored = body.already_stored === true && !documentId
  const recordDocId: string | null = documentId   // the documents row the history links to
  // The company comes ONLY from the stored document or from the place staff chose (validated below). An upload's body.account_id is ignored:
  // a forged id must never attach a documents row to some other company.
  let accountId: string | null = documentId && typeof body.account_id === 'string' && body.account_id.trim() ? body.account_id.trim() : null

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
  } else if (body.staged_path !== undefined && body.staged_path !== null) {
    // a big upload the browser sent direct to the private bucket: read it here, remove it at once (the bytes are in memory now)
    if (!isFaxStagingPath(body.staged_path)) {
      return NextResponse.json({ success: false, error: 'The uploaded file was not understood. Please choose it again.' }, { status: 400 })
    }
    const { data: blob, error: dlErr } = await supabaseAdmin.storage.from(FAX_STAGING_BUCKET).download(body.staged_path)
    if (dlErr || !blob) {
      return NextResponse.json({ success: false, error: 'The uploaded file could not be read. Please choose it again.' }, { status: 400 })
    }
    const buf = Buffer.from(await blob.arrayBuffer())
    if (buf.length === 0) {
      return NextResponse.json({ success: false, error: 'The uploaded file is empty. Please choose it again.' }, { status: 400 })
    }
    const tooBig = faxSizeProblem(buf.length)
    if (tooBig) return NextResponse.json({ success: false, error: tooBig }, { status: 400 })
    fileBase64 = buf.toString('base64')
    fileName = typeof body.file_name === 'string' && body.file_name.trim() ? body.file_name.trim() : 'document.pdf'
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
  const stored = !!documentId || alreadyStored   // not an upload: nothing new to keep

  // Where the sent file is kept (upload source only; a stored file is not copied again). The place is checked NOW, before the fax
  // goes out: a place that is not allowed stops the send and staff are told in the window.
  const parsedChoice = stored ? { ok: true, choice: null } : parseSaveChoice(body.save_choice)
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

  // ONE fax per Send: the claim is written BEFORE Faxage is called (see lib/fax/send-claim.ts). A lookup / write error stops the send.
  const hash = createHash('sha256').update(Buffer.from(stripBase64Prefix(fileBase64), 'base64')).digest('hex')
  const claimDeps = await realClaimDeps()
  const claim = await claimSend({
    sendId, faxno, hash, confirmResend, actor: user?.email || 'dashboard', summary: `Fax to ${faxno} — ${fileName} (sending)`, serviceDeliveryId,
    display: { file_name: fileName, recip_name: recipName ?? null, reason: reason || null },
  }, claimDeps)
  if (!claim.ok) {
    return NextResponse.json({
      success: false, error: claim.error,
      ...(claim.code === 'already_sent' ? { already_sent: claim.prior } : {}),
      ...(claim.code === 'recent_duplicate' ? { recent_duplicate: true, already_faxed: claim.prior } : {}),
      ...(claim.code === 'in_progress' ? { in_progress: true } : {}),
    }, { status: claim.status })
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
    // PROOF that nothing was sent (sandbox refusal, the fax could not be built, the name did not resolve / the connection was refused) releases
    // the claim; any other error leaves the outcome unknown
    if (isProvablyNotSent(e)) {
      await abandonClaim(claim.claimId!, claimDeps)
      return NextResponse.json({ success: false, error: e instanceof Error ? e.message : 'Failed to reach the fax service.' }, { status: 502 })
    }
    // the outcome is UNKNOWN (the fax may have left): the claim stays, so a retry is stopped until staff have looked in Fax History
    return NextResponse.json(
      { success: false, outcome_unknown: true, error: `${e instanceof Error ? e.message : 'Failed to reach the fax service.'} It is not known whether the fax went out: check Fax History and Faxage before sending it again. This attempt stays marked until you say what happened.` },
      { status: 502 },
    )
  }

  const outcome = result.outcome ?? (result.ok ? 'accepted' : 'refused')
  if (outcome === 'unknown') {
    // a gateway error / timeout / empty answer: the job may be queued. The claim STAYS (a retry is stopped); staff check Faxage.
    console.error('[fax] Faxage outcome UNKNOWN. Raw response:', result.raw, '| faxno:', faxno, '| file:', fileName)
    return NextResponse.json({ success: false, outcome_unknown: true, error: 'The fax service did not give a clear answer, so it is NOT known whether the fax went out. Check Fax History and Faxage before sending it again. This attempt stays marked until you say what happened.' }, { status: 502 })
  }
  if (!result.ok) {
    // Log the FULL raw Faxage response so the cause is visible in server logs.
    console.error('[fax] Faxage rejected the request. Raw response:', result.raw, '| faxno:', faxno, '| file:', fileName)
    await abandonClaim(claim.claimId!, claimDeps)
    // Faxage auth failures come back as "ERR02: Login incorrect" — surface a
    // credentials-specific message instead of a generic "rejected".
    const low = result.raw.toLowerCase()
    const isLogin = low.includes('login incorrect') || low.startsWith('err02') || low.includes('login failed')
    const error = isLogin
      ? `Faxage login failed — verify FAXAGE_USERNAME / FAXAGE_PASSWORD / FAXAGE_COMPANY in the Vercel env (these are the Faxage account's Company + Username, which are usually NOT the email). Faxage said: ${result.raw.slice(0, 200)}`
      : `Faxage rejected the request: ${result.raw.slice(0, 300) || 'unknown error'}`
    return NextResponse.json({ success: false, error }, { status: 502 })
  }

  // THE FAX HAS GONE OUT. The claim becomes the history row NOW, before the (slower) filing: if the filing runs out of time, the
  // irreversible fax is on record and a second Send is refused. The row is completed after the filing. Every write is checked.
  const detailsBase: Record<string, unknown> = {
    faxno,
    recip_name: recipName || null,
    reason: reason || null,
    file_name: fileName,
    job_id: result.jobId,
    cover_message: coverMessage || null,
    source: documentId ? 'document' : alreadyStored ? 'stored_file' : 'upload',
    send_id: sendId,
    content_hash: hash,
    save_choice: stored ? 'stored_document' : saveChoice ? saveChoice.mode : 'none',
    faxage_response: result.raw.slice(0, 500),
  }
  const ownerFromChoice = toSave?.validated.owner ?? null
  const logAccount = ownerFromChoice?.kind === 'company' ? ownerFromChoice.account_id : accountId
  const summary = `Fax sent to ${faxno} — ${fileName}`
  const actor = user?.email || 'dashboard'
  const reportHistoryFailure = async (msg: string) => {
    try {
      const { reportSystemError } = await import('@/lib/system-errors')
      await reportSystemError({ source: 'server', route: '/api/tools/fax/send', method: 'POST', message: `A fax WAS sent but its history entry could not be saved — ${msg}`, context: { faxno, fileName, jobId: result.jobId, sendId } })
    } catch { /* an alarm never fails a sent fax */ }
  }
  let historyError: string | null = null
  const first = await finishClaim(claim.claimId!, { actor, account_id: logAccount, service_delivery_id: serviceDeliveryId, summary, record_id: recordDocId, details: { ...detailsBase, filing_status: stored ? 'not_needed' : 'pending' } }, claimDeps)
  if (first.staleClaim) await reportHistoryFailure('a leftover unconfirmed marker of this fax could not be removed')
  if (first.via === 'none') { historyError = HISTORY_NOT_SAVED_SENTENCE; await reportHistoryFailure(first.error ?? 'unknown') }
  const historyId = first.id

  // Keep the sent UPLOAD. Nothing below can fail the fax.
  //  1. "Save here": file it at the place staff chose (storage writer, type IRS Fax for an IRS fax, hidden from the client).
  //  2. Otherwise ("Don't save", no choice, or filing failed): the internal bucket copy, so Fax History's "View Document" opens it —
  //     EXCEPT for a person's identity paper, for an SS-4 / 1040 that staff chose to save, and for anything staff put in a private
  //     "My files" (they must not become readable by every staff login: no copy, no link, and Fax History says so). A place in Business
  //     has no CRM row: it gets the bucket copy for the link (Business is open to all staff anyway). The copy stores the PATH only —
  //     no long-lived signed link.
  let uploadedDocId: string | null = null
  let filed: FiledCopy | null = null
  let saveError: string | null = null
  if (!stored && fileBase64) {
    if (toSave) {
      try {
        const bytes0 = Buffer.from(stripBase64Prefix(fileBase64), 'base64')
        filed = await saveToDestination(toSave.choice, toSave.validated.owner!, {
          bytes: bytes0, mimeType: mimeFromName(toSave.validated.finalName), sha256: hash,
          actor: user?.id ?? null, unlinked: !!toSave.validated.decision.unlinked, finalName: toSave.validated.finalName,
          // no period year: the storage takes it from the year folder the file sits in (a file moved by hand never contradicts its folder)
          periodYear: null,
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
  const kinds = [personalKind(fileName), toSave ? personalKind(toSave.validated.finalName) : null]
  const identityPaper = kinds.includes('identity')
  const formPaperSaved = !!toSave && kinds.includes('form')
  const noCopyReason: 'personal_paper' | 'my_files' | null = identityPaper || formPaperSaved ? 'personal_paper' : toSave && ownerFromChoice?.kind === 'private' ? 'my_files' : null
  if (!stored && fileBase64 && !uploadedDocId && !noCopyReason) {
    try {
      const bytes = Buffer.from(stripBase64Prefix(fileBase64), 'base64')
      const safeName = (fileName.replace(/[^\w.\-]+/g, '_').slice(0, 120)) || 'document.pdf'
      const mime = mimeFromName(fileName)
      const storagePath = `fax-attachments/${crypto.randomUUID()}-${safeName}`
      const { error: upErr } = await supabaseAdmin.storage
        .from('onboarding-uploads')
        .upload(storagePath, bytes, { contentType: mime, upsert: false })
      if (!upErr) {
        const { data: docRow } = await supabaseAdmin
          .from('documents')
          .insert({
            file_name: fileName,
            drive_file_id: `storage:${storagePath}`,
            // the PATH only (the preview route reads `storage:` pointers with the service role) — no signed link that stays valid for a year
            drive_link: `onboarding-uploads/${storagePath}`,
            mime_type: mime,
            file_size: bytes.length,
            status: 'classified',
            // never attached to a company (the old company-less copy): a client-supplied company id is not trusted, and a personal
            // paper must never be listed on a company's Documents tab
            account_id: null,
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

  // Complete the history record (checked, retried once, then inserted anew; an alarm when nothing can be written).
  const final = await finishClaim(historyId, {
    actor, account_id: logAccount, service_delivery_id: serviceDeliveryId, summary, record_id: recordDocId ?? uploadedDocId,
    details: {
      ...detailsBase,
      filing_status: stored ? 'not_needed' : saveError ? 'failed' : 'done',
      saved_at_place: filed?.path ?? null,
      saved_file_id: filed?.fileId ?? null,
      save_error: saveError,
      no_copy_reason: noCopyReason,
      document_id: recordDocId ?? uploadedDocId,
    },
  }, claimDeps)
  if (final.staleClaim) await reportHistoryFailure('a leftover unconfirmed marker of this fax could not be removed')
  if (final.via === 'none' && !historyError) { historyError = HISTORY_NOT_SAVED_SENTENCE; await reportHistoryFailure(final.error ?? 'unknown') }

  return NextResponse.json({
    success: true,
    fax_sent: true,
    job_id: result.jobId,
    faxage_response: result.raw.slice(0, 500),
    saved: filed ? { path: filed.path, name: filed.name, file_id: filed.fileId } : null,
    save_error: saveError,
    save_failed: !!saveError,
    no_copy_reason: noCopyReason,
    history_error: historyError,
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
