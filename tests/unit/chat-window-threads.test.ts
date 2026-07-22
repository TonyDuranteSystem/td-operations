/**
 * Floating chat window — who can be messaged, and what the badge counts.
 *
 * The partner case is a real-world one: Cris is a partner in TD Communication,
 * not a member of staff, and the endpoint the window reads returns the directory
 * unfiltered.
 */
import { describe, it, expect } from 'vitest'
import {
  selectableChatMembers,
  myDmThreads,
  myDmThreadIdSet,
  dmUnreadCount,
  otherPartyId,
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
