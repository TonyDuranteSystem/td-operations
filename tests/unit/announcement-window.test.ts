import { describe, it, expect } from 'vitest'
import { easternDateString, isAnnouncementLive } from '@/lib/portal/announcement-window'

// The client home page now honours an announcement's start and end dates (dev job 056a70d0).

describe('isAnnouncementLive', () => {
  it('is live when it has no dates at all', () => {
    expect(isAnnouncementLive({}, '2026-11-12')).toBe(true)
    expect(isAnnouncementLive({ active_from: null, active_until: null }, '2026-11-12')).toBe(true)
  })

  it('is not live before its start day, and is live on the start day', () => {
    expect(isAnnouncementLive({ active_from: '2026-11-13' }, '2026-11-12')).toBe(false)
    expect(isAnnouncementLive({ active_from: '2026-11-12' }, '2026-11-12')).toBe(true)
  })

  it('stays live through its whole end day and is gone the day after', () => {
    expect(isAnnouncementLive({ active_until: '2026-11-12' }, '2026-11-12')).toBe(true)
    expect(isAnnouncementLive({ active_until: '2026-11-11' }, '2026-11-12')).toBe(false)
  })

  it('needs both ends to agree when both are set', () => {
    const w = { active_from: '2026-11-10', active_until: '2026-11-14' }
    expect(isAnnouncementLive(w, '2026-11-09')).toBe(false)
    expect(isAnnouncementLive(w, '2026-11-12')).toBe(true)
    expect(isAnnouncementLive(w, '2026-11-15')).toBe(false)
  })

  it('reads a full timestamp as just its day', () => {
    expect(isAnnouncementLive({ active_until: '2026-11-12T00:00:00+00:00' }, '2026-11-12')).toBe(true)
  })
})

describe('easternDateString', () => {
  it('uses the New York day, not the UTC day, in the evening', () => {
    // 9 pm New York on 12 Nov (winter, UTC-5) is already 13 Nov 02:00 UTC.
    expect(easternDateString(new Date('2026-11-13T02:00:00Z'))).toBe('2026-11-12')
  })

  it('moves to the next day after midnight New York', () => {
    expect(easternDateString(new Date('2026-11-13T05:30:00Z'))).toBe('2026-11-13')
  })

  it('handles summer time too', () => {
    expect(easternDateString(new Date('2026-07-01T03:30:00Z'))).toBe('2026-06-30')
  })
})
