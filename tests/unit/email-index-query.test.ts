import { describe, it, expect } from 'vitest'
import {
  isInstantSearchQuery,
  groupRowsToConversations,
  type EmailIndexRow,
} from '@/lib/email-index/query'

describe('isInstantSearchQuery', () => {
  it('accepts plain-word queries', () => {
    expect(isInstantSearchQuery('tamas llc')).toBe(true)
    expect(isInstantSearchQuery('"exact phrase"')).toBe(true)
    expect(isInstantSearchQuery('perché città')).toBe(true)
  })
  it('rejects Gmail operator syntax (stays live)', () => {
    expect(isInstantSearchQuery('from:tamas@x.com')).toBe(false)
    expect(isInstantSearchQuery('invoice has:attachment')).toBe(false)
    expect(isInstantSearchQuery('subject:LLC formation')).toBe(false)
    expect(isInstantSearchQuery('in:sent report')).toBe(false)
    expect(isInstantSearchQuery('-from:noreply@x.com')).toBe(false)
    expect(isInstantSearchQuery('newer_than:7d')).toBe(false)
    expect(isInstantSearchQuery('{from:a OR from:b}')).toBe(false)
  })
  it('rejects empty queries', () => {
    expect(isInstantSearchQuery('')).toBe(false)
    expect(isInstantSearchQuery('   ')).toBe(false)
  })
  it('does not misfire on words containing colons mid-word or URLs left of operators', () => {
    expect(isInstantSearchQuery('meeting 10:30')).toBe(true)
  })
})

function row(overrides: Partial<EmailIndexRow>): EmailIndexRow {
  return {
    thread_id: 't1',
    message_id: Math.random().toString(36).slice(2),
    mailbox: 'support',
    from_email: 'client@x.com',
    from_name: 'Client X',
    to_emails: ['support@tonydurante.us'],
    subject: 'Subject',
    snippet: 'snippet',
    internal_date: '2026-07-01T10:00:00.000Z',
    is_unread: false,
    has_attachment: false,
    label_ids: ['INBOX'],
    ...overrides,
  }
}

describe('groupRowsToConversations', () => {
  it('groups a thread: inbound name, unread count, latest preview, received direction', () => {
    const convs = groupRowsToConversations([
      row({ message_id: 'm1', snippet: 'first', internal_date: '2026-07-01T10:00:00Z' }),
      row({
        message_id: 'm2',
        snippet: 'latest',
        internal_date: '2026-07-02T10:00:00Z',
        label_ids: ['INBOX', 'UNREAD'],
      }),
    ])
    expect(convs).toHaveLength(1)
    const c = convs[0]
    expect(c.id).toBe('gmail:t1')
    expect(c.name).toBe('Client X')
    expect(c.preview).toBe('latest')
    expect(c.unread).toBe(1)
    expect(c.direction).toBe('received')
  })

  it('marks sent direction when the last message is ours', () => {
    const convs = groupRowsToConversations([
      row({ message_id: 'm1', internal_date: '2026-07-01T10:00:00Z' }),
      row({
        message_id: 'm2',
        from_email: 'support@tonydurante.us',
        from_name: null,
        to_emails: ['client@x.com'],
        internal_date: '2026-07-02T10:00:00Z',
      }),
    ])
    expect(convs[0].direction).toBe('sent')
    // External party stays the client, not us
    expect(convs[0].name).toBe('Client X')
  })

  it('drops fully-trashed threads and excludes trashed rows from previews', () => {
    const convs = groupRowsToConversations([
      row({ message_id: 'm1', label_ids: ['TRASH'] }),
    ])
    expect(convs).toHaveLength(0)
  })

  it('resolves color marks via the label map and flags linked threads', () => {
    const convs = groupRowsToConversations(
      [row({ message_id: 'm1', label_ids: ['INBOX', 'Label_77'] })],
      {
        markLabelNames: new Map([['Label_77', 'Marked/Red']]),
        linkedThreadIds: new Set(['t1']),
      }
    )
    expect(convs[0].colorMark).toBe('red')
    expect(convs[0].linked).toBe(true)
  })

  it('falls back to the CRM account name when the sender has no display name', () => {
    const convs = groupRowsToConversations(
      [row({ message_id: 'm1', from_name: null })],
      { emailLookup: new Map([['client@x.com', { accountId: 'a1', accountName: 'X LLC' }]]) }
    )
    expect(convs[0].name).toBe('X LLC')
    expect(convs[0].accountId).toBe('a1')
  })

  it('uses recipients for draft-only threads and sorts threads newest-first', () => {
    const convs = groupRowsToConversations([
      row({
        thread_id: 'draft',
        message_id: 'd1',
        from_email: 'support@tonydurante.us',
        from_name: null,
        to_emails: ['newclient@y.com'],
        label_ids: ['DRAFT'],
        internal_date: '2026-07-03T10:00:00Z',
      }),
      row({ thread_id: 'old', message_id: 'o1', internal_date: '2026-06-01T10:00:00Z' }),
    ])
    expect(convs.map((c) => c.id)).toEqual(['gmail:draft', 'gmail:old'])
    expect(convs[0].name).toBe('newclient@y.com')
  })
})
