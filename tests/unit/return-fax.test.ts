/**
 * Tax Return plan item 6 (dev job 6f555c9f) — the pure rules of the return fax box (lib/fax/return-fax.ts): who gets the box, which file is faxed,
 * what the box shows, and what a Faxage answer means.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: {} }))

import {
  buildReturnFaxState,
  decideReturnFaxOutcome,
  isEinLineForReturn,
  isReturnFaxLine,
  IRS_RETURN_FAX_NUMBER,
  pickSignedCopy,
  RETURN_FAX_MARKERS,
  RETURN_FAX_STALE_MINUTES,
  returnFaxCover,
  returnFaxReason,
  returnFaxReceiptName,
  usesReturnFaxBox,
  type FaxLogRow,
  type MarkerRow,
  type SignedCopy,
} from '@/lib/fax/return-fax'
import { IRS_EIN_FAX_NUMBERS } from '@/lib/fax/irs-ein-numbers'

const SINGLE = 'Single Member LLC'
const READY: SignedCopy = { kind: 'ready', documentId: 'doc-1', fileName: 'Tax Return 2025 - Acme LLC - Signed.pdf', envelopeId: 'env-1', completedCount: 1 }
const sentRow = (o: Partial<FaxLogRow> = {}): FaxLogRow => ({ id: 'l1', action_type: 'fax_sent', created_at: '2026-11-07T10:00:00Z', details: { job_id: '555', faxno: '8558877737' }, ...o })
const marker = (kind: string, jobId: string | null, extra: Record<string, unknown> = {}): MarkerRow => ({ action_type: kind, created_at: '2026-11-07T10:30:00Z', details: { job_id: jobId ?? undefined, ...extra } })
const state = (o: Partial<Parameters<typeof buildReturnFaxState>[0]> = {}) =>
  buildReturnFaxState({ entityType: SINGLE, signedCopy: READY, latestFax: null, markers: [], ...o })

describe('who gets the fax box', () => {
  it('only a single-member LLC (its signed return is faxed by us)', () => {
    expect(usesReturnFaxBox('Single Member LLC')).toBe(true)
    for (const t of ['Multi Member LLC', 'C-Corp Elected', '', null, undefined, 'single member llc']) expect(usesReturnFaxBox(t as never)).toBe(false)
  })
  it('a multi-member company gets the manual card, even when it has a signed copy and a fax on record', () => {
    expect(state({ entityType: 'Multi Member LLC', latestFax: sentRow() }).mode).toBe('manual')
    expect(state({ entityType: null }).mode).toBe('manual')
  })
})

describe('the IRS return line', () => {
  it('is the number staff used 133 times, and never one of the EIN lines', () => {
    expect(IRS_RETURN_FAX_NUMBER).toBe('8558877737')
    for (const n of IRS_EIN_FAX_NUMBERS) expect(n).not.toBe(IRS_RETURN_FAX_NUMBER)
  })
  it('is recognised however it is typed', () => {
    for (const n of ['8558877737', '855-887-7737', '(855) 887-7737', '+1 855 887 7737', '18558877737', '1-855-887-7737']) expect(isReturnFaxLine(n), n).toBe(true)
  })
  it('never matches another number, an EIN line, or nothing', () => {
    for (const n of ['8556416935', '8552151627', '5551234567', '855887773', '88558877737', '', null, undefined]) expect(isReturnFaxLine(n as never), String(n)).toBe(false)
  })
  it('an EIN (SS-4) line is flagged for a return', () => {
    expect(isEinLineForReturn('855-641-6935')).toBe(true)
    expect(isEinLineForReturn('1 (855) 215-1627')).toBe(true)
    expect(isEinLineForReturn('8558877737')).toBe(false)
  })
})

describe('what a Faxage answer means', () => {
  const sent = '2026-11-07T10:00:00Z'
  const at = (minutes: number) => Date.parse(sent) + minutes * 60_000
  it('delivered and failed are decided at once, whatever the age', () => {
    expect(decideReturnFaxOutcome('delivered', sent, at(1))).toBe('delivered')
    expect(decideReturnFaxOutcome('delivered', sent, at(10_000))).toBe('delivered')
    expect(decideReturnFaxOutcome('failed', sent, at(1))).toBe('failed')
  })
  it('pending (or an answer Faxage did not give) is waiting, until it has waited too long', () => {
    expect(decideReturnFaxOutcome('pending', sent, at(5))).toBe('pending')
    expect(decideReturnFaxOutcome('unknown', sent, at(RETURN_FAX_STALE_MINUTES - 1))).toBe('pending')
    expect(decideReturnFaxOutcome('pending', sent, at(RETURN_FAX_STALE_MINUTES + 1))).toBe('stale')
    expect(decideReturnFaxOutcome('unknown', sent, at(RETURN_FAX_STALE_MINUTES + 1))).toBe('stale')
  })
  it('an unreadable send time never reads as stale', () => {
    expect(decideReturnFaxOutcome('pending', 'not a date', at(10_000))).toBe('pending')
    expect(decideReturnFaxOutcome('pending', null, at(10_000))).toBe('pending')
  })
})

describe('which file is faxed: the signed copy of THIS job', () => {
  const env = (o: Record<string, unknown> = {}) => ({ id: 'env-1', status: 'completed', completed_at: '2026-11-06T22:52:23Z', signed_pdf_drive_id: 'store:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', document_name: 'Tax Return 2025 - Acme', ...o })
  const doc = (o: Record<string, unknown> = {}) => ({ id: 'doc-1', file_name: 'Acme - Signed.pdf', drive_file_id: 'store:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ...o })

  it('no completed e-sign document on the job → none, with the plain reason', () => {
    expect(pickSignedCopy([], [doc()]).kind).toBe('none')
    expect(pickSignedCopy([env({ status: 'sent' }), env({ id: 'e2', status: 'draft' })], [doc()]).kind).toBe('none')
  })
  it('signed but not filed in the storage yet → unfiled', () => {
    expect(pickSignedCopy([env({ signed_pdf_drive_id: null })], []).kind).toBe('unfiled')
  })
  it('filed pointer but no matching documents row → unfiled (never a guess by name)', () => {
    expect(pickSignedCopy([env()], [doc({ drive_file_id: 'store:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' })]).kind).toBe('unfiled')
  })
  it('a copy kept outside the company storage is shown but NOT offered', () => {
    const p = 'storage:signed-documents/esign/x/signed.pdf'
    const r = pickSignedCopy([env({ signed_pdf_drive_id: p })], [doc({ drive_file_id: p })])
    expect(r.kind).toBe('not_faxable')
    if (r.kind === 'not_faxable') expect(r.documentId).toBe('doc-1')
  })
  it('a storage copy is ready; with two completed documents the NEWEST wins and the box says there are more', () => {
    const older = env({ id: 'old', completed_at: '2026-11-01T10:00:00Z', signed_pdf_drive_id: 'store:cccccccc-cccc-4ccc-8ccc-cccccccccccc' })
    const r = pickSignedCopy([older, env()], [doc({ id: 'doc-old', drive_file_id: 'store:cccccccc-cccc-4ccc-8ccc-cccccccccccc' }), doc()])
    expect(r).toMatchObject({ kind: 'ready', documentId: 'doc-1', envelopeId: 'env-1', completedCount: 2 })
  })
})

describe('what the box shows', () => {
  it('no signed copy → no_copy with the reason; nothing to send', () => {
    const s = state({ signedCopy: { kind: 'none', reason: 'No signed copy' } })
    expect(s).toMatchObject({ mode: 'no_copy', reason: 'No signed copy' })
  })
  it('a signed copy and no fax on record → ready', () => {
    expect(state()).toMatchObject({ mode: 'ready', documentId: 'doc-1', moreCopies: false })
    expect(state({ signedCopy: { ...READY, completedCount: 3 } })).toMatchObject({ mode: 'ready', moreCopies: true })
  })
  it('A FAX ON RECORD ALWAYS WINS OVER "READY": the box can never offer a plain Send on a job that was faxed', () => {
    expect(state({ latestFax: sentRow() }).mode).toBe('sent')
    expect(state({ latestFax: sentRow({ action_type: 'fax_claim' }) }).mode).toBe('unconfirmed')
    // even when the signed copy has gone missing
    expect(state({ signedCopy: { kind: 'none', reason: 'gone' }, latestFax: sentRow() }).mode).toBe('sent')
  })
  it('sent: waiting; to the IRS return line it files the job, to another number it does NOT (and the box says so)', () => {
    expect(state({ latestFax: sentRow() })).toMatchObject({ mode: 'sent', faxJobId: '555', toIrsLine: true, waitingTooLong: false, copy: { documentId: 'doc-1' } })
    expect(state({ latestFax: sentRow({ details: { job_id: '556', faxno: '5551234567' } }) })).toMatchObject({ mode: 'sent', toIrsLine: false })
  })
  it('sent for too long → the stale marker of THIS fax turns on the warning', () => {
    expect(state({ latestFax: sentRow(), markers: [marker(RETURN_FAX_MARKERS.stale, '555')] })).toMatchObject({ mode: 'sent', waitingTooLong: true })
  })
  it('a marker of ANOTHER fax job never speaks for this fax', () => {
    expect(state({ latestFax: sentRow(), markers: [marker(RETURN_FAX_MARKERS.failed, '111'), marker(RETURN_FAX_MARKERS.confirmed, '111')] }).mode).toBe('sent')
  })
  it('delivered (confirmed marker) and failed (failed marker, with the signed file to send again)', () => {
    expect(state({ latestFax: sentRow(), markers: [marker(RETURN_FAX_MARKERS.confirmed, '555')] }).mode).toBe('delivered')
    expect(state({ latestFax: sentRow(), markers: [marker(RETURN_FAX_MARKERS.failed, '555', { reason: 'Faxage reported that the fax was not delivered.' })] })).toMatchObject({
      mode: 'failed', reason: 'Faxage reported that the fax was not delivered.', documentId: 'doc-1', fileName: READY.kind === 'ready' ? READY.fileName : '',
    })
    expect(state({ latestFax: sentRow(), signedCopy: { kind: 'none', reason: 'x' }, markers: [marker(RETURN_FAX_MARKERS.failed, '555')] })).toMatchObject({ mode: 'failed', documentId: null })
  })
  it('confirmed beats failed for the same fax (the order the delivery check writes them in can never show red on a filed job)', () => {
    expect(state({ latestFax: sentRow(), markers: [marker(RETURN_FAX_MARKERS.failed, '555'), marker(RETURN_FAX_MARKERS.confirmed, '555')] }).mode).toBe('delivered')
  })
})

describe('the words the box and the filing use', () => {
  it('reason and cover note name the year and the company', () => {
    expect(returnFaxReason('Acme LLC', 2025)).toBe('Tax Return 2025 filing - Acme LLC')
    expect(returnFaxCover('Acme LLC', 2025)).toBe('Signed tax return 2025 for Acme LLC.')
    expect(returnFaxReason('Acme LLC', null)).toBe('Tax Return filing - Acme LLC')
  })
  it('the receipt file name is safe and says what it is', () => {
    expect(returnFaxReceiptName('Acme LLC', 2025)).toBe('Fax Confirmation - Acme LLC - Tax Return 2025.pdf')
    expect(returnFaxReceiptName('A/B: "Co" <LLC>', 2025)).toBe('Fax Confirmation - A B Co LLC - Tax Return 2025.pdf')
    expect(returnFaxReceiptName('', null)).toBe('Fax Confirmation - Company - Tax Return.pdf')
  })
})
