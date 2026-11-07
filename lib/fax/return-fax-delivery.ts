/**
 * Tax Return "Signed" step — the delivery check of a return fax (plan item 6, dev job 6f555c9f, 2026-11-07).
 *
 * After staff send the signed return from the fax box, Faxage reports whether the fax reached the IRS line. This check (run every few minutes by
 * /api/cron/return-fax-confirm, and on the box's "Check now") asks Faxage about the job's latest fax and, per answer:
 *   DELIVERED → save the Faxage receipt in the company's Tax folder (type "Fax Confirmation", the tax year stamped) and move the job to "TR Filed"
 *               (the same move as the "File with IRS" button: the tax record, the client's notice and the banner follow). A marker row is written
 *               LAST, so a crash half-way is simply retried (the receipt save is idempotent on its key; a job already at "TR Filed" counts as done).
 *   FAILED    → nothing moves; ONE marker + ONE alert per fax; the box turns red and offers a confirmed re-send.
 *   WAITING   → nothing moves; after RETURN_FAX_STALE_MINUTES ONE marker + ONE alert; still checked on every run.
 * The job must still be at "Signed": a job staff already moved on is left alone.
 *
 * All outside work (database, Faxage, storage, the stage move) sits behind `ReturnFaxDeps`, so the decisions are tested with fakes; the real
 * deps are at the bottom (`realReturnFaxDeps`). Faxage never answers from the sandbox: nothing is sent there, so there is nothing to check.
 */

import type { FaxDeliveryStatus } from '@/lib/fax/faxage'
import { decideReturnFaxOutcome, isReturnFaxLine, RETURN_FAX_MARKERS, returnFaxReceiptName } from '@/lib/fax/return-fax'
import { TAX_RETURN_SIGN_STAGES } from '@/lib/flows/tax-return-sign-stages'

export interface DeliveryJob {
  id: string
  service_type: string | null
  stage: string | null
  status: string | null
  account_id: string | null
  service_name: string | null
  due_date: string | null
  created_at: string | null
  stage_entered_at: string | null
}

export interface ReturnFaxDeps {
  now(): number
  loadJob(sdId: string): Promise<{ job: DeliveryJob | null; error: string | null }>
  /** the newest fax_sent row of the job */
  latestFax(sdId: string): Promise<{ row: { created_at: string; details: { job_id?: string; faxno?: string } | null } | null; error: string | null }>
  markerExists(kind: string, sdId: string, faxJobId: string): Promise<{ exists: boolean; error: string | null }>
  faxStatus(faxJobId: string): Promise<{ status: FaxDeliveryStatus; error: string | null }>
  transmittal(faxJobId: string): Promise<{ pdf: Buffer | null; error: string | null }>
  taxYear(job: DeliveryJob): number | null
  companyName(accountId: string): Promise<string>
  /** route 'drive' = the company has no storage to hold it */
  saveReceipt(p: { accountId: string; sdId: string; name: string; bytes: Buffer; year: number | null; faxJobId: string }): Promise<{ route: 'store' | 'drive'; fileId?: string }>
  advanceToFiled(sdId: string, notes: string): Promise<{ ok: boolean; error?: string }>
  writeMarker(kind: string, p: { sdId: string; accountId: string | null; faxJobId: string; summary: string; details: Record<string, unknown> }): Promise<{ error: string | null }>
  alert(message: string, context: Record<string, unknown>): Promise<void>
}

export type ReturnFaxResult =
  | { outcome: 'not_applicable'; reason: string }
  | { outcome: 'no_fax' }
  | { outcome: 'already_done' }
  | { outcome: 'pending'; note?: string }
  | { outcome: 'waiting_too_long' }
  | { outcome: 'failed' }
  | { outcome: 'filed'; receiptSaved: boolean }
  | { outcome: 'error'; error: string }

