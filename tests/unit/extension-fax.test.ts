/**
 * Tax Return plan item 7 (dev job 6f555c9f) — file the EXTENSION from the workspace: the pure rules (who gets the box, what it shows, the names of
 * the files, the client's message, the number it is pre-filled with). The delivery check is in extension-fax-delivery.test.ts, the form in
 * form-7004-fill.test.ts, the wiring in tax-return-extension-fax-wiring.test.ts.
 */
import { describe, it, expect } from 'vitest'
import {
  buildExtensionFaxState,
  DEFAULT_EXTENSION_FAX_NUMBER,
  EXTENSION_FAX_MARKERS,
  EXTENSION_FAX_PURPOSE,
  extensionFaxCover,
  extensionFaxReason,
  extensionFiledMessage,
  extensionReceiptName,
  isExtensionFaxDetails,
  lastDeliveredNumber,
  longDate,
  mergedDocumentName,
  pickWorkingCopy,
  prefillAddress,
  usesExtensionFaxBox,
  workingCopyName,
  WORKING_COPY_PREFIX,
} from '@/lib/fax/extension-fax'
import { IRS_RETURN_FAX_NUMBER } from '@/lib/fax/return-fax'

const COPY = { documentId: 'doc-1', fileName: `${WORKING_COPY_PREFIX} - Acme LLC - Tax Return 2025.pdf` }
const fax = (over: Record<string, unknown> = {}) => ({ id: 'a1', action_type: 'fax_sent', created_at: '2026-11-09T10:00:00Z', details: { job_id: 'F1', faxno: '8558877737' }, ...over }) as never

describe('who gets the box', () => {
  it('single-member LLCs only: the other companies keep the plain upload box until it is decided', () => {
    expect(usesExtensionFaxBox('Single Member LLC')).toBe(true)
    expect(usesExtensionFaxBox('Multi Member LLC')).toBe(false)
    expect(usesExtensionFaxBox('C-Corp')).toBe(false)
    expect(usesExtensionFaxBox(null)).toBe(false)
    expect(usesExtensionFaxBox('')).toBe(false)
  })
})

describe('the purpose tag', () => {
  it('only a fax carrying exactly the extension purpose is an extension fax', () => {
    expect(isExtensionFaxDetails({ purpose: EXTENSION_FAX_PURPOSE })).toBe(true)
    expect(isExtensionFaxDetails({ purpose: 'something_else' })).toBe(false)
    expect(isExtensionFaxDetails({})).toBe(false)
    expect(isExtensionFaxDetails(null)).toBe(false)
  })
  it('the suggested number is the one the IRS names for these filers — the same line the signed returns use today', () => {
    expect(DEFAULT_EXTENSION_FAX_NUMBER).toBe('8558877737')
    expect(DEFAULT_EXTENSION_FAX_NUMBER).toBe(IRS_RETURN_FAX_NUMBER)
  })
})

