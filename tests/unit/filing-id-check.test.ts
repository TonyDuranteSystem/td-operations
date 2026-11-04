/**
 * lib/flows/filing-id-check.ts — the rules of the "check the State Filing ID against the real document" card (job 64d2be64).
 */
import { describe, it, expect } from 'vitest'
import { filingIdCheckResult, confirmLockReason, sameFilingId, resolveFilingIdToSave, unusableClientFilingId, FILING_ID_UNRESOLVED } from '@/lib/flows/filing-id-check'

describe('filingIdCheckResult', () => {
  it('is unresolved until staff make a call', () => {
    expect(filingIdCheckResult({ typed: '2026-002103965', decision: null })).toEqual(FILING_ID_UNRESOLVED)
  })

  it('"The number is correct" resolves with the tidied number', () => {
    expect(filingIdCheckResult({ typed: ' 2026 - 002103965 ', decision: 'confirmed' })).toEqual({ resolved: true, filingId: '2026-002103965' })
    expect(filingIdCheckResult({ typed: 'l26000009149', decision: 'confirmed' })).toEqual({ resolved: true, filingId: 'L26000009149' })
  })

  it('"There is no Filing ID on this document" resolves with nothing to save, whatever is typed', () => {
    expect(filingIdCheckResult({ typed: '3190157', decision: 'none' })).toEqual({ resolved: true, filingId: null })
    expect(filingIdCheckResult({ typed: '', decision: 'none' })).toEqual({ resolved: true, filingId: null })
  })

  it('a confirmed value that is not a plausible ID never resolves', () => {
    expect(filingIdCheckResult({ typed: '', decision: 'confirmed' })).toEqual(FILING_ID_UNRESOLVED)
    expect(filingIdCheckResult({ typed: 'abc', decision: 'confirmed' })).toEqual(FILING_ID_UNRESOLVED)
    expect(filingIdCheckResult({ typed: 'no number here!', decision: 'confirmed' })).toEqual(FILING_ID_UNRESOLVED)
    expect(filingIdCheckResult({ typed: 'ABCDEFG', decision: 'confirmed' })).toEqual(FILING_ID_UNRESOLVED) // letters only: no digit
  })
})

describe('confirmLockReason', () => {
  it('locks until the real document has been opened', () => {
    expect(confirmLockReason({ typed: '3190157', viewed: false, hasDocument: true })).toMatch(/open the real document/i)
  })

  it('once the window is open but nothing has shown yet, says so and points to the new-tab link', () => {
    const reason = confirmLockReason({ typed: '3190157', viewed: false, hasDocument: true, opened: true })
    expect(reason).toMatch(/has not shown yet/i)
    expect(reason).toMatch(/Open in a new tab/)
  })

  it('opens only when the document has really SHOWN — opening the window is not enough', () => {
    expect(confirmLockReason({ typed: '3190157', viewed: false, hasDocument: true, opened: true })).not.toBeNull()
    expect(confirmLockReason({ typed: '3190157', viewed: true, hasDocument: true, opened: true })).toBeNull()
  })

  it('does not ask for a document that does not exist', () => {
    expect(confirmLockReason({ typed: '3190157', viewed: false, hasDocument: false })).toBeNull()
  })

  it('locks an empty number and points to the "no Filing ID" choice', () => {
    expect(confirmLockReason({ typed: '  ', viewed: true, hasDocument: true })).toMatch(/no Filing ID/i)
  })

  it('locks a number that cannot be a Filing ID, and says why', () => {
    expect(confirmLockReason({ typed: 'ab', viewed: true, hasDocument: true })).toMatch(/letters, numbers and dashes/i)
    expect(confirmLockReason({ typed: '12 34 56', viewed: true, hasDocument: true })).toMatch(/letters, numbers and dashes/i)
  })

  it('opens once the document was viewed and the number is plausible', () => {
    expect(confirmLockReason({ typed: '2026-002103965', viewed: true, hasDocument: true })).toBeNull()
  })
})

describe('sameFilingId', () => {
  it('ignores case, spaces around dashes and dash kinds', () => {
    expect(sameFilingId('l26000009149', 'L26000009149')).toBe(true)
    expect(sameFilingId('2026 - 002103965', '2026-002103965')).toBe(true)
    expect(sameFilingId('2026–002103965', '2026-002103965')).toBe(true)
  })

  it('is false for different numbers and for anything missing', () => {
    expect(sameFilingId('3190157', '3190158')).toBe(false)
    expect(sameFilingId('3190157', null)).toBe(false)
    expect(sameFilingId(undefined, '3190157')).toBe(false)
    expect(sameFilingId('', '')).toBe(false)
  })
})

describe('resolveFilingIdToSave (what the onboarding setup saves on the company)', () => {
  it('the number staff checked wins over what the client typed', () => {
    expect(resolveFilingIdToSave({ confirmed_filing_id: '3190157' }, { filing_id: '9999999' })).toBe('3190157')
    expect(resolveFilingIdToSave({ confirmed_filing_id: ' 2026 - 002103965 ' }, {})).toBe('2026-002103965')
  })

  it('"no Filing ID on the document" saves nothing — not even the client\'s number', () => {
    expect(resolveFilingIdToSave({ confirmed_filing_id: null }, { filing_id: '3190157' })).toBeNull()
  })

  it('a job with no checked number (nothing to check) falls back to the number the client typed, tidied', () => {
    expect(resolveFilingIdToSave({}, { filing_id: ' l26000009149 ' })).toBe('L26000009149')
  })

  it('saves nothing when neither exists or the client\'s value is not a plausible ID', () => {
    expect(resolveFilingIdToSave({}, {})).toBeNull()
    expect(resolveFilingIdToSave({}, { filing_id: 'n/a' })).toBeNull()
    expect(resolveFilingIdToSave({}, { filing_id: 12345678 })).toBeNull()
    expect(resolveFilingIdToSave({ confirmed_filing_id: 'n/a' }, { filing_id: '3190157' })).toBeNull()
  })
})

describe('unusableClientFilingId (what the setup job says it dropped)', () => {
  it('returns what the client typed when it cannot be a Filing ID and nothing was checked by staff', () => {
    expect(unusableClientFilingId({}, { filing_id: ' N/A ' })).toBe('N/A')
    expect(unusableClientFilingId({}, { filing_id: 'pending' })).toBe('pending')
    expect(unusableClientFilingId({}, { filing_id: 'x'.repeat(100) })).toHaveLength(60)
  })

  it('is null when the value is usable, empty, missing or not text', () => {
    expect(unusableClientFilingId({}, { filing_id: '3190157' })).toBeNull()
    expect(unusableClientFilingId({}, { filing_id: '   ' })).toBeNull()
    expect(unusableClientFilingId({}, {})).toBeNull()
    expect(unusableClientFilingId({}, { filing_id: 12345 })).toBeNull()
  })

  it('is null whenever staff made a call (a checked number or "none") — the client\'s value is not used then', () => {
    expect(unusableClientFilingId({ confirmed_filing_id: '3190157' }, { filing_id: 'N/A' })).toBeNull()
    expect(unusableClientFilingId({ confirmed_filing_id: null }, { filing_id: 'N/A' })).toBeNull()
  })
})