/** Check one job's latest return fax. Never throws: every outside failure comes back as `{ outcome: 'error' }` and is retried on the next run. */
export async function processReturnFaxDelivery(sdId: string, d: ReturnFaxDeps): Promise<ReturnFaxResult> {
  try {
    const loaded = await d.loadJob(sdId)
    if (loaded.error) return { outcome: 'error', error: loaded.error }
    const job = loaded.job
    if (!job) return { outcome: 'not_applicable', reason: 'job not found' }
    if (job.service_type !== 'Tax Return') return { outcome: 'not_applicable', reason: 'not a Tax Return job' }
    if (job.stage !== TAX_RETURN_SIGN_STAGES.signed) return { outcome: 'not_applicable', reason: `the job is at "${job.stage ?? 'no step'}", not "Signed"` }

    const fax = await d.latestFax(sdId)
    if (fax.error) return { outcome: 'error', error: fax.error }
    if (!fax.row) return { outcome: 'no_fax' }
    // only a fax to the IRS return line files the job: a test fax to another number, or a mistyped one, reached someone else
    if (!isReturnFaxLine(fax.row.details?.faxno)) return { outcome: 'not_applicable', reason: 'the last fax did not go to the IRS return line' }
    const faxJobId = fax.row.details?.job_id
    if (!faxJobId) return { outcome: 'error', error: 'the fax history row has no Faxage job id, so its delivery cannot be checked' }

    const done = await d.markerExists(RETURN_FAX_MARKERS.confirmed, sdId, faxJobId)
    if (done.error) return { outcome: 'error', error: done.error }
    if (done.exists) return { outcome: 'already_done' }

    const st = await d.faxStatus(faxJobId)
    if (st.error) return { outcome: 'error', error: st.error }
    const decision = decideReturnFaxOutcome(st.status, fax.row.created_at, d.now())
    const context = { service_delivery_id: sdId, fax_job_id: faxJobId }

    if (decision === 'pending') return { outcome: 'pending' }

    if (decision === 'stale') {
      const seen = await d.markerExists(RETURN_FAX_MARKERS.stale, sdId, faxJobId)
      if (seen.error) return { outcome: 'error', error: seen.error }
      if (!seen.exists) {
        const w = await d.writeMarker(RETURN_FAX_MARKERS.stale, { sdId, accountId: job.account_id, faxJobId, summary: 'Return fax not confirmed by Faxage yet', details: { job_id: faxJobId } })
        if (w.error) return { outcome: 'error', error: w.error }
        await d.alert(`A signed return was faxed more than 2 hours ago and Faxage has not confirmed it was delivered (fax job ${faxJobId}). Check it in Fax History; the job stays at "Signed".`, context)
      }
      return { outcome: 'waiting_too_long' }
    }

    if (decision === 'failed') {
      const seen = await d.markerExists(RETURN_FAX_MARKERS.failed, sdId, faxJobId)
      if (seen.error) return { outcome: 'error', error: seen.error }
      if (!seen.exists) {
        const reason = 'Faxage reported that the fax was not delivered.'
        const w = await d.writeMarker(RETURN_FAX_MARKERS.failed, { sdId, accountId: job.account_id, faxJobId, summary: 'Return fax failed', details: { job_id: faxJobId, reason } })
        if (w.error) return { outcome: 'error', error: w.error }
        await d.alert(`A signed return fax FAILED (fax job ${faxJobId}). The job stays at "Signed"; send it again from the fax box.`, context)
      }
      return { outcome: 'failed' }
    }

    // DELIVERED: the receipt first (idempotent), then the move, then the marker.
    const year = d.taxYear(job)
    const company = job.account_id ? await d.companyName(job.account_id) : 'Company'
    let receiptSaved = false
    let receiptFileId: string | null = null
    const t = await d.transmittal(faxJobId)
    if (!t.pdf) {
      // Faxage answers "not ready" for a few minutes after delivery: try again on the next run, move nothing yet
      return { outcome: 'pending', note: t.error ?? 'the receipt page is not ready yet' }
    }
    if (job.account_id) {
      const saved = await d.saveReceipt({ accountId: job.account_id, sdId, name: returnFaxReceiptName(company, year), bytes: t.pdf, year, faxJobId })
      receiptSaved = saved.route === 'store'
      receiptFileId = saved.fileId ?? null
      if (!receiptSaved) {
        await d.alert(`The return fax was delivered (fax job ${faxJobId}) but the company has no storage to hold the Faxage receipt. The job is being filed; save the receipt by hand from Fax History.`, context)
      }
    }

    let moved = await d.advanceToFiled(sdId, `Return fax delivered to the IRS (Faxage job ${faxJobId}); the receipt is ${receiptSaved ? 'saved in the company Tax folder' : 'NOT saved'}`)
    if (!moved.ok) {
      // a second check may have moved it a moment ago: a job already at "TR Filed" is done
      const again = await d.loadJob(sdId)
      if (again.job && again.job.stage === TAX_RETURN_SIGN_STAGES.filed) moved = { ok: true }
    }
    if (!moved.ok) {
      await d.alert(`The return fax was delivered (fax job ${faxJobId}) but the job did not move to "TR Filed": ${moved.error ?? 'refused'}. Move it by hand.`, context)
      return { outcome: 'error', error: moved.error ?? 'the move to TR Filed was refused' }
    }

    const w = await d.writeMarker(RETURN_FAX_MARKERS.confirmed, {
      sdId, accountId: job.account_id, faxJobId, summary: 'Return fax delivered; job filed',
      details: { job_id: faxJobId, receipt_file_id: receiptFileId, receipt_saved: receiptSaved },
    })
    if (w.error) await d.alert(`The return fax was delivered and the job was filed, but the confirmation marker could not be saved (${w.error}).`, context)
    return { outcome: 'filed', receiptSaved }
  } catch (e) {
    return { outcome: 'error', error: e instanceof Error ? e.message : String(e) }
  }
}

