/**
 * Tax Return plan item 6 (dev job 6f555c9f) — the delivery check of a return fax (lib/fax/return-fax-delivery.ts), with a faked fax company:
 * delivered files the job (receipt first, move second, marker LAST), a failed or waiting fax alerts ONCE and moves nothing, a fax to any other
 * number never files a client's return, and every outside failure comes back as an error to retry — never a throw, never a half-filed job.
 */
import { describe, it, expect } from 'vitest'
import { processReturnFaxDelivery, type DeliveryJob, type ReturnFaxDeps } from '@/lib/fax/return-fax-delivery'
import { RETURN_FAX_MARKERS } from '@/lib/fax/return-fax'
import type { FaxDeliveryStatus } from '@/lib/fax/faxage'

const SENT_AT = '2026-11-07T10:00:00Z'
const NOW = Date.parse(SENT_AT) + 10 * 60_000 // ten minutes after the send

interface World {
  job: DeliveryJob | null
  /** what the job looks like on a RELOAD (after a failed move) */
  jobAfter?: DeliveryJob | null
  fax: { created_at: string; details: { job_id?: string; faxno?: string } | null } | null
  markers: Array<{ kind: string; faxJobId: string }>
  status: FaxDeliveryStatus
  statusError: string | null
  pdf: Buffer | null
  pdfError: string | null
  save: { route: 'store' | 'drive'; fileId?: string } | 'throw'
  advance: { ok: boolean; error?: string }
  now: number
  loadError: string | null
}
const baseJob = (o: Partial<DeliveryJob> = {}): DeliveryJob => ({
  id: 'sd-1', service_type: 'Tax Return', stage: 'Signed', status: 'active', account_id: 'acc-1',
  service_name: 'Tax Return 2025 - Acme LLC', due_date: null, created_at: '2026-08-01T00:00:00Z', stage_entered_at: '2026-11-06T22:52:27Z', ...o,
})

function setup(over: Partial<World> = {}) {
  const w: World = {
    job: baseJob(), fax: { created_at: SENT_AT, details: { job_id: '555', faxno: '8558877737' } }, markers: [], status: 'delivered', statusError: null,
    pdf: Buffer.from('%PDF-1.4 receipt'), pdfError: null, save: { route: 'store', fileId: 'file-9' }, advance: { ok: true }, now: NOW, loadError: null, ...over,
  }
  const calls: string[] = []
  const log = { alerts: [] as string[], saved: [] as Array<Record<string, unknown>>, advanced: [] as Array<{ sdId: string; notes: string }>, statusAsked: [] as string[] }
  let advancedOnce = false
  const deps: ReturnFaxDeps = {
    now: () => w.now,
    loadJob: async () => {
      calls.push('loadJob')
      if (w.loadError) return { job: null, error: w.loadError }
      // a reload AFTER the move attempt returns the "after" picture when the test gives one
      return { job: advancedOnce && w.jobAfter !== undefined ? w.jobAfter : w.job, error: null }
    },
    latestFax: async () => ({ row: w.fax, error: null }),
    markerExists: async (kind, _sd, faxJobId) => ({ exists: w.markers.some((m) => m.kind === kind && m.faxJobId === faxJobId), error: null }),
    faxStatus: async (id) => { log.statusAsked.push(id); return w.statusError ? { status: 'unknown', error: w.statusError } : { status: w.status, error: null } },
    transmittal: async () => ({ pdf: w.pdf, error: w.pdfError }),
    taxYear: () => 2025,
    companyName: async () => 'Acme LLC',
    saveReceipt: async (p) => {
      calls.push('saveReceipt')
      if (w.save === 'throw') throw new Error('storage down')
      log.saved.push(p as unknown as Record<string, unknown>)
      return w.save
    },
    advanceToFiled: async (sdId, notes) => { calls.push('advance'); advancedOnce = true; log.advanced.push({ sdId, notes }); return w.advance },
    writeMarker: async (kind, p) => { calls.push(`marker:${kind}`); w.markers.push({ kind, faxJobId: p.faxJobId }); return { error: null } },
    alert: async (m) => { log.alerts.push(m) },
  }
  return { w, deps, calls, log }
}

