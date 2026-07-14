import { describe, it, expect } from 'vitest'
import { captureRestorableLabels, sanitizeRestorePayload } from '@/lib/inbox/trash-restore'

describe('captureRestorableLabels', () => {
  it('keeps only the labels trashing strips', () => {
    expect(
      captureRestorableLabels([
        { id: 'm1', labelIds: ['INBOX', 'UNREAD', 'STARRED', 'CATEGORY_PROMOTIONS'] },
      ]),
    ).toEqual([{ id: 'm1', labels: ['UNREAD', 'STARRED'] }])
  })

  it('captures IMPORTANT too', () => {
    expect(captureRestorableLabels([{ id: 'm1', labelIds: ['IMPORTANT'] }])).toEqual([
      { id: 'm1', labels: ['IMPORTANT'] },
    ])
  })

  it('omits messages with nothing to restore (a read, unstarred message)', () => {
    expect(captureRestorableLabels([{ id: 'm1', labelIds: ['INBOX'] }])).toEqual([])
  })

  it('captures per message across a thread', () => {
    expect(
      captureRestorableLabels([
        { id: 'm1', labelIds: ['INBOX', 'UNREAD'] },
        { id: 'm2', labelIds: ['INBOX'] },
        { id: 'm3', labelIds: ['STARRED'] },
      ]),
    ).toEqual([
      { id: 'm1', labels: ['UNREAD'] },
      { id: 'm3', labels: ['STARRED'] },
    ])
  })

  it('tolerates missing/blank input', () => {
    expect(captureRestorableLabels(undefined)).toEqual([])
    expect(captureRestorableLabels(null)).toEqual([])
    expect(captureRestorableLabels([])).toEqual([])
    expect(captureRestorableLabels([{ id: 'm1' }])).toEqual([])
    expect(captureRestorableLabels([{ labelIds: ['UNREAD'] }])).toEqual([])
  })
})

describe('sanitizeRestorePayload', () => {
  it('accepts a well-formed payload', () => {
    expect(sanitizeRestorePayload([{ id: 'm1', labels: ['UNREAD', 'STARRED'] }])).toEqual([
      { id: 'm1', labels: ['UNREAD', 'STARRED'] },
    ])
  })

  // The browser round-trips this on Undo, so it is untrusted input: an Undo must
  // never become a way to slap an arbitrary label onto a message.
  it('drops labels outside the allow-list', () => {
    expect(
      sanitizeRestorePayload([{ id: 'm1', labels: ['UNREAD', 'TRASH', 'SPAM', 'Label_123'] }]),
    ).toEqual([{ id: 'm1', labels: ['UNREAD'] }])
  })

  it('drops an entry whose labels are ALL disallowed', () => {
    expect(sanitizeRestorePayload([{ id: 'm1', labels: ['SPAM'] }])).toEqual([])
  })

  it('drops malformed entries', () => {
    expect(
      sanitizeRestorePayload([
        { id: '', labels: ['UNREAD'] },
        { id: 'm2', labels: 'UNREAD' },
        { id: 42, labels: ['UNREAD'] },
        { labels: ['UNREAD'] },
        null,
        'nope',
        { id: 'm3', labels: [1, 'UNREAD', null] },
      ]),
    ).toEqual([{ id: 'm3', labels: ['UNREAD'] }])
  })

  it('returns empty for non-array input', () => {
    expect(sanitizeRestorePayload(undefined)).toEqual([])
    expect(sanitizeRestorePayload(null)).toEqual([])
    expect(sanitizeRestorePayload({})).toEqual([])
    expect(sanitizeRestorePayload('UNREAD')).toEqual([])
  })

  it('round-trips a captured snapshot unchanged', () => {
    const captured = captureRestorableLabels([
      { id: 'm1', labelIds: ['INBOX', 'UNREAD'] },
      { id: 'm2', labelIds: ['STARRED', 'IMPORTANT'] },
    ])
    expect(sanitizeRestorePayload(JSON.parse(JSON.stringify(captured)))).toEqual(captured)
  })
})
