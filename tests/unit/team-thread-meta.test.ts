import { describe, it, expect } from 'vitest'
import { computeThreadMeta, type ReplyRow, type RootReadRow } from '@/lib/team/thread-meta'

const ME = 'user-me'
const OTHER = 'user-other'

function reply(root: string, at: string, sender = OTHER, name = 'Other'): ReplyRow {
  return { root_id: root, created_at: at, sender_id: sender, sender_name: name }
}

describe('computeThreadMeta', () => {
  it('counts replies and reports the newest reply per root', () => {
    const rows: ReplyRow[] = [
      reply('R1', '2026-07-17T10:00:00Z', OTHER, 'Luca'),
      reply('R1', '2026-07-17T11:00:00Z', ME, 'Me'),
      reply('R2', '2026-07-17T09:00:00Z', OTHER, 'Luca'),
    ]
    const meta = computeThreadMeta(rows, [], ME)
    expect(meta['R1'].reply_count).toBe(2)
    expect(meta['R1'].last_reply_at).toBe('2026-07-17T11:00:00Z')
    expect(meta['R1'].last_reply_sender).toBe('Me')
    expect(meta['R2'].reply_count).toBe(1)
  })

  it('marks unread when another user replied and there is no read pointer', () => {
    const meta = computeThreadMeta([reply('R1', '2026-07-17T10:00:00Z')], [], ME)
    expect(meta['R1'].unread).toBe(true)
  })

  it('does NOT mark unread for my own replies only', () => {
    const meta = computeThreadMeta([reply('R1', '2026-07-17T10:00:00Z', ME, 'Me')], [], ME)
    expect(meta['R1'].unread).toBe(false)
  })

  it('clears unread when my read pointer is newer than the last other reply', () => {
    const rows = [reply('R1', '2026-07-17T10:00:00Z')]
    const reads: RootReadRow[] = [{ root_message_id: 'R1', last_read_at: '2026-07-17T10:30:00Z' }]
    expect(computeThreadMeta(rows, reads, ME)['R1'].unread).toBe(false)
  })

  it('keeps unread when a new other-reply lands after my read pointer', () => {
    const rows = [reply('R1', '2026-07-17T11:00:00Z')]
    const reads: RootReadRow[] = [{ root_message_id: 'R1', last_read_at: '2026-07-17T10:30:00Z' }]
    expect(computeThreadMeta(rows, reads, ME)['R1'].unread).toBe(true)
  })

  it('handles an empty thread', () => {
    expect(computeThreadMeta([], [], ME)).toEqual({})
  })
})
