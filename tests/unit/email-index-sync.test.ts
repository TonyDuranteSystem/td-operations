import { describe, it, expect } from 'vitest'
import {
  buildIndexRow,
  resolveLinkage,
  type CrmDirectory,
} from '@/lib/email-index/sync'
import type { GmailAPIMessage } from '@/lib/gmail'

const dir: CrmDirectory = {
  contacts: new Map([
    ['mario@x.com', { contact_id: 'c1', account_id: 'a1' }],
    ['solo@y.com', { contact_id: 'c2', account_id: null }],
  ]),
  leads: new Map([['lead@z.com', 'l1']]),
}

function msg(overrides: Partial<GmailAPIMessage> & { from?: string; to?: string }): GmailAPIMessage {
  const { from, to, ...rest } = overrides
  return {
    id: 'm1',
    threadId: 't1',
    snippet: 'Hi Tony, I hope you&#39;re well',
    labelIds: ['INBOX', 'UNREAD'],
    internalDate: '1783515731000',
    payload: {
      headers: [
        { name: 'From', value: from ?? '"Mario Rossi" <Mario@X.com>' },
        { name: 'To', value: to ?? 'support@tonydurante.us' },
        { name: 'Subject', value: 'Tax Return 2025' },
      ],
      mimeType: 'multipart/mixed',
    },
    ...rest,
  } as GmailAPIMessage
}

describe('resolveLinkage', () => {
  it('prefers a contact match (with account) over a lead', () => {
    expect(resolveLinkage(['lead@z.com', 'mario@x.com'], dir)).toEqual({
      account_id: 'a1', contact_id: 'c1', lead_id: null,
    })
  })
  it('falls back to leads, then to nothing', () => {
    expect(resolveLinkage(['lead@z.com'], dir)).toEqual({ account_id: null, contact_id: null, lead_id: 'l1' })
    expect(resolveLinkage(['stranger@w.com'], dir)).toEqual({ account_id: null, contact_id: null, lead_id: null })
  })
})

describe('buildIndexRow', () => {
  it('builds a complete metadata row (no body fields)', () => {
    const row = buildIndexRow('support', msg({}), dir)
    expect(row).toMatchObject({
      mailbox: 'support',
      thread_id: 't1',
      message_id: 'm1',
      from_email: 'mario@x.com',
      from_name: 'Mario Rossi',
      to_emails: ['support@tonydurante.us'],
      subject: 'Tax Return 2025',
      is_unread: true,
      has_attachment: true,
      account_id: 'a1',
      contact_id: 'c1',
      lead_id: null,
    })
    expect(row.snippet).toBe("Hi Tony, I hope you're well") // entities decoded
    expect(row.internal_date).toBe(new Date(1783515731000).toISOString())
    expect(Object.keys(row)).not.toContain('body')
  })

  it('resolves linkage from recipients on outbound messages', () => {
    const row = buildIndexRow('support', msg({
      from: 'Tony Durante <support@tonydurante.us>',
      to: 'Mario Rossi <mario@x.com>, other@w.com',
      labelIds: ['SENT'],
    }), dir)
    expect(row.is_unread).toBe(false)
    expect(row.account_id).toBe('a1')
    expect(row.to_emails).toEqual(['mario@x.com', 'other@w.com'])
  })

  it('marks read messages and plain mime correctly', () => {
    const row = buildIndexRow('antonio', msg({
      labelIds: ['INBOX'],
      payload: {
        headers: [
          { name: 'From', value: 'lead@z.com' },
          { name: 'To', value: 'antonio.durante@tonydurante.us' },
          { name: 'Subject', value: 'Hello' },
        ],
        mimeType: 'text/html',
      },
    }), dir)
    expect(row.mailbox).toBe('antonio')
    expect(row.is_unread).toBe(false)
    expect(row.has_attachment).toBe(false)
    expect(row.lead_id).toBe('l1')
  })
})
