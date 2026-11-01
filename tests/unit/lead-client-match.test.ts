import { describe, it, expect } from 'vitest'
import { normalizeEmail, buildClientEmailSet, isLiveClient } from '@/lib/leads/client-match'

describe('client email match', () => {
  const set = buildClientEmailSet([{ email: 'Chris.Ranieri@iCloud.com' }, { email: null }, { email: '  ' }, { email: 'a@b.com' }])
  it('normalizes case and spaces', () => {
    expect(normalizeEmail('  A@B.com ')).toBe('a@b.com')
    expect(normalizeEmail(null)).toBe('')
  })
  it('matches exactly, ignoring case', () => {
    expect(isLiveClient('chris.ranieri@icloud.com', set)).toBe(true)
    expect(isLiveClient('CHRIS.RANIERI@ICLOUD.COM', set)).toBe(true)
  })
  it('does not match a different or partial address', () => {
    expect(isLiveClient('chris.ranieri@icloud.co', set)).toBe(false)
    expect(isLiveClient('ranieri@icloud.com', set)).toBe(false)
  })
  it('never matches a missing or blank email', () => {
    expect(isLiveClient(null, set)).toBe(false)
    expect(isLiveClient('', set)).toBe(false)
    expect(set.size).toBe(2)
  })
})
