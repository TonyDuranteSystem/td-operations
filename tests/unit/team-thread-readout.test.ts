import { describe, it, expect } from 'vitest'
import { parseThreadLink, formatThreadReadout } from '@/lib/team/thread-readout'

describe('parseThreadLink', () => {
  it('extracts channel + root from a full link', () => {
    expect(parseThreadLink('https://crm.tonydurante.us/team-chat?thread=ch1&root=rt1'))
      .toEqual({ channelId: 'ch1', rootId: 'rt1' })
  })

  it('extracts channel + root regardless of param order', () => {
    expect(parseThreadLink('https://crm.tonydurante.us/team-chat?root=rt1&thread=ch1'))
      .toEqual({ channelId: 'ch1', rootId: 'rt1' })
  })

  it('accepts a bare query string', () => {
    expect(parseThreadLink('?thread=ch1&root=rt1')).toEqual({ channelId: 'ch1', rootId: 'rt1' })
  })

  it('rejects a link missing the thread id', () => {
    const r = parseThreadLink('https://crm.tonydurante.us/team-chat?root=rt1')
    expect(r).toHaveProperty('error')
  })

  it('rejects a link missing the root id', () => {
    const r = parseThreadLink('https://crm.tonydurante.us/team-chat?thread=ch1')
    expect(r).toHaveProperty('error')
  })

  it('rejects the plain page URL with no thread open', () => {
    const r = parseThreadLink('https://crm.tonydurante.us/team-chat')
    expect(r).toHaveProperty('error')
  })

  it('rejects empty input', () => {
    expect(parseThreadLink('')).toHaveProperty('error')
    expect(parseThreadLink('   ')).toHaveProperty('error')
  })

  it('rejects garbage that is not a URL or query string', () => {
    const r = parseThreadLink('not a link at all')
    expect(r).toHaveProperty('error')
  })
})

describe('formatThreadReadout', () => {
  const base = {
    channelLabel: 'td-bug',
    title: 'Aumianna LLC and VictoriamRoas LLC',
    status: 'in_progress' as const,
    assigneeName: null,
    messages: [
      { sender_name: 'Antonio', created_at: '2026-07-20T10:00:00Z', message: 'Both accounts are stuck.' },
    ],
  }

  it('renders the channel, title and status', () => {
    const text = formatThreadReadout(base)
    expect(text).toContain('#td-bug')
    expect(text).toContain('Aumianna LLC and VictoriamRoas LLC')
    expect(text).toContain('Working')
  })

  it('includes the assignee when present', () => {
    const text = formatThreadReadout({ ...base, assigneeName: 'Luca' })
    expect(text).toContain('Assigned to Luca')
  })

  it('omits an assignee line when there is none', () => {
    const text = formatThreadReadout(base)
    expect(text).not.toContain('Assigned to')
  })

  it('renders every message with sender and body', () => {
    const text = formatThreadReadout({
      ...base,
      messages: [
        { sender_name: 'Antonio', created_at: '2026-07-20T10:00:00Z', message: 'First' },
        { sender_name: 'Luca', created_at: '2026-07-20T10:05:00Z', message: 'Second' },
      ],
    })
    expect(text).toContain('Antonio: First')
    expect(text).toContain('Luca: Second')
  })

  it('renders a tombstone for a deleted message instead of leaking its body', () => {
    const text = formatThreadReadout({
      ...base,
      messages: [
        { sender_name: 'Antonio', created_at: '2026-07-20T10:00:00Z', message: 'secret body', deleted_at: '2026-07-20T11:00:00Z' },
      ],
    })
    expect(text).toContain('(message deleted)')
    expect(text).not.toContain('secret body')
  })

  it('notes attachments without dumping their contents', () => {
    const text = formatThreadReadout({
      ...base,
      messages: [
        { sender_name: 'Antonio', created_at: '2026-07-20T10:00:00Z', message: 'see this', attachments: [{ url: 'x' }, { url: 'y' }] },
      ],
    })
    expect(text).toContain('[2 attachments]')
  })

  it('falls back to Unknown for a missing sender name', () => {
    const text = formatThreadReadout({
      ...base,
      messages: [{ sender_name: null, created_at: '2026-07-20T10:00:00Z', message: 'hi' }],
    })
    expect(text).toContain('Unknown: hi')
  })
})
