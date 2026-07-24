import { describe, it, expect } from 'vitest'
import { countTeamNotifications, buildTeamNotifications } from '@/lib/team/workspace'

/**
 * ⚠️ RULE CHANGE 2026-07-24 — a CHANNEL now contributes its unread_count.
 *
 * These cases used `thread_type: 'channel'` as a convenient stand-in for "a
 * non-DM thread whose unread must be ignored". That is no longer what a channel
 * means: get_team_threads counts a channel's unread at THREAD grain ("how many
 * bugs have something new"), and Antonio must see every one of them. The
 * mention-only cases therefore moved to 'general', which really is still
 * mention-only — and that is not a cosmetic swap: general holds 48 old
 * top-level messages with no per-thread read rows, so counting its unread would
 * bring back the permanently-stuck badge these tests were written to prevent.
 * Channel behaviour is asserted directly below and in team-channel-notify.test.ts.
 */

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

  it('IGNORES general unread and a discussion you never touched (the noisy "48")', () => {
    expect(countTeamNotifications([
      { thread_type: 'discussion', unread_count: 6, mention_count: 0 },
      { thread_type: 'general', unread_count: 2, mention_count: 0 },
    ])).toBe(0)
  })

  it('COUNTS a channel unread — it is bugs-with-something-new, not chatter (2026-07-24)', () => {
    expect(countTeamNotifications([
      { thread_type: 'channel', unread_count: 3, mention_count: 0 },
    ])).toBe(3)
  })

  it('counts @mentions in non-DM threads', () => {
    expect(countTeamNotifications([
      { thread_type: 'general', unread_count: 40, mention_count: 1 },
      { thread_type: 'discussion', unread_count: 6, mention_count: 2 },
    ])).toBe(3)
  })

  it('adds DM unread + non-DM mentions together', () => {
    expect(countTeamNotifications([
      { thread_type: 'dm', unread_count: 2, mention_count: 0 },
      { thread_type: 'general', unread_count: 99, mention_count: 1 },
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

  it('counts unread in a conversation you ARE a participant of', () => {
    expect(countTeamNotifications([
      { thread_type: 'discussion', unread_count: 4, mention_count: 0, is_participant: true },
    ])).toBe(4)
  })

  it('still IGNORES unread in a conversation you are NOT a participant of', () => {
    expect(countTeamNotifications([
      { thread_type: 'discussion', unread_count: 9, mention_count: 0, is_participant: false },
    ])).toBe(0)
  })

  it('a participant conversation uses unread (mentions already included, no double count)', () => {
    expect(countTeamNotifications([
      { thread_type: 'discussion', unread_count: 3, mention_count: 1, is_participant: true },
    ])).toBe(3)
  })

  it('a non-participant conversation still counts an @mention', () => {
    expect(countTeamNotifications([
      { thread_type: 'discussion', unread_count: 9, mention_count: 2, is_participant: false },
    ])).toBe(2)
  })
})

describe('buildTeamNotifications', () => {
  const me = 'me-123'
  const nameFor = (id: string) => ({ 'luca-1': 'Luca', 'anna-2': 'Anna' }[id])

  it('labels a DM with the OTHER person and deep-links it', () => {
    const out = buildTeamNotifications([
      { id: 't1', thread_type: 'dm', dm_key: 'luca-1:me-123', unread_count: 2, mention_count: 0 },
    ], me, nameFor)
    expect(out).toEqual([
      { id: 't1', kind: 'dm', label: 'Luca', count: 2, url: '/team-chat?thread=t1' },
    ])
  })

  it('labels a mention with its room label', () => {
    const out = buildTeamNotifications([
      { id: 't2', thread_type: 'general', label: 'general', unread_count: 40, mention_count: 1 },
    ], me, nameFor)
    expect(out).toEqual([
      { id: 't2', kind: 'mention', label: 'general', count: 1, url: '/team-chat?thread=t2' },
    ])
  })

  it('excludes read DMs and unmentioned general chatter', () => {
    const out = buildTeamNotifications([
      { id: 'a', thread_type: 'dm', dm_key: 'luca-1:me-123', unread_count: 0, mention_count: 0 },
      { id: 'b', thread_type: 'general', label: 'general', unread_count: 99, mention_count: 0 },
    ], me, nameFor)
    expect(out).toEqual([])
  })

  it('LISTS a channel with unread bugs, even with no @mention (2026-07-24)', () => {
    const out = buildTeamNotifications([
      { id: 'b', thread_type: 'channel', label: 'td-bug', unread_count: 2, mention_count: 0 },
    ], me, nameFor)
    expect(out).toEqual([
      { id: 'b', kind: 'channel', label: '#td-bug', count: 2, url: '/team-chat?thread=b' },
    ])
  })

  it('lists a participant conversation, but not one you have not touched', () => {
    const out = buildTeamNotifications([
      { id: 'c1', thread_type: 'discussion', label: 'Acme LLC', unread_count: 2, mention_count: 0, is_participant: true },
      { id: 'c2', thread_type: 'discussion', label: 'Other LLC', unread_count: 5, mention_count: 0, is_participant: false },
    ], me, nameFor)
    expect(out).toEqual([
      { id: 'c1', kind: 'conversation', label: 'Acme LLC', count: 2, url: '/team-chat?thread=c1' },
    ])
  })

  it('orders DMs, then conversations, then mentions', () => {
    const out = buildTeamNotifications([
      { id: 'x', thread_type: 'general', label: 'general', unread_count: 0, mention_count: 1 },
      { id: 'y', thread_type: 'discussion', label: 'Acme LLC', unread_count: 1, mention_count: 0, is_participant: true },
      { id: 'z', thread_type: 'dm', dm_key: 'luca-1:me-123', unread_count: 1, mention_count: 0 },
    ], me, nameFor)
    expect(out.map(i => i.kind)).toEqual(['dm', 'conversation', 'mention'])
  })

  it('orders DMs before mentions, then by count', () => {
    const out = buildTeamNotifications([
      { id: 'm1', thread_type: 'general', label: 'general', unread_count: 0, mention_count: 3 },
      { id: 'd1', thread_type: 'dm', dm_key: 'luca-1:me-123', unread_count: 1, mention_count: 0 },
      { id: 'd2', thread_type: 'dm', dm_key: 'anna-2:me-123', unread_count: 5, mention_count: 0 },
    ], me, nameFor)
    expect(out.map(o => o.id)).toEqual(['d2', 'd1', 'm1'])
  })

  it('falls back to a generic label when the other user is unknown', () => {
    const out = buildTeamNotifications([
      { id: 't', thread_type: 'dm', dm_key: 'ghost-9:me-123', unread_count: 1 },
    ], me, nameFor)
    expect(out[0].label).toBe('Direct message')
  })
})