describe('a job the check leaves alone', () => {
  it('not a Tax Return job / not at "Signed" / not found → not applicable, Faxage never asked', async () => {
    for (const job of [baseJob({ service_type: 'ITIN' }), baseJob({ stage: 'Sent for Signature' }), baseJob({ stage: 'TR Filed' }), null]) {
      const { deps, log } = setup({ job })
      expect((await processReturnFaxDelivery('sd-1', deps)).outcome).toBe('not_applicable')
      expect(log.statusAsked).toEqual([])
    }
  })
  it('no fax on record → no_fax (one cheap lookup, no call to Faxage)', async () => {
    const { deps, log } = setup({ fax: null })
    expect(await processReturnFaxDelivery('sd-1', deps)).toEqual({ outcome: 'no_fax' })
    expect(log.statusAsked).toEqual([])
  })
  it('A FAX TO ANY OTHER NUMBER NEVER FILES A RETURN (a test fax, a mistyped number): nothing asked, nothing saved, nothing moved, no alert', async () => {
    for (const faxno of ['5551234567', '8556416935', '', undefined]) {
      const { deps, calls, log } = setup({ fax: { created_at: SENT_AT, details: { job_id: '555', faxno } } })
      const r = await processReturnFaxDelivery('sd-1', deps)
      expect(r.outcome, String(faxno)).toBe('not_applicable')
      expect(log.statusAsked).toEqual([])
      expect(calls).not.toContain('advance')
      expect(log.alerts).toEqual([])
    }
  })
  it('a fax number typed any way ("1 (855) 887-7737") still counts as the IRS return line', async () => {
    const { deps } = setup({ fax: { created_at: SENT_AT, details: { job_id: '555', faxno: '1 (855) 887-7737' } } })
    expect((await processReturnFaxDelivery('sd-1', deps)).outcome).toBe('filed')
  })
  it('already confirmed → already_done (a re-run or a clash with "Check now" does nothing twice)', async () => {
    const { deps, calls } = setup({ markers: [{ kind: RETURN_FAX_MARKERS.confirmed, faxJobId: '555' }] })
    expect((await processReturnFaxDelivery('sd-1', deps)).outcome).toBe('already_done')
    expect(calls).not.toContain('advance')
  })
})

describe('delivered: receipt first, then the move, then the marker LAST', () => {
  it('saves the Faxage receipt (tax year, company, fax job id) and files the job — in that order', async () => {
    const { deps, calls, log, w } = setup()
    expect(await processReturnFaxDelivery('sd-1', deps)).toEqual({ outcome: 'filed', receiptSaved: true })
    expect(calls.filter((c) => c !== 'loadJob')).toEqual(['saveReceipt', 'advance', `marker:${RETURN_FAX_MARKERS.confirmed}`])
    expect(log.saved).toHaveLength(1)
    expect(log.saved[0]).toMatchObject({ accountId: 'acc-1', sdId: 'sd-1', year: 2025, faxJobId: '555', name: 'Fax Confirmation - Acme LLC - Tax Return 2025.pdf' })
    expect(log.advanced).toHaveLength(1)
    expect(log.advanced[0].notes).toContain('Faxage job 555')
    expect(w.markers).toEqual([{ kind: RETURN_FAX_MARKERS.confirmed, faxJobId: '555' }])
    expect(log.alerts).toEqual([])
  })
  it('a second run after success does nothing (the marker is there)', async () => {
    const { deps, calls } = setup()
    await processReturnFaxDelivery('sd-1', deps)
    const before = calls.length
    expect((await processReturnFaxDelivery('sd-1', deps)).outcome).toBe('already_done')
    expect(calls.slice(before).filter((c) => c === 'advance' || c === 'saveReceipt')).toEqual([])
  })
  it('the receipt page is not ready yet → waiting; NOTHING is saved or moved, and it is tried again next run', async () => {
    const { deps, calls } = setup({ pdf: null, pdfError: 'ERR28' })
    expect(await processReturnFaxDelivery('sd-1', deps)).toEqual({ outcome: 'pending', note: 'ERR28' })
    expect(calls).not.toContain('saveReceipt')
    expect(calls).not.toContain('advance')
  })
  it('the receipt cannot be saved (storage error) → error, the job is NOT moved, no marker (the next run retries the idempotent save)', async () => {
    const { deps, calls, w } = setup({ save: 'throw' })
    const r = await processReturnFaxDelivery('sd-1', deps)
    expect(r).toEqual({ outcome: 'error', error: 'storage down' })
    expect(calls).not.toContain('advance')
    expect(w.markers).toEqual([])
  })
  it('a company with no storage: the job is still filed (the fax WAS delivered) and staff are told to save the receipt by hand', async () => {
    const { deps, log } = setup({ save: { route: 'drive' } })
    expect(await processReturnFaxDelivery('sd-1', deps)).toEqual({ outcome: 'filed', receiptSaved: false })
    expect(log.alerts).toHaveLength(1)
    expect(log.alerts[0]).toContain('no storage')
    expect(log.advanced[0].notes).toContain('NOT saved')
  })
  it('the move is refused → alert, error, NO marker (retried next run); a job another check already filed counts as done', async () => {
    const refused = setup({ advance: { ok: false, error: 'stage not found' } })
    expect(await processReturnFaxDelivery('sd-1', refused.deps)).toEqual({ outcome: 'error', error: 'stage not found' })
    expect(refused.log.alerts[0]).toContain('did not move')
    expect(refused.w.markers).toEqual([])

    const raced = setup({ advance: { ok: false, error: 'already there' }, jobAfter: baseJob({ stage: 'TR Filed' }) })
    expect((await processReturnFaxDelivery('sd-1', raced.deps)).outcome).toBe('filed')
    expect(raced.log.alerts).toEqual([])
    expect(raced.w.markers.map((m) => m.kind)).toEqual([RETURN_FAX_MARKERS.confirmed])
  })
})

