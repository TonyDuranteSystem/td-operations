import { describe, it, expect } from 'vitest'
import {
  parseStaffChatTab,
  parseStaffChatTopic,
  pickUnreadTopicToOpen,
  applyLandingToUrl,
  type LandingMessage,
} from '@/lib/portal/staff-chat-landing'

const msg = (o: Partial<LandingMessage>): LandingMessage => ({
  sender_type: 'client',
  read_at: null,
  deleted_at: null,
  message: 'hello',
  topic: null,
  created_at: '2026-10-27T10:00:00Z',
  ...o,
})

describe('pickUnreadTopicToOpen', () => {
  it('returns null when nothing is unread', () => {
    expect(pickUnreadTopicToOpen([msg({ read_at: 'x' }), msg({ topic: 'Tax', read_at: 'x' })])).toBeNull()
    expect(pickUnreadTopicToOpen([])).toBeNull()
  })

  it('opens the named topic that holds the only unread message', () => {
    expect(pickUnreadTopicToOpen([msg({ topic: null, read_at: 'x' }), msg({ topic: 'Mailing Address' })])).toBe('Mailing Address')
  })

  it('stays on General when General has unread, even if a topic does too', () => {
    expect(pickUnreadTopicToOpen([msg({ topic: null }), msg({ topic: 'Tax' })])).toBeNull()
  })

  it('picks the topic with the most recent unread message', () => {
    expect(pickUnreadTopicToOpen([
      msg({ topic: 'A', created_at: '2026-10-27T09:00:00Z' }),
      msg({ topic: 'B', created_at: '2026-10-27T11:00:00Z' }),
    ])).toBe('B')
  })

  it('ignores admin rows, deleted rows and chat-event notices', () => {
    expect(pickUnreadTopicToOpen([
      msg({ topic: 'A', sender_type: 'admin' }),
      msg({ topic: 'B', deleted_at: '2026-10-27T10:00:00Z' }),
      msg({ topic: 'C', sender_type: 'system', message: 'Signed <!-- chat-event: kind=signed src=x -->' }),
    ])).toBeNull()
  })

  it('counts a plain system notice as unread', () => {
    expect(pickUnreadTopicToOpen([msg({ topic: 'Bank', sender_type: 'system' })])).toBe('Bank')
  })
})

describe('parse helpers', () => {
  it('accepts only real tabs; messages/unknown/blank → null', () => {
    expect(parseStaffChatTab('todo')).toBe('todo')
    expect(parseStaffChatTab('whatsnew')).toBe('whatsnew')
    expect(parseStaffChatTab('messages')).toBeNull()
    expect(parseStaffChatTab('nope')).toBeNull()
    expect(parseStaffChatTab(null)).toBeNull()
    expect(parseStaffChatTab('')).toBeNull()
  })

  it('topic: trims; blank/null → null (General)', () => {
    expect(parseStaffChatTopic(' Tax Return 2026 ')).toBe('Tax Return 2026')
    expect(parseStaffChatTopic('   ')).toBeNull()
    expect(parseStaffChatTopic(null)).toBeNull()
  })
})

describe('applyLandingToUrl', () => {
  const BASE = 'https://crm.example.com/portal-chats?account=acc-1'

  it('writes topic and tab, keeping other keys', () => {
    const u = new URL(applyLandingToUrl(BASE, { topic: 'Tax & Co', tab: 'todo' }))
    expect(u.searchParams.get('topic')).toBe('Tax & Co')
    expect(u.searchParams.get('tab')).toBe('todo')
    expect(u.searchParams.get('account')).toBe('acc-1')
  })

  it('removes defaults so a plain chat keeps a plain address', () => {
    const u = new URL(applyLandingToUrl(`${BASE}&topic=X&tab=todo`, { topic: null, tab: 'messages' }))
    expect(u.searchParams.has('topic')).toBe(false)
    expect(u.searchParams.has('tab')).toBe(false)
    expect(u.searchParams.get('account')).toBe('acc-1')
  })
})
