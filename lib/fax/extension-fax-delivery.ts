/**
 * Tax Return "1st Installment Paid" step — the delivery check of an EXTENSION fax (plan item 7, dev job 6f555c9f, 2026-11-09).
 *
 * After staff send the generated Form 7004 from the extension box, Faxage reports whether the fax reached the IRS line. This check (run every few
 * minutes by /api/cron/extension-fax-confirm, and on the box's "Check now") asks Faxage about the job's extension fax and, per answer:
 *   DELIVERED → read the Form 7004 as faxed (the working copy) and the Faxage receipt, MERGE them into ONE document, save it in the company's Tax
 *               folder (type "Form 7004", the tax year stamped, shown to the client), move the job to "Extension Filed" (the tax record follows:
 *               extension filed + the date), post the "extension filed" message in the job's chat, and write the marker LAST. A crash half-way is
 *               simply retried: the save is idempotent on its key, a job already at "Extension Filed" is not moved again, the message is not posted
 *               twice (it is looked up first).
 *   FAILED    → nothing moves; ONE marker + ONE alert per fax; the box turns red and offers a confirmed re-send.
 *   WAITING   → nothing moves; after EXTENSION_FAX_STALE minutes ONE marker + ONE alert; still checked on every run.
 * If the merged document cannot be built (the working copy is gone or was changed after it was faxed, or the company has no storage), the extension IS
 * filed anyway (the fax was delivered): the receipt is kept by itself, the client's message does not point to a document, and staff get ONE alert.
 * WHO RECEIVED IT: only a fax to a number we can trust files the job — the IRS number this system knows, or a number a person has confirmed (the
 * box's "Yes, that was the IRS", or an earlier filing a person confirmed). The IRS may change its number, so a different number is not refused: the
 * job is HELD (ONE marker + ONE alert), the box asks "was that the IRS?", and the check files it when a person says yes. A mistyped number that happens
 * to be a live fax line therefore never tells a client "filed", and never becomes the pre-filled number of later jobs.
 * RECEIPT: Faxage can take a few minutes to give the receipt page. If it never does (EXTENSION_RECEIPT_GRACE_MINUTES), the extension is filed anyway
 * (the fax WAS delivered) with the Form 7004 alone for the client, and staff get ONE alert.
 * TWO CHECKS AT ONCE (the cron and "Check now"): each writes a filing claim and only the earliest recent one goes on, so the client is told once.
 *
 * All outside work (database, Faxage, storage, the stage move, the chat) sits behind `ExtensionFaxDeps`, so the decisions are tested with fakes; the
 * real deps are at the bottom (`realExtensionFaxDeps`). Faxage never answers from the sandbox: nothing is sent there, so there is nothing to check.
 */

import { createHash, randomUUID } from 'crypto'
import type { FaxDeliveryStatus } from '@/lib/fax/faxage'
import {
  decideExtensionFaxOutcome,
  DEFAULT_EXTENSION_FAX_NUMBER,
  EXTENSION_FAX_MARKERS,
  EXTENSION_FAX_PURPOSE,
  EXTENSION_RECEIPT_GRACE_MINUTES,
  EXTENSION_STAGES,
  extensionFiledMessage,
  extensionReceiptName,
  FILING_CLAIM_MINUTES,
  faxDigits,
  form7004OnlyName,
  mergedDocumentName,
} from '@/lib/fax/extension-fax'

export interface ExtensionJob {
  id: string
  service_type: string | null
  stage: string | null
  status: string | null
  account_id: string | null
  contact_id: string | null
  service_name: string | null
  due_date: string | null
  created_at: string | null
  stage_entered_at: string | null
}

export interface ExtensionFaxRow {
  created_at: string
  record_id: string | null
  details: { job_id?: string; faxno?: string; document_id?: string | null; content_hash?: string | null } | null
}

