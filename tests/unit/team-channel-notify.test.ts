import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { channelNotifiesStaff, conversationNotifiesParticipants, SILENT_CHANNEL_SLUGS } from '@/lib/team/channel-notify'
import { countTeamNotifications, buildTeamNotifications, type TeamThreadCountRow, type TeamNotifThreadRow } from '@/lib/team/workspace'
import { validateTeamPostTarget } from '@/lib/team/post-message-validate'

/**
 * Antonio 2026-07-24 — td-bug: every post in a work channel must reach the other
 * person, the channel badge must count BUGS (not messages) so opening the
 * channel cannot wipe it, and Claude must be able to answer inside a bug.
 *
 * The predicate below is load-bearing in TWO places that must agree: the send
 * routes (who gets pushed) and the in-CRM toast listener (what pops up). A test
 * that only covered one of them would let them drift.
 */
describe('channelNotifiesStaff', () => {
  it('notifies for the work channels', () => {
    for (const slug of ['td-bug', 'td-dev', 'td-taxreturn', 'td-support', 'general']) {
      expect(channelNotifiesStaff(slug)).toBe(true)
    }
  })

  it('stays silent for the machine-written worker bug channel', () => {
    expect(channelNotifiesStaff('td-worker-bug')).toBe(false)
    expect(SILENT_CHANNEL_SLUGS).toContain('td-worker-bug')
  })

  it('matches case-insensitively and tolerates padding (callers may hold a display name)', () => {
    expect(channelNotifiesStaff('TD-Worker-Bug')).toBe(false)
    expect(channelNotifiesStaff('  td-worker-bug  ')).toBe(false)
  })

  it('treats a missing slug as the general room, which notifies', () => {
    expect(channelNotifiesStaff(null)).toBe(true)
    expect(channelNotifiesStaff(undefined)).toBe(true)
    expect(channelNotifiesStaff('')).toBe(true)
  })
})

describe('countTeamNotifications — a channel now counts', () => {
  const rows = (r: Partial<TeamThreadCountRow>[]) => r as TeamThreadCountRow[]

  it('counts a channel unread (bugs with something new) — the whole point of the change', () => {
    expect(countTeamNotifications(rows([
      { thread_type: 'channel', unread_count: 3, mention_count: 0 },
    ]))).toBe(3)
  })

  it('still counts DMs and participant conversations', () => {
    expect(countTeamNotifications(rows([
      { thread_type: 'dm', unread_count: 2 },
      { thread_type: 'discussion', unread_count: 4, is_participant: true },
      { thread_type: 'discussion', unread_count: 9, is_participant: false, mention_count: 0 },
    ]))).toBe(6)
  })

  it('leaves GENERAL on mentions only — its unread is a raw message count nothing can clear', () => {
    // 48 old top-level messages, no replies, no per-thread read rows. Counting
    // that number would resurrect the stuck badge the signal was cleaned up to
    // remove. Regression guard: this must NOT become 48.
    expect(countTeamNotifications(rows([
      { thread_type: 'general', unread_count: 48, mention_count: 0 },
    ]))).toBe(0)
    expect(countTeamNotifications(rows([
      { thread_type: 'general', unread_count: 48, mention_count: 1 },
    ]))).toBe(1)
  })
})

describe('buildTeamNotifications — channel rows', () => {
  const nameFor = () => 'Luca'

  it('lists a channel with unread bugs, hash-prefixed and deep-linked', () => {
    const items = buildTeamNotifications(
      [{ id: 'c1', thread_type: 'channel', unread_count: 2, label: 'td-bug' }] as TeamNotifThreadRow[],
      'me', nameFor,
    )
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'channel', label: '#td-bug', count: 2, url: '/team-chat?thread=c1' })
  })

  it('omits a channel with nothing new', () => {
    const items = buildTeamNotifications(
      [{ id: 'c1', thread_type: 'channel', unread_count: 0, label: 'td-bug' }] as TeamNotifThreadRow[],
      'me', nameFor,
    )
    expect(items).toHaveLength(0)
  })

  it('orders DMs before conversations before channels', () => {
    const items = buildTeamNotifications([
      { id: 'c1', thread_type: 'channel', unread_count: 5, label: 'td-bug' },
      { id: 'd1', thread_type: 'dm', unread_count: 1, dm_key: 'me:other' },
      { id: 's1', thread_type: 'discussion', unread_count: 1, is_participant: true, label: 'Acme' },
    ] as TeamNotifThreadRow[], 'me', nameFor)
    expect(items.map(i => i.kind)).toEqual(['dm', 'conversation', 'channel'])
  })
})