describe('failed, waiting, and too long', () => {
  it('failed → ONE marker and ONE alert; nothing moves; the second run adds nothing', async () => {
    const { deps, calls, log, w } = setup({ status: 'failed' })
    expect((await processReturnFaxDelivery('sd-1', deps)).outcome).toBe('failed')
    expect(await processReturnFaxDelivery('sd-1', deps)).toEqual({ outcome: 'failed' })
    expect(log.alerts).toHaveLength(1)
    expect(w.markers.map((m) => m.kind)).toEqual([RETURN_FAX_MARKERS.failed])
    expect(calls).not.toContain('advance')
    expect(calls).not.toContain('saveReceipt')
  })
  it('still waiting → pending, no marker, no alert, nothing moves', async () => {
    for (const status of ['pending', 'unknown'] as const) {
      const { deps, calls, log, w } = setup({ status })
      expect((await processReturnFaxDelivery('sd-1', deps)).outcome).toBe('pending')
      expect(w.markers).toEqual([])
      expect(log.alerts).toEqual([])
      expect(calls).not.toContain('advance')
    }
  })
  it('waiting more than 2 hours → ONE alert and ONE marker, the job stays at "Signed" and is still checked', async () => {
    const { deps, calls, log, w } = setup({ status: 'pending', now: Date.parse(SENT_AT) + 3 * 3_600_000 })
    expect((await processReturnFaxDelivery('sd-1', deps)).outcome).toBe('waiting_too_long')
    expect((await processReturnFaxDelivery('sd-1', deps)).outcome).toBe('waiting_too_long')
    expect(log.alerts).toHaveLength(1)
    expect(w.markers.map((m) => m.kind)).toEqual([RETURN_FAX_MARKERS.stale])
    expect(calls).not.toContain('advance')
    // and when Faxage finally delivers it, the job is filed
    w.status = 'delivered'
    expect((await processReturnFaxDelivery('sd-1', deps)).outcome).toBe('filed')
  })
  it('a RE-SENT fax (new Faxage job id) is judged on its own: the old failure marker does not speak for it', async () => {
    const { deps, w } = setup({ markers: [{ kind: RETURN_FAX_MARKERS.failed, faxJobId: '111' }], fax: { created_at: SENT_AT, details: { job_id: '222', faxno: '8558877737' } } })
    expect((await processReturnFaxDelivery('sd-1', deps)).outcome).toBe('filed')
    expect(w.markers.at(-1)).toEqual({ kind: RETURN_FAX_MARKERS.confirmed, faxJobId: '222' })
  })
})

describe('outside failures never throw and never half-file', () => {
  it('a job that cannot be read / a Faxage error / a missing fax job id → error, nothing moved', async () => {
    const a = setup({ loadError: 'db down' })
    expect(await processReturnFaxDelivery('sd-1', a.deps)).toEqual({ outcome: 'error', error: 'db down' })
    const b = setup({ statusError: 'Faxage login failed' })
    expect(await processReturnFaxDelivery('sd-1', b.deps)).toEqual({ outcome: 'error', error: 'Faxage login failed' })
    expect(b.calls).not.toContain('advance')
    const c = setup({ fax: { created_at: SENT_AT, details: { faxno: '8558877737' } } })
    expect((await processReturnFaxDelivery('sd-1', c.deps)).outcome).toBe('error')
    expect(c.calls).not.toContain('advance')
  })
  it('an exception anywhere is caught and returned as an error', async () => {
    const { deps } = setup()
    deps.faxStatus = async () => { throw new Error('socket hang up') }
    expect(await processReturnFaxDelivery('sd-1', deps)).toEqual({ outcome: 'error', error: 'socket hang up' })
  })
})