export interface ExtensionFaxDeps {
  now(): number
  loadJob(sdId: string): Promise<{ job: ExtensionJob | null; error: string | null }>
  /** the newest fax_sent row of the job that carries the extension purpose */
  latestFax(sdId: string): Promise<{ row: ExtensionFaxRow | null; error: string | null }>
  markerExists(kind: string, sdId: string, faxJobId: string): Promise<{ exists: boolean; error: string | null }>
  faxStatus(faxJobId: string): Promise<{ status: FaxDeliveryStatus; error: string | null }>
  transmittal(faxJobId: string): Promise<{ pdf: Buffer | null; error: string | null }>
  /**
   * Is the number this fax went to one we can trust as the IRS? Yes for the IRS number this system knows, for a number a person confirmed for THIS fax, and
   * for a number an earlier extension was filed to (which only happens after a person confirmed it).
   */
  recipientTrusted(p: { sdId: string; faxJobId: string; faxno: string | null | undefined }): Promise<{ trusted: boolean; error: string | null }>
  /** Take the right to file this fax: true only for the earliest recent claim, so two checks at the same moment never file twice. */
  claimFiling(sdId: string, faxJobId: string): Promise<{ won: boolean; error: string | null }>
  taxYear(job: ExtensionJob): number | null
  companyName(accountId: string): Promise<string>
  /** the Form 7004 exactly as it is stored (the working copy), by its CRM document row */
  readWorkingCopy(documentId: string): Promise<{ bytes: Buffer | null; error: string | null }>
  /** merge the 7004 and the receipt into one PDF (throws a plain sentence when it cannot) */
  merge(parts: Buffer[]): Promise<Buffer>
  /** route 'drive' = the company has no storage to hold it */
  saveDocument(p: { accountId: string; sdId: string; name: string; bytes: Buffer; year: number | null; key: string; visibleToClient: boolean; documentType: string; typeLabel: string }): Promise<{ route: 'store' | 'drive'; fileId?: string }>
  advanceToFiled(sdId: string, notes: string): Promise<{ ok: boolean; error?: string }>
  /** the client's language and the topic/message plumbing; `posted` false = nobody to address */
  clientIsItalian(job: ExtensionJob): Promise<boolean>
  extensionDeadline(job: ExtensionJob, year: number | null): Promise<string | null>
  postClientMessage(p: { job: ExtensionJob; year: number | null; message: string }): Promise<{ posted: boolean; alreadyThere: boolean; error: string | null }>
  writeMarker(kind: string, p: { sdId: string; accountId: string | null; faxJobId: string; summary: string; details: Record<string, unknown> }): Promise<{ error: string | null }>
  alert(message: string, context: Record<string, unknown>): Promise<void>
}

export type ExtensionFaxResult =
  | { outcome: 'not_applicable'; reason: string }
  | { outcome: 'no_fax' }
  | { outcome: 'already_done' }
  | { outcome: 'pending'; note?: string }
  | { outcome: 'waiting_too_long' }
  | { outcome: 'failed' }
  /** delivered to a number nobody has confirmed is the IRS: held until a person says so */
  | { outcome: 'needs_recipient_check' }
  | { outcome: 'filed'; documentSaved: boolean; messagePosted: boolean }
  | { outcome: 'error'; error: string }

