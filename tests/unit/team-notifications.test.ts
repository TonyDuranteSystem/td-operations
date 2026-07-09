import { describe, it, expect } from 'vitest'
import { countTeamNotifications } from '@/lib/team/workspace'

describe('countTeamNotifications', () => {
  it('returns 0 for null/empty', () => {
    expect(countTeamNotifications(null)).toBe(0)
    expect(countTeamNotifications(undefined)).toBe(0)
    expect(countTeamNotifications([])).toBe(0)
  })

  it('counts unread DMs', () => {
    expect(countTeamNotifications([
      { thread_type: 'dm', unread_count: 3, mention_count: 0 },
      { thread_type: 'dm', unread_count: 2, mention_count: 0 },
    ])).toBe(5)
  })

  it('IGNORES ordinary channel/discussion/general unread (the noisy "48")', () => {
    expect(countTeamNotifications([
      { thread_type: 'channel', unread_count: 40, mention_count: 0 },
      { thread_type: 'discussion', unread_count: 6, mention_count: 0 },
      { thread_type: 'general', unread_count: 2, mention_count: 0 },
    ])).toBe(0)
  })

  it('counts @mentions in non-DM threads', () => {
    expect(countTeamNotifications([
      { thread_type: 'channel', unread_count: 40, mention_count: 1 },
      { thread_type: 'discussion', unread_count: 6, mention_count: 2 },
    ])).toBe(3)
  })

  it('adds DM unread + non-DM mentions together', () => {
    expect(countTeamNotifications([
      { thread_type: 'dm', unread_count: 2, mention_count: 0 },
      { thread_type: 'channel', unread_count: 99, mention_count: 1 },
    ])).toBe(3)
  })

  it('for a DM, uses unread_count (not mention_count) so DM @mentions are not double-counted', () => {
    expect(countTeamNotifications([
      { thread_type: 'dm', unread_count: 1, mention_count: 1 },
    ])).toBe(1)
  })

  it('tolerates missing/nullish fields', () => {
    expect(countTeamNotifications([
      { thread_type: 'dm' },
      { thread_type: 'channel' },
      {},
    ])).toBe(0)
  })
})
