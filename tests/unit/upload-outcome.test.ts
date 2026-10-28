/**
 * What a workspace upload shows staff: green "done" only when everything finished; AMBER when the file is saved but the follow-on step did not
 * (dev job e3215801 — the ITIN letter saved but the case not closed / the client not told must never look like a success).
 */
import { describe, it, expect } from 'vitest'
import { uploadOutcome, clientWasTold } from '@/lib/flows/upload-outcome'

const opts = { fileName: 'letter.pdf', needsFormationDate: false }

describe('uploadOutcome', () => {
  it('a clean upload -> green with the server summary, no warning', () => {
    expect(uploadOutcome({ detail: 'letter.pdf uploaded — ITIN 912-70-1234 saved…' }, opts)).toEqual({ warn: null, done: 'letter.pdf uploaded — ITIN 912-70-1234 saved…' })
  })
  it('no server summary -> the plain "<name> uploaded"', () => {
    expect(uploadOutcome({}, opts)).toEqual({ warn: null, done: 'letter.pdf uploaded' })
  })
  it('ITIN letter saved but finalize did not finish -> AMBER, never green', () => {
    const r = uploadOutcome({ detail: 'x', itin_finalize: { warnings: ['OCR ran but found no ITIN number.'] } }, opts)
    expect(r.done).toBeNull()
    expect(r.warn).toBe('letter.pdf uploaded, but: OCR ran but found no ITIN number.')
  })
  it('the portal message to the client not posted is a finalize warning too -> AMBER', () => {
    const r = uploadOutcome({ itin_finalize: { warnings: ['The portal message to the client was NOT posted (failed: boom) — tell them in the portal chat.'] } }, opts)
    expect(r.done).toBeNull()
    expect(r.warn).toContain('NOT posted')
  })
  it('several finalize warnings are all shown', () => {
    const r = uploadOutcome({ itin_finalize: { warnings: ['one.', 'two.'] } }, opts)
    expect(r.warn).toBe('letter.pdf uploaded, but: one. two.')
  })
  it('an empty / junk warnings list is not a warning', () => {
    expect(uploadOutcome({ itin_finalize: { warnings: [] } }, opts).warn).toBeNull()
    expect(uploadOutcome({ itin_finalize: { warnings: ['', 5, null] } }, opts).done).toBe('letter.pdf uploaded')
    expect(uploadOutcome({ itin_finalize: null }, opts).done).toBe('letter.pdf uploaded')
  })
  it('Formation Articles: company record not created -> AMBER', () => {
    const r = uploadOutcome({ advance: { materialization: { error: 'no state' } } }, opts)
    expect(r).toEqual({ warn: 'letter.pdf uploaded, but the company record was NOT created: no state', done: null })
  })
  it('Formation Articles: flow refused to advance -> AMBER only for the Articles step', () => {
    const adv = { success: false, error: 'blocked' }
    expect(uploadOutcome({ advance: adv }, { ...opts, needsFormationDate: true })).toEqual({ warn: 'letter.pdf uploaded, but the flow did not advance: blocked', done: null })
    expect(uploadOutcome({ advance: adv, detail: 'ok' }, opts)).toEqual({ warn: null, done: 'ok' })
  })
  it('State Annual Report: the principal-address warning is shown (and the upload still counts as done, as before)', () => {
    const r = uploadOutcome({ detail: 'ok', principal_office_warning: 'Address answer needs a look.' }, opts)
    expect(r).toEqual({ warn: 'Address answer needs a look.', done: 'ok' })
  })
})

describe('uploadOutcome — the good news stays visible', () => {
  it('the ITIN was saved and the case closed but the client message failed -> amber says so (staff must not re-upload)', () => {
    const r = uploadOutcome({ itin_finalize: { finalized: true, warnings: ['The portal message to the client was NOT posted (failed: boom) — tell them in the portal chat.'] } }, opts)
    expect(r.done).toBeNull()
    expect(r.warn).toBe('letter.pdf uploaded, the ITIN was saved and the case closed, but: The portal message to the client was NOT posted (failed: boom) — tell them in the portal chat.')
  })
  it('finalize did NOT finish -> no claim that anything was saved or closed', () => {
    const r = uploadOutcome({ itin_finalize: { finalized: false, warnings: ['OCR failed.'] } }, opts)
    expect(r.warn).toBe('letter.pdf uploaded, but: OCR failed.')
    expect(r.warn).not.toContain('case closed')
  })
})

describe('clientWasTold — did the portal message to the client really go out?', () => {
  it("'ok' -> yes", () => expect(clientWasTold({ chat: 'ok' })).toBe(true))
  it('an identical message was sent moments ago (duplicate guard) -> yes, the client has it', () => {
    expect(clientWasTold({ chat: 'skipped: duplicate within dedup window' })).toBe(true)
  })
  it('failed / any other skip / no result at all -> NOT confirmed', () => {
    expect(clientWasTold({ chat: 'failed: boom' })).toBe(false)
    expect(clientWasTold({ chat: 'skipped: no recipient (contact_id or account_id required)' })).toBe(false)
    expect(clientWasTold({ chat: 'skipped: not attempted' })).toBe(false)
    expect(clientWasTold({})).toBe(false)
    expect(clientWasTold(null)).toBe(false)
    expect(clientWasTold(undefined)).toBe(false)
  })
})