/** Check one job's extension fax. Never throws: every outside failure comes back as `{ outcome: 'error' }` and is retried on the next run. */
export async function processExtensionFaxDelivery(sdId: string, d: ExtensionFaxDeps): Promise<ExtensionFaxResult> {
  try {
    const loaded = await d.loadJob(sdId)
    if (loaded.error) return { outcome: 'error', error: loaded.error }
    const job = loaded.job
    if (!job) return { outcome: 'not_applicable', reason: 'job not found' }
    if (job.service_type !== 'Tax Return') return { outcome: 'not_applicable', reason: 'not a Tax Return job' }
    // the job waits at the first step; a crash after the move leaves it at "Extension Filed" with the message still to post
    if (job.stage !== EXTENSION_STAGES.waiting && job.stage !== EXTENSION_STAGES.filed) {
      return { outcome: 'not_applicable', reason: `the job is at "${job.stage ?? 'no step'}", not "${EXTENSION_STAGES.waiting}"` }
    }
    if (job.status === 'cancelled') return { outcome: 'not_applicable', reason: 'the job is cancelled' }

    const fax = await d.latestFax(sdId)
    if (fax.error) return { outcome: 'error', error: fax.error }
    if (!fax.row) return { outcome: 'no_fax' }
    const faxJobId = fax.row.details?.job_id
    if (!faxJobId) return { outcome: 'error', error: 'the fax history row has no Faxage job id, so its delivery cannot be checked' }

    const done = await d.markerExists(EXTENSION_FAX_MARKERS.confirmed, sdId, faxJobId)
    if (done.error) return { outcome: 'error', error: done.error }
    if (done.exists) return { outcome: 'already_done' }

    const st = await d.faxStatus(faxJobId)
    if (st.error) return { outcome: 'error', error: st.error }
    const decision = decideExtensionFaxOutcome(st.status, fax.row.created_at, d.now())
    const context = { service_delivery_id: sdId, fax_job_id: faxJobId }

    if (decision === 'pending') return { outcome: 'pending' }

    if (decision === 'stale') {
      const seen = await d.markerExists(EXTENSION_FAX_MARKERS.stale, sdId, faxJobId)
      if (seen.error) return { outcome: 'error', error: seen.error }
      if (!seen.exists) {
        const w = await d.writeMarker(EXTENSION_FAX_MARKERS.stale, { sdId, accountId: job.account_id, faxJobId, summary: 'Extension fax not confirmed by Faxage yet', details: { job_id: faxJobId } })
        if (w.error) return { outcome: 'error', error: w.error }
        await d.alert(`A Form 7004 was faxed more than 2 hours ago and Faxage has not confirmed it was delivered (fax job ${faxJobId}). Check it in Fax History; the job stays at "${EXTENSION_STAGES.waiting}".`, context)
      }
      return { outcome: 'waiting_too_long' }
    }

    if (decision === 'failed') {
      const seen = await d.markerExists(EXTENSION_FAX_MARKERS.failed, sdId, faxJobId)
      if (seen.error) return { outcome: 'error', error: seen.error }
      if (!seen.exists) {
        const reason = 'Faxage reported that the fax was not delivered.'
        const w = await d.writeMarker(EXTENSION_FAX_MARKERS.failed, { sdId, accountId: job.account_id, faxJobId, summary: 'Extension fax failed', details: { job_id: faxJobId, reason } })
        if (w.error) return { outcome: 'error', error: w.error }
        await d.alert(`A Form 7004 fax FAILED (fax job ${faxJobId}). The job stays at "${EXTENSION_STAGES.waiting}"; send it again from the extension box.`, context)
      }
      return { outcome: 'failed' }
    }

    // DELIVERED. First WHO got it: only the IRS number we know, or one a person confirmed, files the job.
    const faxno = fax.row.details?.faxno ?? null
    const trust = await d.recipientTrusted({ sdId, faxJobId, faxno })
    if (trust.error) return { outcome: 'error', error: trust.error }
    if (!trust.trusted) {
      const seen = await d.markerExists(EXTENSION_FAX_MARKERS.recipientUnverified, sdId, faxJobId)
      if (seen.error) return { outcome: 'error', error: seen.error }
      if (!seen.exists) {
        const w = await d.writeMarker(EXTENSION_FAX_MARKERS.recipientUnverified, { sdId, accountId: job.account_id, faxJobId, summary: 'Extension fax delivered to a number not confirmed as the IRS', details: { job_id: faxJobId, faxno, faxno_digits: faxDigits(faxno) } })
        if (w.error) return { outcome: 'error', error: w.error }
        await d.alert(`A Form 7004 was delivered (fax job ${faxJobId}) to ${faxno ?? 'an unknown number'}, which is not the IRS number this system knows. The job was NOT moved and the client was NOT told. Open the job and say whether that number is the IRS (the extension box asks), or send the fax again.`, context)
      }
      return { outcome: 'needs_recipient_check' }
    }

    // The receipt page is needed next: Faxage answers "not ready" for a few minutes after delivery (try again next run, move nothing yet).
    // If it never comes, the fax WAS delivered: after the grace time the extension is filed without it.
    const t = await d.transmittal(faxJobId)
    const receipt: Buffer | null = t.pdf
    let receiptMissing: string | null = null
    if (!receipt) {
      const sentMs = Date.parse(fax.row.created_at)
      const waitedMinutes = Number.isNaN(sentMs) ? 0 : (d.now() - sentMs) / 60_000
      if (waitedMinutes <= EXTENSION_RECEIPT_GRACE_MINUTES) return { outcome: 'pending', note: t.error ?? 'the receipt page is not ready yet' }
      receiptMissing = `Faxage never gave the fax receipt page (${t.error ?? 'not available'})`
    }

    // Two checks at the same moment (the cron and "Check now"): only the earliest claim goes on, so the client is told once.
    const claim = await d.claimFiling(sdId, faxJobId)
    if (claim.error) return { outcome: 'error', error: claim.error }
    if (!claim.won) return { outcome: 'pending', note: 'another check is filing this extension right now' }

    const year = d.taxYear(job)
    const company = job.account_id ? await d.companyName(job.account_id) : 'Company'

    // 1. the document: the 7004 as faxed + the receipt, merged and saved (idempotent on its key); the receipt alone when that cannot be done
    //    (no receipt at all: the Form 7004 alone is what the client gets)
    let documentSaved = false
    let documentFileId: string | null = null
    let problem: string | null = receiptMissing
    if (!job.account_id) {
      problem = 'the job has no company, so there is no storage to hold the document'
    } else {
      const docId = fax.row.details?.document_id ?? fax.row.record_id
      const work = docId ? await d.readWorkingCopy(docId) : { bytes: null, error: 'the history row does not name the Form 7004 that was faxed' }
      if (!work.bytes) {
        problem = `the Form 7004 that was faxed could not be read (${work.error ?? 'unknown'})`
      } else {
        const faxedHash = fax.row.details?.content_hash ?? null
        const nowHash = createHash('sha256').update(work.bytes).digest('hex')
        if (faxedHash && faxedHash !== nowHash) {
          problem = 'the stored Form 7004 was changed after it was faxed, so it is not what the IRS received'
        } else {
          try {
            const bytes = receipt ? await d.merge([work.bytes, receipt]) : work.bytes
            const saved = await d.saveDocument(receipt
              ? { accountId: job.account_id, sdId, name: mergedDocumentName(company, year), bytes, year, key: `extension-7004-merged:${faxJobId}`, visibleToClient: true, documentType: 'form_7004', typeLabel: 'Form 7004' }
              : { accountId: job.account_id, sdId, name: form7004OnlyName(company, year), bytes, year, key: `extension-7004-filed:${faxJobId}`, visibleToClient: true, documentType: 'form_7004', typeLabel: 'Form 7004' })
            documentSaved = saved.route === 'store'
            documentFileId = saved.fileId ?? null
            if (!documentSaved) problem = 'the company has no storage to hold the document'
          } catch (e) {
            problem = `the Form 7004 and the receipt could not be merged (${e instanceof Error ? e.message : String(e)})`
          }
        }
      }
      if (!documentSaved && receipt) {
        // the receipt alone, internal, so it is never lost
        try {
          await d.saveDocument({ accountId: job.account_id, sdId, name: extensionReceiptName(company, year), bytes: receipt, year, key: `extension-7004-receipt:${faxJobId}`, visibleToClient: false, documentType: 'fax_confirmation', typeLabel: 'Fax Confirmation' })
        } catch (e) {
          problem = `${problem ?? 'the merged document was not saved'}; the receipt alone could not be saved either (${e instanceof Error ? e.message : String(e)})`
        }
      }
    }
    if (problem) {
      const hint = receiptMissing && documentSaved
        ? 'The Form 7004 alone was saved for the client; the receipt is in Fax History if you want to add it.'
        : 'Save the merged document by hand (Storage › Merge into one, then type Form 7004) — the receipt is in Fax History.'
      await d.alert(`A Form 7004 fax was delivered (fax job ${faxJobId}) and the extension is being filed, but ${problem}. ${hint}`, context)
    }

    // 2. the move to "Extension Filed" (the tax record follows: extension filed + today's date). Our own message below replaces the generic notice.
    if (job.stage !== EXTENSION_STAGES.filed) {
      let moved = await d.advanceToFiled(sdId, `Extension fax delivered to the IRS (Faxage job ${faxJobId}); the Form 7004 + receipt document is ${documentSaved ? 'saved in the company Tax folder' : 'NOT saved'}`)
      if (!moved.ok) {
        // a second check may have moved it a moment ago
        const again = await d.loadJob(sdId)
        if (again.job && again.job.stage === EXTENSION_STAGES.filed) moved = { ok: true }
      }
      if (!moved.ok) {
        await d.alert(`The Form 7004 fax was delivered (fax job ${faxJobId}) but the job did not move to "${EXTENSION_STAGES.filed}": ${moved.error ?? 'refused'}. Move it by hand.`, context)
        return { outcome: 'error', error: moved.error ?? `the move to ${EXTENSION_STAGES.filed} was refused` }
      }
    }

    // 3. the client's message (looked up first, so a retry never posts it twice)
    const italian = await d.clientIsItalian(job)
    const deadlineIso = await d.extensionDeadline(job, year)
    const message = extensionFiledMessage({ italian, year, deadlineIso, withDocument: documentSaved, withReceipt: !receiptMissing })
    const posted = await d.postClientMessage({ job, year, message })
    if (posted.error) {
      await d.alert(`The extension is filed (fax job ${faxJobId}) but the client's chat message could not be posted: ${posted.error}. Tell the client by hand.`, context)
    }

    const w = await d.writeMarker(EXTENSION_FAX_MARKERS.confirmed, {
      sdId, accountId: job.account_id, faxJobId, summary: 'Extension fax delivered; job moved to Extension Filed',
      details: { job_id: faxJobId, faxno, faxno_digits: faxDigits(faxno), receipt_missing: !!receiptMissing, document_file_id: documentFileId, document_saved: documentSaved, message_posted: posted.posted || posted.alreadyThere },
    })
    if (w.error) await d.alert(`The extension fax was delivered and the job was moved, but the confirmation marker could not be saved (${w.error}).`, context)
    return { outcome: 'filed', documentSaved, messagePosted: posted.posted || posted.alreadyThere }
  } catch (e) {
    return { outcome: 'error', error: e instanceof Error ? e.message : String(e) }
  }
}