describe('what the box shows', () => {
  it('a company that is not a single-member LLC → manual (the plain upload box), whatever else is on record', () => {
    expect(buildExtensionFaxState({ entityType: 'Multi Member LLC', workingCopy: COPY, latestFax: fax(), markers: [] })).toEqual({ mode: 'manual' })
  })
  it('nothing generated → generate; a generated 7004 and no fax → ready with that file', () => {
    expect(buildExtensionFaxState({ entityType: 'Single Member LLC', workingCopy: null, latestFax: null, markers: [] })).toEqual({ mode: 'generate' })
    expect(buildExtensionFaxState({ entityType: 'Single Member LLC', workingCopy: COPY, latestFax: null, markers: [] })).toEqual({ mode: 'ready', documentId: 'doc-1', fileName: COPY.fileName })
  })
  it('a fax already on record ALWAYS wins over "ready": the box never offers a plain Send on a job that was faxed', () => {
    const s = buildExtensionFaxState({ entityType: 'Single Member LLC', workingCopy: COPY, latestFax: fax(), markers: [] })
    expect(s.mode).toBe('sent')
    expect(s).toMatchObject({ faxJobId: 'F1', faxno: '8558877737', waitingTooLong: false, copy: COPY })
  })
  it('a send that was never confirmed (a claim) → unconfirmed: blocked until someone has looked in Fax History', () => {
    expect(buildExtensionFaxState({ entityType: 'Single Member LLC', workingCopy: COPY, latestFax: fax({ action_type: 'fax_claim' }), markers: [] })).toMatchObject({ mode: 'unconfirmed' })
  })
  it('the markers of THIS fax decide: confirmed → delivered, failed → failed (re-send offered with the same copy), stale → still sent but waiting too long', () => {
    const m = (kind: string, jobId = 'F1', details: Record<string, unknown> = {}) => ({ action_type: kind, created_at: '2026-11-09T12:00:00Z', details: { job_id: jobId, ...details } })
    expect(buildExtensionFaxState({ entityType: 'Single Member LLC', workingCopy: COPY, latestFax: fax(), markers: [m(EXTENSION_FAX_MARKERS.confirmed)] })).toMatchObject({ mode: 'delivered', faxJobId: 'F1' })
    expect(buildExtensionFaxState({ entityType: 'Single Member LLC', workingCopy: COPY, latestFax: fax(), markers: [m(EXTENSION_FAX_MARKERS.failed, 'F1', { reason: 'no answer' })] })).toMatchObject({ mode: 'failed', reason: 'no answer', copy: COPY })
    expect(buildExtensionFaxState({ entityType: 'Single Member LLC', workingCopy: COPY, latestFax: fax(), markers: [m(EXTENSION_FAX_MARKERS.stale)] })).toMatchObject({ mode: 'sent', waitingTooLong: true })
  })
  it('a marker of ANOTHER fax of the same job never decides this one', () => {
    const other = { action_type: EXTENSION_FAX_MARKERS.confirmed, created_at: '2026-11-08T12:00:00Z', details: { job_id: 'OLD' } }
    expect(buildExtensionFaxState({ entityType: 'Single Member LLC', workingCopy: COPY, latestFax: fax(), markers: [other] }).mode).toBe('sent')
  })
})

describe('the number the box is pre-filled with', () => {
  it('the last number an extension fax was DELIVERED to (newest first), else the IRS number', () => {
    expect(lastDeliveredNumber([])).toBe('8558877737')
    expect(lastDeliveredNumber([{ details: { faxno: '1 (800) 555-0199' } }, { details: { faxno: '8558877737' } }])).toBe('8005550199')
  })
  it('a missing or unusable number is skipped, never pre-filled', () => {
    expect(lastDeliveredNumber([{ details: null }, { details: { faxno: 'abc' } }, { details: { faxno: '8001112222' } }])).toBe('8001112222')
    expect(lastDeliveredNumber([{ details: { faxno: '123' } }])).toBe(DEFAULT_EXTENSION_FAX_NUMBER)
  })
})

describe('the working copy', () => {
  it('is the newest document whose name starts with the working-copy prefix; anything else is ignored', () => {
    const docs = [
      { id: 'merged', file_name: 'Form 7004 + IRS fax receipt - Acme LLC - Tax Return 2025.pdf', drive_file_id: 'store:1', created_at: '2026-11-09T09:00:00Z' },
      { id: 'old', file_name: `${WORKING_COPY_PREFIX} - Acme LLC - Tax Return 2025.pdf`, drive_file_id: 'store:2', created_at: '2026-11-08T09:00:00Z' },
      { id: 'new', file_name: `${WORKING_COPY_PREFIX} - Acme LLC - Tax Return 2025.pdf`, drive_file_id: 'store:3', created_at: '2026-11-09T08:00:00Z' },
      { id: 'nofile', file_name: `${WORKING_COPY_PREFIX} - x.pdf`, drive_file_id: null, created_at: '2026-11-09T10:00:00Z' },
    ]
    expect(pickWorkingCopy(docs)).toEqual({ documentId: 'new', fileName: `${WORKING_COPY_PREFIX} - Acme LLC - Tax Return 2025.pdf` })
    expect(pickWorkingCopy([])).toBeNull()
  })
})

