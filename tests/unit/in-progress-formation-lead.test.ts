import { describe, it, expect } from 'vitest'
import { extractOfferTokenFromNotes, resolveFormationOfferId } from '@/lib/portal/queries'

describe('extractOfferTokenFromNotes', () => {
  it('extracts the token from the activate-service auto-created note', () => {
    expect(
      extractOfferTokenFromNotes('Auto-created from offer alessandro-federici-2026'),
    ).toBe('alessandro-federici-2026')
  })

  it('extracts the token from the manual-backfill note (extra trailing text)', () => {
    expect(
      extractOfferTokenFromNotes(
        'Auto-created from offer alessandro-federici-2026 (manual backfill — activation ran before fix)',
      ),
    ).toBe('alessandro-federici-2026')
  })

  it('is case-insensitive on the "from offer" prefix', () => {
    expect(extractOfferTokenFromNotes('From Offer mario-rossi-2026')).toBe('mario-rossi-2026')
  })

  it('returns null when there is no token', () => {
    expect(extractOfferTokenFromNotes('Some unrelated note')).toBeNull()
  })

  it('returns null for null/undefined/empty', () => {
    expect(extractOfferTokenFromNotes(null)).toBeNull()
    expect(extractOfferTokenFromNotes(undefined)).toBeNull()
    expect(extractOfferTokenFromNotes('')).toBeNull()
  })

  it('captures tokens with digits, hyphens and underscores', () => {
    expect(extractOfferTokenFromNotes('created from offer abc_123-xy')).toBe('abc_123-xy')
  })
})

describe('handler-created SD notes do NOT match the offer-notes pattern (dev job ca788354)', () => {
  // The formation_setup handler's notes name the JOB and SUBMISSION — not the
  // offer — so the notes-parsing path must not fire on them. Their lead resolves
  // through source_offer_token instead (made authoritative after Antonio's
  // dashboard card opened the WRONG company's wizard during the 2026-08-11 QA
  // pass: my seeded/handler-shaped SD had no offer-notes, the resolver fell back
  // to "newest formation offer", and that was the OTHER company's).
  it('returns null for the handler note shape rather than a false token', () => {
    expect(
      extractOfferTokenFromNotes(
        'Created by formation_setup job 1fd98839-3187-44e9-962d-088be96463d8 from submission 27fb5ed8-ae7a-4a75-a794-23a3029c0c55.',
      ),
    ).toBeNull()
  })
})

// Workspace-only plan S1 (dev job 9d34e750) — the formation OFFER is the
// preferred anchor (an existing client's new company has no lead any more).
describe('resolveFormationOfferId', () => {
  const map = new Map([['tok-a', 'OFFER-A'], ['tok-b', 'OFFER-B']])

  it('uses the stamped source_offer_token first', () => {
    expect(resolveFormationOfferId('tok-b', 'Auto-created from offer tok-a', map, 2, ['OFFER-A', 'OFFER-B'])).toBe('OFFER-B')
  })

  it('falls back to the token in the notes', () => {
    expect(resolveFormationOfferId(null, 'Auto-created from offer tok-a', map, 2, ['OFFER-A', 'OFFER-B'])).toBe('OFFER-A')
  })

  it('falls back to the sole offer only when there is exactly one SD and one offer', () => {
    expect(resolveFormationOfferId(null, null, new Map(), 1, ['OFFER-A'])).toBe('OFFER-A')
  })

  it('never guesses between several offers or several SDs', () => {
    expect(resolveFormationOfferId(null, null, map, 1, ['OFFER-A', 'OFFER-B'])).toBeNull()
    expect(resolveFormationOfferId(null, null, new Map(), 2, ['OFFER-A'])).toBeNull()
  })

  it('an unknown stamped token does not match', () => {
    expect(resolveFormationOfferId('tok-zzz', null, map, 2, ['OFFER-A', 'OFFER-B'])).toBeNull()
  })
})