describe('validateTeamPostTarget — answering inside a bug', () => {
  it('accepts a channel + root_id (the "answer inside this bug" call)', () => {
    expect(validateTeamPostTarget({ channel: 'td-bug', root_id: 'r1' })).toBeNull()
  })

  it('refuses root_id on a DM — a direct message has no threads inside it', () => {
    const err = validateTeamPostTarget({ dm_user_id: 'u1', root_id: 'r1' })
    expect(err).toMatch(/direct message has no threads/i)
  })

  it('ignores a blank root_id rather than refusing a valid DM', () => {
    expect(validateTeamPostTarget({ dm_user_id: 'u1', root_id: '   ' })).toBeNull()
  })

  it('still requires exactly one target', () => {
    expect(validateTeamPostTarget({ root_id: 'r1' })).toMatch(/target is required/i)
    expect(validateTeamPostTarget({ channel: 'td-bug', thread_id: 't1' })).toMatch(/exactly ONE/i)
  })
})

/**
 * Antonio 2026-08-04 — td-bug: "every time Luca do something on his pc I receive
 * the notification. i want to turn them off." A client conversation toasted on
 * his screen AND pushed his phone for every message Luca typed into it and every
 * answer the worker wrote back, because merely OPENING a conversation once marks
 * you a participant of it for ever.
 *
 * Three sites could notify for a conversation — a person posting, Claude
 * posting, and the in-CRM toast listener. All three must read the SAME predicate
 * or the phone and the screen drift apart, which is the exact failure this file
 * already guards against for channels. The source assertions below exist because
 * two of the three sites are inside route handlers with no pure seam: without
 * them, deleting the guard from one send path would break nothing and ship.
 */
describe('conversationNotifiesParticipants — client conversations are silent', () => {
  it('does not notify (both the pop-up and the phone push are off)', () => {
    expect(conversationNotifiesParticipants()).toBe(false)
  })

  it('is consulted by ALL THREE sites that could notify for a conversation', () => {
    const sites = [
      'components/dashboard/realtime-notifications.tsx',
      'app/api/team/threads/[id]/messages/route.ts',
      'lib/team/post-message.ts',
    ]
    for (const site of sites) {
      const src = readFileSync(join(process.cwd(), site), 'utf8')
      expect(src, `${site} must import the shared rule`)
        .toContain('conversationNotifiesParticipants')
      // Imported but never called would typecheck and silently notify again.
      expect(src, `${site} must actually CALL the rule, not just import it`)
        .toMatch(/conversationNotifiesParticipants\(\)/)
    }
  })

  it('keeps the @mention branch ABOVE the conversation branch in both send paths', () => {
    // An @mention is the deliberate way to reach someone in a now-silent
    // conversation. If the conversation branch were ever reordered above it, the
    // mention would be swallowed and there would be NO way to reach a teammate
    // inside a client conversation.
    for (const site of ['app/api/team/threads/[id]/messages/route.ts', 'lib/team/post-message.ts']) {
      const src = readFileSync(join(process.cwd(), site), 'utf8')
      const mentionAt = src.indexOf('mentions.userIds')
      const conversationAt = src.indexOf('conversationNotifiesParticipants()')
      expect(mentionAt, `${site}: mention push not found`).toBeGreaterThan(-1)
      expect(conversationAt, `${site}: conversation guard not found`).toBeGreaterThan(-1)
      expect(mentionAt, `${site}: @mention must be handled BEFORE the conversation branch`)
        .toBeLessThan(conversationAt)
    }
  })

  it('leaves the unread COUNTER alone — a quiet number is not an interruption', () => {
    // Deliberate: Antonio still wants to SEE that a conversation moved, he just
    // does not want to be pulled out of what he is doing for it.
    expect(countTeamNotifications([
      { thread_type: 'discussion', unread_count: 4, is_participant: true },
    ] as TeamThreadCountRow[])).toBe(4)
  })
})