/** The real dependencies (database, Faxage, storage, the stage move, the chat). Imported lazily so the pure logic above loads without any of them. */
export async function realExtensionFaxDeps(): Promise<ExtensionFaxDeps> {
  const { supabaseAdmin } = await import('@/lib/supabase-admin')
  const { taxReturnYear, buildFlowTopic } = await import('@/lib/flows/resolve-flows')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- action_log / service_deliveries columns used here are not all in the generated types
  const db = supabaseAdmin as any
  const msg = (e: { message?: string } | null) => (e ? e.message || 'database error' : null)
  const faxCreds = () => {
    const username = process.env.FAXAGE_USERNAME
    const password = process.env.FAXAGE_PASSWORD
    const company = process.env.FAXAGE_COMPANY || username || ''
    return username && password ? { username, company, password } : null
  }
  const contactOf = async (job: ExtensionJob): Promise<string | null> => {
    const { pickChatContact } = await import('@/lib/flows/chat-contact')
    let contactId: string | null = null
    if (job.account_id) {
      const { data: links } = await db.from('account_contacts').select('contact_id, is_primary, ended_at').eq('account_id', job.account_id).order('is_primary', { ascending: false }).order('contact_id')
      contactId = pickChatContact({ jobContactId: job.contact_id ?? null, links: links ?? [] })
    }
    return contactId ?? job.contact_id ?? null
  }
  return {
    now: () => Date.now(),
    loadJob: async (sdId) => {
      const { data, error } = await db
        .from('service_deliveries')
        .select('id, service_type, stage, status, account_id, contact_id, service_name, due_date, created_at, stage_entered_at')
        .eq('id', sdId)
        .maybeSingle()
      return { job: (data as ExtensionJob | null) ?? null, error: msg(error) }
    },
    latestFax: async (sdId) => {
      const { data, error } = await db
        .from('action_log')
        .select('created_at, record_id, details')
        .eq('service_delivery_id', sdId)
        .eq('action_type', 'fax_sent')
        .eq('details->>purpose', EXTENSION_FAX_PURPOSE)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      return { row: (data as ExtensionFaxRow | null) ?? null, error: msg(error) }
    },
    markerExists: async (kind, sdId, faxJobId) => {
      const { data, error } = await db
        .from('action_log')
        .select('id')
        .eq('action_type', kind)
        .eq('service_delivery_id', sdId)
        .eq('details->>job_id', faxJobId)
        .limit(1)
      return { exists: Array.isArray(data) && data.length > 0, error: msg(error) }
    },
    faxStatus: async (faxJobId) => {
      const creds = faxCreds()
      if (!creds) return { status: 'unknown', error: 'The fax service is not configured (missing FAXAGE credentials).' }
      const { getFaxStatus } = await import('@/lib/fax/faxage')
      const r = await getFaxStatus(creds, { jobId: faxJobId })
      if (!r.ok) return { status: 'unknown', error: `Faxage rejected the status request: ${(r.error ?? 'unknown error').slice(0, 200)}` }
      const rec = r.records.find((x) => x.jobId === faxJobId) ?? r.records[0]
      return { status: rec ? rec.status : 'unknown', error: null }
    },
    transmittal: async (faxJobId) => {
      const creds = faxCreds()
      if (!creds) return { pdf: null, error: 'The fax service is not configured (missing FAXAGE credentials).' }
      const { getFaxTransmittal, FAXAGE_TZ_EASTERN } = await import('@/lib/fax/faxage')
      const r = await getFaxTransmittal(creds, faxJobId, { tz: FAXAGE_TZ_EASTERN })
      return { pdf: r.ok ? r.pdf : null, error: r.ok ? null : r.error }
    },
    recipientTrusted: async ({ sdId, faxJobId, faxno }) => {
      const digits = faxDigits(faxno)
      if (digits === DEFAULT_EXTENSION_FAX_NUMBER) return { trusted: true, error: null }
      // a person confirmed THIS fax, or an earlier extension fax to this number was filed (which only happens after a person confirmed it)
      const own = await db.from('action_log').select('id').eq('action_type', EXTENSION_FAX_MARKERS.recipientConfirmed).eq('service_delivery_id', sdId).eq('details->>job_id', faxJobId).limit(1)
      if (own.error) return { trusted: false, error: msg(own.error) }
      if (Array.isArray(own.data) && own.data.length > 0) return { trusted: true, error: null }
      if (digits.length !== 10) return { trusted: false, error: null }
      const before = await db.from('action_log').select('id').in('action_type', [EXTENSION_FAX_MARKERS.recipientConfirmed, EXTENSION_FAX_MARKERS.confirmed]).eq('details->>faxno_digits', digits).limit(1)
      if (before.error) return { trusted: false, error: msg(before.error) }
      return { trusted: Array.isArray(before.data) && before.data.length > 0, error: null }
    },
    claimFiling: async (sdId, faxJobId) => {
      const claimId = randomUUID()
      const ins = await db.from('action_log').insert({
        actor: 'system',
        action_type: EXTENSION_FAX_MARKERS.filingClaim,
        table_name: 'service_deliveries',
        record_id: sdId,
        service_delivery_id: sdId,
        summary: 'Extension fax: claim to file',
        details: { job_id: faxJobId, claim_id: claimId },
      })
      if (ins.error) return { won: false, error: msg(ins.error) }
      const since = new Date(Date.now() - FILING_CLAIM_MINUTES * 60_000).toISOString()
      const first = await db
        .from('action_log')
        .select('id, details')
        .eq('action_type', EXTENSION_FAX_MARKERS.filingClaim)
        .eq('service_delivery_id', sdId)
        .eq('details->>job_id', faxJobId)
        .gte('created_at', since)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .limit(1)
      if (first.error) return { won: false, error: msg(first.error) }
      const row = Array.isArray(first.data) ? first.data[0] : null
      return { won: (row?.details?.claim_id as string | undefined) === claimId, error: null }
    },
    taxYear: (job) => taxReturnYear(job),
    companyName: async (accountId) => {
      const { data } = await db.from('accounts').select('company_name').eq('id', accountId).maybeSingle()
      return ((data?.company_name as string | null | undefined) ?? '').trim() || 'Company'
    },
    readWorkingCopy: async (documentId) => {
      const { data, error } = await db.from('documents').select('id, drive_file_id').eq('id', documentId).maybeSingle()
      if (error) return { bytes: null, error: msg(error) }
      if (!data?.drive_file_id) return { bytes: null, error: 'the document row has no stored file' }
      const { parseStorePointer, readStoreFile } = await import('@/lib/crm-store/document-pointer')
      const fileId = parseStorePointer(data.drive_file_id as string)
      if (!fileId) return { bytes: null, error: 'the Form 7004 is not in the company storage' }
      try {
        const f = await readStoreFile(fileId)
        return { bytes: f.bytes, error: null }
      } catch (e) {
        return { bytes: null, error: e instanceof Error ? e.message : String(e) }
      }
    },
    merge: async (parts) => {
      const { mergePdfs } = await import('@/lib/crm-store/pdf-merge')
      return (await mergePdfs(parts)).bytes
    },
    saveDocument: async (p) => {
      const { saveDocumentForAccount } = await import('@/lib/crm-store/save-for-account')
      const r = await saveDocumentForAccount({
        accountId: p.accountId,
        name: p.name,
        bytes: p.bytes,
        mimeType: 'application/pdf',
        folder: 'tax',
        documentType: p.documentType,
        callerKey: p.key,
        portalVisible: p.visibleToClient,
        periodYear: p.year,
        actor: null, // the storage records a person's id here; the system has none (a word such as "system" is refused by the database)
        row: { document_type_name: p.typeLabel, category: 3, status: 'classified', service_delivery_id: p.sdId, flow_stage: EXTENSION_STAGES.waiting },
      })
      return r.route === 'store' ? { route: 'store', fileId: r.fileId } : { route: 'drive' }
    },
    advanceToFiled: async (sdId, notes) => {
      const { advanceServiceDelivery } = await import('@/lib/service-delivery')
      // skip_notify: the client gets the message below (in their language, with the deadline), not the generic stage notice
      const res = await advanceServiceDelivery({ delivery_id: sdId, target_stage: EXTENSION_STAGES.filed, actor: 'extension-fax-delivered', notes, skip_notify: true })
      return res && res.success === false ? { ok: false, error: res.error ?? 'refused' } : { ok: true }
    },
    clientIsItalian: async (job) => {
      const contactId = await contactOf(job)
      if (!contactId) return false
      const { data } = await db.from('contacts').select('language').eq('id', contactId).maybeSingle()
      const { isItalian } = await import('@/lib/locale')
      return isItalian((data?.language as string | null | undefined) ?? null)
    },
    extensionDeadline: async (job, year) => {
      // a single-member LLC's extension runs to October 15 of the following year (lib/tax/extension-deadline.ts)
      const { resolveExtensionDeadline } = await import('@/lib/tax/extension-deadline')
      let stored: string | null = null
      if (job.account_id && year) {
        const { data } = await db.from('tax_returns').select('extension_deadline').eq('account_id', job.account_id).eq('tax_year', year).maybeSingle()
        stored = (data?.extension_deadline as string | null | undefined) ?? null
      }
      return resolveExtensionDeadline(stored, year, 'SMLLC')
    },
    postClientMessage: async ({ job, year, message }) => {
      const contactId = await contactOf(job)
      if (!job.account_id && !contactId) return { posted: false, alreadyThere: false, error: 'the job has no company and no contact to write to' }
      const topic = buildFlowTopic('Tax Return', year) || 'Tax Return'
      // the same message already in this job's chat = already told (a retry after a crash)
      const { data: existing, error: lookErr } = await db.from('portal_messages').select('id').eq('service_delivery_id', job.id).eq('sender_type', 'admin').eq('message', message).limit(1)
      if (lookErr) return { posted: false, alreadyThere: false, error: msg(lookErr) }
      if (Array.isArray(existing) && existing.length > 0) return { posted: false, alreadyThere: true, error: null }
      const ADMIN_SENDER_ID = 'b0da5d9c-acf6-4761-9cae-2c3b14dbc631' // the same sender the stage-change chat messages use (lib/service-delivery.ts)
      const { error } = await db.from('portal_messages').insert({
        account_id: job.account_id ?? null,
        contact_id: contactId,
        service_delivery_id: job.id,
        topic,
        sender_type: 'admin',
        sender_id: ADMIN_SENDER_ID,
        message,
        attachments: [],
      })
      if (error) return { posted: false, alreadyThere: false, error: msg(error) }
      // the client is told the usual way (the bell and the e-mail), like any staff message in the job's chat
      const { createPortalNotification, notifyClientOfAdminMessage } = await import('@/lib/portal/notifications')
      createPortalNotification({
        account_id: job.account_id || undefined,
        contact_id: contactId || undefined,
        type: 'chat',
        title: 'New message from Tony Durante Team',
        body: message.slice(0, 100),
        link: `/portal/chat?topic=${encodeURIComponent(topic)}`,
      }).catch(() => {})
      notifyClientOfAdminMessage({ account_id: job.account_id || null, contact_id: contactId, topic, messagePreview: message }).catch(() => {})
      return { posted: true, alreadyThere: false, error: null }
    },
    writeMarker: async (kind, p) => {
      const { error } = await db.from('action_log').insert({
        actor: 'system',
        action_type: kind,
        table_name: 'service_deliveries',
        record_id: p.sdId,
        account_id: p.accountId,
        service_delivery_id: p.sdId,
        summary: p.summary,
        details: p.details,
      })
      return { error: msg(error) }
    },
    alert: async (message, context) => {
      try {
        const { reportSystemError } = await import('@/lib/system-errors')
        await reportSystemError({ source: 'server', route: '/api/cron/extension-fax-confirm', message, context })
      } catch {
        /* an alert never breaks the check */
      }
    },
  }
}
