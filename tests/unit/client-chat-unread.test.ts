import { describe, it, expect } from 'vitest'
import { summarizeClientUnread, topicKey } from '@/lib/portal/client-chat-unread'
import type { PortalChatEntity } from '@/lib/portal/queries'

const ME = 'me'
const company = (id: string, sole: boolean): PortalChatEntity =>
  ({ id, kind: 'company', label: id, accountId: id, isShared: !sole, includePersonalNull: sole })
const personal: PortalChatEntity = { id: 'personal', kind: 'personal', label: 'Personal', accountId: null, isShared: false, includePersonalNull: false }

describe('summarizeClientUnread', () => {
  it('counts company rows under their company, per tab', () => {
    const s = summarizeClientUnread([
      { account_id: 'A', contact_id: ME, topic: null },
      { account_id: 'A', contact_id: null, topic: 'Tax' },
      { account_id: 'A', contact_id: 'other-member', topic: 'Tax' },
    ], [company('A', false), personal], ME)
    expect(s.total).toBe(3)
    expect(s.byEntity.A).toEqual({ '': 1, Tax: 2 })
  })

  it('a personal row shows in every view that hosts personal messages but counts ONCE', () => {
    const s = summarizeClientUnread([{ account_id: null, contact_id: ME, topic: 'Documenti da firmare' }],
      [company('A', true), company('B', true), company('C', false)], ME)
    expect(s.total).toBe(1)
    expect(s.byEntity.A).toEqual({ 'Documenti da firmare': 1 })
    expect(s.byEntity.B).toEqual({ 'Documenti da firmare': 1 })
    expect(s.byEntity.C).toBeUndefined()
  })

  it('ignores rows no view can show (never a stuck, un-clearable badge)', () => {
    const s = summarizeClientUnread([
      { account_id: 'NOT-MINE', contact_id: ME, topic: null },
      { account_id: null, contact_id: 'someone-else', topic: null },
      { account_id: null, contact_id: ME, topic: null }, // no personal host below
    ], [company('A', false)], ME)
    expect(s.total).toBe(0)
    expect(s.byEntity).toEqual({})
  })

  it('personal view hosts company-less rows', () => {
    const s = summarizeClientUnread([{ account_id: null, contact_id: ME, topic: null }], [company('A', false), personal], ME)
    expect(s).toEqual({ total: 1, byEntity: { personal: { '': 1 } } })
  })
})

describe('topicKey', () => {
  it('null/undefined → General', () => {
    expect(topicKey(null)).toBe('')
    expect(topicKey(undefined)).toBe('')
    expect(topicKey('Tax')).toBe('Tax')
  })
})
