import { describe, it, expect } from 'vitest'
import { openedConversation } from '@/lib/inbox/opened-conversation'
import type { InboxConversation } from '@/lib/types'

const row = (unread: number): InboxConversation => ({
  id: 'gmail:abc',
  channel: 'gmail',
  name: 'Irshad Ahangar',
  preview: 'Confirmed, we can proceed',
  unread,
  lastMessageAt: '2026-09-29T16:21:00Z',
  subject: 'Bank of America account opening',
})

describe('openedConversation', () => {
  it('records an unread row as read the moment it is opened', () => {
    expect(openedConversation(row(3)).unread).toBe(0)
    expect(openedConversation(row(1)).unread).toBe(0)
  })

  it('keeps every other field intact', () => {
    const before = row(2)
    const after = openedConversation(before)
    expect(after).toEqual({ ...before, unread: 0 })
  })

  it('does not mutate the row it was given (it is a list/cache row)', () => {
    const before = row(2)
    openedConversation(before)
    expect(before.unread).toBe(2)
  })

  it('returns an already-read row as is', () => {
    const before = row(0)
    expect(openedConversation(before)).toBe(before)
  })
})
