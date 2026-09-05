/**
 * Floating chat window — who can be messaged, and what the badge counts.
 *
 * ⚠️ READ THIS BEFORE TRUSTING THE PARTNER CASES BELOW.
 *
 * These tests originally gave FALSE CONFIDENCE and a partner reached production
 * in the picker. The fixture below hands `selectableChatMembers` a member with
 * `role: 'partner'` and asserts it is dropped — which passes. But the real
 * directory NEVER EMITTED 'partner': it excluded only clients and then coerced
 * every survivor to 'admin' | 'team'. So the branch these tests exercise was
 * unreachable in production, and the actual partner arrived labelled 'team' and
 * sailed straight through. Green tests, live bug.
 *
 * The REAL defence now lives at the source, in `isStaffAuthRole`, and is tested
 * against the genuine production role values in tests/unit/team-workspace.test.ts.
 * What remains here is belt-and-braces: it proves this function does not RE-ADMIT
 * someone the directory already excluded. Do not read it as proof that a partner
 * cannot appear — that proof is the other file's.
 *
 * The transferable lesson: a test whose fixture is shaped by what you ASSUME the
 * caller sends, rather than what it actually sends, tests your assumption.
 */
import { describe, it, expect } from 'vitest'
import {
  selectableChatMembers,
  myDmThreads,
  myDmThreadIdSet,
  dmUnreadCount,
  otherPartyId,
  openConversations,
  conversationLabel,
  windowUnreadCount,
  type ChatMember,
  type ChatThreadRow,
} from '@/lib/team/chat-window-threads'

const ME = 'antonio'
const MEMBERS: ChatMember[] = [
  { id: 'antonio', name: 'Antonio', role: 'admin' },
  { id: 'luca', name: 'Luca', role: 'team' },
  { id: 'cris', name: 'Cris', role: 'partner' },
  { id: 'someclient', name: 'A Client', role: 'client' },
  { id: 'noroleuser', name: 'No Role' },
]

describe('selectableChatMembers', () => {
  it('offers staff only', () => {
    expect(selectableChatMembers(MEMBERS, ME).map((m) => m.id)).toEqual(['luca'])
  })

  it('NEVER offers a partner — a partner is not staff', () => {
    expect(selectableChatMembers(MEMBERS, ME).find((m) => m.id === 'cris')).toBeUndefined()
  })

  it('never offers a client', () => {
    expect(selectableChatMembers(MEMBERS, ME).find((m) => m.id === 'someclient')).toBeUndefined()
  })

  it('excludes a member with no role rather than assuming staff', () => {
    expect(selectableChatMembers(MEMBERS, ME).find((m) => m.id === 'noroleuser')).toBeUndefined()
  })

  it('never offers yourself — a self-DM has no other party, so nothing is ever delivered', () => {
    expect(selectableChatMembers(MEMBERS, ME).find((m) => m.id === ME)).toBeUndefined()
  })

  it('returns nobody while my identity is still resolving', () => {
    expect(selectableChatMembers(MEMBERS, null)).toEqual([])
  })

  it('tolerates a missing or empty directory', () => {
    expect(selectableChatMembers(null, ME)).toEqual([])
    expect(selectableChatMembers([], ME)).toEqual([])
  })

  it('is case-insensitive about the role', () => {
    expect(selectableChatMembers([{ id: 'l', name: 'L', role: 'TEAM' }], ME).map((m) => m.id)).toEqual(['l'])
  })
})

const THREADS: ChatThreadRow[] = [
  { id: 't-dm-luca', thread_type: 'dm', dm_key: 'antonio:luca', unread_count: 2, last_activity_at: '2026-07-22T10:00:00Z' },
  { id: 't-dm-old', thread_type: 'dm', dm_key: 'antonio:zoe', unread_count: 1, last_activity_at: '2026-07-20T10:00:00Z' },
  { id: 't-dm-notmine', thread_type: 'dm', dm_key: 'luca:zoe', unread_count: 9, last_activity_at: '2026-07-22T11:00:00Z' },
  { id: 't-channel', thread_type: 'channel', unread_count: 40, last_activity_at: '2026-07-22T12:00:00Z' },
  { id: 't-disc', thread_type: 'discussion', unread_count: 5, last_activity_at: '2026-07-22T12:00:00Z' },
]

describe('myDmThreads', () => {
  it('returns only my DMs, newest activity first', () => {
    expect(myDmThreads(THREADS, ME).map((t) => t.id)).toEqual(['t-dm-luca', 't-dm-old'])
  })

  it('excludes a DM between two other people', () => {
    expect(myDmThreads(THREADS, ME).find((t) => t.id === 't-dm-notmine')).toBeUndefined()
  })

  it('excludes channels and client conversations', () => {
    const ids = myDmThreads(THREADS, ME).map((t) => t.id)
    expect(ids).not.toContain('t-channel')
    expect(ids).not.toContain('t-disc')
  })

  it('returns nothing while my identity is resolving', () => {
    expect(myDmThreads(THREADS, null)).toEqual([])
  })
})

