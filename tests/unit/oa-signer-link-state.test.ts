import { describe, it, expect } from 'vitest'
import { signerLinkState } from '@/lib/oa/public-view'

const NOW = 1_700_000_000_000
const past = new Date(NOW - 1000).toISOString()
const future = new Date(NOW + 60_000).toISOString()

describe('signerLinkState', () => {
  it('a fresh unsigned row with a future expiry is ok', () => {
    expect(signerLinkState({ status: 'pending', link_expires_at: future }, NOW)).toBe('ok')
  })

  it('a row with no expiry and no revocation is ok (never-emailed / legacy)', () => {
    expect(signerLinkState({ status: 'pending' }, NOW)).toBe('ok')
    expect(signerLinkState({ status: 'viewed', link_expires_at: null, revoked_at: null }, NOW)).toBe('ok')
  })

  it('a revoked row is revoked', () => {
    expect(signerLinkState({ status: 'pending', revoked_at: past }, NOW)).toBe('revoked')
  })

  it('an expired unsigned row is expired', () => {
    expect(signerLinkState({ status: 'viewed', link_expires_at: past }, NOW)).toBe('expired')
  })

  it('revocation wins over expiry (stronger, deliberate kill)', () => {
    expect(signerLinkState({ status: 'pending', revoked_at: past, link_expires_at: past }, NOW)).toBe('revoked')
  })

  it('a SIGNED row is ALWAYS ok — expiry/revocation never un-sign', () => {
    expect(signerLinkState({ status: 'signed', link_expires_at: past }, NOW)).toBe('ok')
    expect(signerLinkState({ status: 'signed', revoked_at: past }, NOW)).toBe('ok')
    expect(signerLinkState({ status: 'signed', revoked_at: past, link_expires_at: past }, NOW)).toBe('ok')
  })

  it('expiry boundary is inclusive (== now counts as expired)', () => {
    const exactly = new Date(NOW).toISOString()
    expect(signerLinkState({ status: 'pending', link_expires_at: exactly }, NOW)).toBe('expired')
  })
})