/** The real dependencies (database, Faxage, storage, the stage move). Imported lazily so the pure logic above loads without any of them. */
export async function realReturnFaxDeps(): Promise<ReturnFaxDeps> {
  const { supabaseAdmin } = await import('@/lib/supabase-admin')
  const { taxReturnYear } = await import('@/lib/flows/resolve-flows')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- action_log / service_deliveries columns used here are not all in the generated types
  const db = supabaseAdmin as any
  const msg = (e: { message?: string } | null) => (e ? e.message || 'database error' : null)
  return {
    now: () => Date.now(),
    loadJob: async (sdId) => {
      const { data, error } = await db
        .from('service_deliveries')
        .select('id, service_type, stage, status, account_id, service_name, due_date, created_at, stage_entered_at')
        .eq('id', sdId)
        .maybeSingle()
      return { job: (data as DeliveryJob | null) ?? null, error: msg(error) }
    },
    latestFax: async (sdId) => {
      const { data, error } = await db
        .from('action_log')
        .select('created_at, details')
        .eq('service_delivery_id', sdId)
        .eq('action_type', 'fax_sent')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      return { row: (data as { created_at: string; details: { job_id?: string } | null } | null) ?? null, error: msg(error) }
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
      const username = process.env.FAXAGE_USERNAME
      const password = process.env.FAXAGE_PASSWORD
      const company = process.env.FAXAGE_COMPANY || username || ''
      if (!username || !password) return { status: 'unknown', error: 'The fax service is not configured (missing FAXAGE credentials).' }
      const { getFaxStatus } = await import('@/lib/fax/faxage')
      const r = await getFaxStatus({ username, company, password }, { jobId: faxJobId })
      if (!r.ok) return { status: 'unknown', error: `Faxage rejected the status request: ${(r.error ?? 'unknown error').slice(0, 200)}` }
      const rec = r.records.find((x) => x.jobId === faxJobId) ?? r.records[0]
      return { status: rec ? rec.status : 'unknown', error: null }
    },
    transmittal: async (faxJobId) => {
      const username = process.env.FAXAGE_USERNAME
      const password = process.env.FAXAGE_PASSWORD
      const company = process.env.FAXAGE_COMPANY || username || ''
      if (!username || !password) return { pdf: null, error: 'The fax service is not configured (missing FAXAGE credentials).' }
      const { getFaxTransmittal, FAXAGE_TZ_EASTERN } = await import('@/lib/fax/faxage')
      const r = await getFaxTransmittal({ username, company, password }, faxJobId, { tz: FAXAGE_TZ_EASTERN })
      return { pdf: r.ok ? r.pdf : null, error: r.ok ? null : r.error }
    },
    taxYear: (job) => taxReturnYear(job),
    companyName: async (accountId) => {
      const { data } = await db.from('accounts').select('company_name').eq('id', accountId).maybeSingle()
      return ((data?.company_name as string | null | undefined) ?? '').trim() || 'Company'
    },
    saveReceipt: async (p) => {
      const { saveDocumentForAccount } = await import('@/lib/crm-store/save-for-account')
      const r = await saveDocumentForAccount({
        accountId: p.accountId,
        name: p.name,
        bytes: p.bytes,
        mimeType: 'application/pdf',
        folder: 'tax',
        documentType: 'fax_confirmation',
        callerKey: `return-fax-receipt:${p.faxJobId}`,
        portalVisible: false,
        periodYear: p.year,
        actor: null, // the storage records a person's id here; the system has none (a word such as "system" is refused by the database)
        row: { document_type_name: 'Fax Confirmation', category: 3, status: 'classified', service_delivery_id: p.sdId },
      })
      return r.route === 'store' ? { route: 'store', fileId: r.fileId } : { route: 'drive' }
    },
    advanceToFiled: async (sdId, notes) => {
      const { advanceServiceDelivery } = await import('@/lib/service-delivery')
      const res = await advanceServiceDelivery({ delivery_id: sdId, target_stage: TAX_RETURN_SIGN_STAGES.filed, actor: 'return-fax-delivered', notes })
      return res && res.success === false ? { ok: false, error: res.error ?? 'refused' } : { ok: true }
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
        await reportSystemError({ source: 'server', route: '/api/cron/return-fax-confirm', message, context })
      } catch {
        /* an alert never breaks the check */
      }
    },
  }
}