describe('myDmThreadIdSet', () => {
  it('is the membership test the auto-pop decision uses', () => {
    const set = myDmThreadIdSet(THREADS, ME)
    expect(set.has('t-dm-luca')).toBe(true)
    expect(set.has('t-dm-notmine')).toBe(false)
    expect(set.has('t-channel')).toBe(false)
  })
})

describe('dmUnreadCount', () => {
  it('counts unread direct messages only', () => {
    // 2 + 1 — deliberately NOT the channel's 40 or the conversation's 5
    expect(dmUnreadCount(THREADS, ME)).toBe(3)
  })

  it('does not count someone else\'s DM', () => {
    expect(dmUnreadCount(THREADS, ME)).toBeLessThan(9)
  })

  it('is zero, not NaN, when counts are missing', () => {
    expect(dmUnreadCount([{ id: 'x', thread_type: 'dm', dm_key: 'antonio:luca' }], ME)).toBe(0)
    expect(dmUnreadCount(null, ME)).toBe(0)
  })
})

describe('otherPartyId', () => {
  it('finds the other person', () => {
    expect(otherPartyId('antonio:luca', ME)).toBe('luca')
    expect(otherPartyId('luca:antonio', ME)).toBe('luca')
  })

  it('returns null for a self-keyed or malformed thread', () => {
    expect(otherPartyId('antonio:antonio', ME)).toBeNull()
    expect(otherPartyId('', ME)).toBeNull()
    expect(otherPartyId(null, ME)).toBeNull()
    expect(otherPartyId('antonio:luca', null)).toBeNull()
  })
})

describe('openConversations — the client chats the window can open', () => {
  const rows: ChatThreadRow[] = [
    { id: 'c1', thread_type: 'discussion', label: 'Rossi LLC · EIN', unread_count: 2, last_activity_at: '2026-07-22T10:00:00Z', ever_mentioned: true },
    { id: 'c2', thread_type: 'discussion', label: 'Bianchi LLC', unread_count: 0, last_activity_at: '2026-07-21T10:00:00Z', ever_mentioned: true },
    { id: 'c3', thread_type: 'discussion', label: 'Done one', unread_count: 5, last_activity_at: '2026-07-22T12:00:00Z', resolved_at: '2026-07-22T12:30:00Z', ever_mentioned: true },
    { id: 'c4', thread_type: 'discussion', label: 'Archived one', unread_count: 3, last_activity_at: '2026-07-22T13:00:00Z', archived_at: '2026-07-22T13:30:00Z', ever_mentioned: true },
    { id: 'ch', thread_type: 'channel', unread_count: 40, last_activity_at: '2026-07-22T14:00:00Z' },
    { id: 'd1', thread_type: 'dm', dm_key: 'antonio:luca', unread_count: 1, last_activity_at: '2026-07-22T09:00:00Z' },
  ]

  it('returns live client conversations, newest first', () => {
    expect(openConversations(rows).map((t) => t.id)).toEqual(['c1', 'c2'])
  })

  it('drops resolved and archived ones — the window shows what is live', () => {
    const ids = openConversations(rows).map((t) => t.id)
    expect(ids).not.toContain('c3')
    expect(ids).not.toContain('c4')
  })

  it('is not channels and not DMs', () => {
    const ids = openConversations(rows).map((t) => t.id)
    expect(ids).not.toContain('ch')
    expect(ids).not.toContain('d1')
  })

  it('respects the limit', () => {
    expect(openConversations(rows, 1).map((t) => t.id)).toEqual(['c1'])
  })

  it('tolerates an empty or missing list', () => {
    expect(openConversations(null)).toEqual([])
    expect(openConversations([])).toEqual([])
  })

  // Antonio, 2026-09-04/05, THREE rounds on the same complaint before this
  // landed — see lib/team/chat-window-threads.ts's file header for the full
  // story of the two wrong fixes in between. His own words, asked directly
  // after round two still left the list full: "I don't read them at all
  // unless i have been mentioned. but they are messy because most of them are
  // luca or claude conversation about the clients."
  describe('ever_mentioned scoping — the third and correct definition of "mine"', () => {
    it('drops a live, unresolved conversation the viewer has never been mentioned in', () => {
      const notMine: ChatThreadRow = {
        id: 'c-not-mine', thread_type: 'discussion', label: 'Someone Else LLC',
        unread_count: 3, last_activity_at: '2026-09-04T10:00:00Z', ever_mentioned: false,
      }
      expect(openConversations([notMine])).toEqual([])
    })

    it('also drops one where ever_mentioned was never set at all (server omission fails closed, not open)', () => {
      const unset: ChatThreadRow = {
        id: 'c-unset', thread_type: 'discussion', label: 'Unset LLC',
        unread_count: 3, last_activity_at: '2026-09-04T10:00:00Z',
      }
      expect(openConversations([unset])).toEqual([])
    })

    it('keeps a conversation the viewer was mentioned in, alongside a filtered-out one', () => {
      const mine: ChatThreadRow = {
        id: 'c-mine', thread_type: 'discussion', label: 'Mine LLC',
        unread_count: 1, last_activity_at: '2026-09-04T09:00:00Z', ever_mentioned: true,
      }
      const notMine: ChatThreadRow = {
        id: 'c-not-mine', thread_type: 'discussion', label: 'Someone Else LLC',
        unread_count: 3, last_activity_at: '2026-09-04T10:00:00Z', ever_mentioned: false,
      }
      expect(openConversations([mine, notMine]).map((t) => t.id)).toEqual(['c-mine'])
    })

    // BOTH PRIOR ROUNDS' BUG, regression-pinned in one test (bug-hunter,
    // 2026-09-05, caught that two separately-named tests here were actually
    // byte-identical: ChatThreadRow has no field left that can represent
    // "genuinely opened" as distinct from `is_participant` now that
    // `ever_opened` was removed from the type entirely — a second test
    // claiming to pin that shape was testing nothing new). Round one trusted
    // `is_participant` (a row merely exists — true for this shape); round two
    // trusted a genuine, non-epoch `last_read_at` (also true for real
    // production cases matching this shape, per the file header). Neither is
    // what `openConversations` reads now — only `ever_mentioned` is.
    it('drops a conversation that IS a participant (row exists) but was never mentioned — the auto-seed-on-create/share case', () => {
      const autoSeeded: ChatThreadRow = {
        id: 'c-auto-seeded', thread_type: 'discussion', label: 'Someone Else LLC',
        unread_count: 3, last_activity_at: '2026-09-04T10:00:00Z',
        is_participant: true, ever_mentioned: false,
      }
      expect(openConversations([autoSeeded])).toEqual([])
    })
  })
})