describe('names', () => {
  it('the three files of one extension carry the company and the tax year, and cannot be mistaken for each other', () => {
    expect(workingCopyName('Acme LLC', 2025)).toBe('Form 7004 (as faxed) - Acme LLC - Tax Return 2025.pdf')
    expect(mergedDocumentName('Acme LLC', 2025)).toBe('Form 7004 + IRS fax receipt - Acme LLC - Tax Return 2025.pdf')
    expect(extensionReceiptName('Acme LLC', 2025)).toBe('IRS fax receipt (Form 7004) - Acme LLC - Tax Return 2025.pdf')
    // the receipt kept by itself never collides with the return fax's "Fax Confirmation - … - Tax Return 2025.pdf"
    expect(extensionReceiptName('Acme LLC', 2025)).not.toMatch(/^Fax Confirmation/)
  })
  it('characters a file name cannot hold are removed; no year is fine', () => {
    expect(workingCopyName('A/B: "C" LLC', null)).toBe('Form 7004 (as faxed) - A B C LLC - Tax Return.pdf')
    expect(mergedDocumentName('', 2025)).toBe('Form 7004 + IRS fax receipt - Company - Tax Return 2025.pdf')
  })
  it('the history reason and the internal cover note name the company and the year', () => {
    expect(extensionFaxReason('Acme LLC', 2025)).toBe('Form 7004 extension 2025 - Acme LLC')
    expect(extensionFaxCover('Acme LLC', 2025)).toContain('2025')
    expect(extensionFaxCover('Acme LLC', 2025)).toContain('Acme LLC')
  })
})

describe('the client\'s message', () => {
  it('says the extension was filed, gives the new deadline and points to the document — in English', () => {
    const m = extensionFiledMessage({ italian: false, year: 2025, deadlineIso: '2026-10-15', withDocument: true })
    expect(m).toContain('filed the extension')
    expect(m).toContain('2025')
    expect(m).toContain('October 15, 2026')
    expect(m).toContain('Documents')
  })
  it('… and in Italian (the client\'s language)', () => {
    const m = extensionFiledMessage({ italian: true, year: 2025, deadlineIso: '2026-10-15', withDocument: true })
    expect(m).toContain('proroga')
    expect(m).toContain('15 ottobre 2026')
    expect(m).toContain('Documenti')
  })
  it('does not point to a document that was not saved, and leaves out a deadline it does not know', () => {
    const m = extensionFiledMessage({ italian: false, year: null, deadlineIso: null, withDocument: false })
    expect(m).not.toContain('Documents')
    expect(m).not.toContain('deadline')
    expect(m).toBe('Good news: we have filed the extension for your tax return.')
  })
  it('long dates read naturally and an unreadable date comes back untouched', () => {
    expect(longDate('2026-10-15', false)).toBe('October 15, 2026')
    expect(longDate('2027-03-01', true)).toBe('1 marzo 2027')
    expect(longDate('soon', false)).toBe('soon')
    expect(longDate('2026-13-01', false)).toBe('2026-13-01')
  })
})

describe('what the form is pre-filled with', () => {
  it('the company\'s saved mailing address wins', () => {
    expect(prefillAddress({ address_line1: ' 1 Main St ', address_line2: 'Suite 5', city: 'Austin', state: 'TX', zip: '78701' }, '3D-318'))
      .toEqual({ street: '1 Main St', suite: 'Suite 5', city: 'Austin', state: 'TX', zip: '78701' })
  })
  it('else the TD mailing address built from the company\'s suite number (the box number is part of the street)', () => {
    const a = prefillAddress(null, '3D-318')
    expect(a.street).toBe('10225 Ulmerton Rd 3D PMB 318')
    expect(a).toMatchObject({ city: 'Largo', state: 'FL', zip: '33771', suite: '' })
  })
  it('a company with neither gets an empty form for staff to fill — never a guessed address', () => {
    expect(prefillAddress(null, null)).toEqual({ street: '', suite: '', city: '', state: '', zip: '' })
    expect(prefillAddress({ address_line1: '  ' }, undefined)).toEqual({ street: '', suite: '', city: '', state: '', zip: '' })
  })
})
