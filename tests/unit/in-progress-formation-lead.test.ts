import { describe, it, expect } from 'vitest'
import { extractOfferTokenFromNotes } from '@/lib/portal/queries'

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