describe('conversationLabel', () => {
  it('prefers the label the server already resolved', () => {
    expect(conversationLabel({ id: 'x', label: 'Rossi · EIN', title: 'other' })).toBe('Rossi · EIN')
  })
  it('falls back through title, topic, client', () => {
    expect(conversationLabel({ id: 'x', title: 'A title' })).toBe('A title')
    expect(conversationLabel({ id: 'x', topic: 'A topic' })).toBe('A topic')
    expect(conversationLabel({ id: 'x', client_label: 'Rossi LLC' })).toBe('Rossi LLC')
  })
  it('never returns empty', () => {
    expect(conversationLabel({ id: 'x' })).toBe('Conversation')
    expect(conversationLabel({ id: 'x', label: '   ' })).toBe('Conversation')
    expect(conversationLabel(null)).toBe('Conversation')
  })
})

describe('windowUnreadCount — the badge counts what the window can open', () => {
  const rows: ChatThreadRow[] = [
    { id: 'd1', thread_type: 'dm', dm_key: 'antonio:luca', unread_count: 2 },
    { id: 'c1', thread_type: 'discussion', unread_count: 3, ever_mentioned: true },
    { id: 'c-done', thread_type: 'discussion', unread_count: 9, resolved_at: 'x', ever_mentioned: true },
    { id: 'ch', thread_type: 'channel', unread_count: 40 },
  ]

  it('counts direct messages plus live client conversations', () => {
    expect(windowUnreadCount(rows, ME)).toBe(5)
  })

  it('THE GRAIN RULE: never counts something the window cannot open', () => {
    // channels (40) are not in the window, and a resolved conversation (9) is
    // not listed — counting either would send Antonio hunting for a message
    // that is not there.
    expect(windowUnreadCount(rows, ME)).toBeLessThan(40)
  })

  it('is zero, not NaN, on missing data', () => {
    expect(windowUnreadCount(null, ME)).toBe(0)
    expect(windowUnreadCount(rows, null)).toBe(3) // conversations still count; DMs need identity
  })

  it('does not count a conversation the viewer was never mentioned in (2026-09-04)', () => {
    const notMine: ChatThreadRow = { id: 'c-not-mine', thread_type: 'discussion', unread_count: 99, ever_mentioned: false }
    expect(windowUnreadCount([...rows, notMine], ME)).toBe(5) // unchanged — the 99 never counts
  })
})
