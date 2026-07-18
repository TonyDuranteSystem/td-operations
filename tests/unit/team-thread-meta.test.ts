import { describe, it, expect } from 'vitest'
import { computeThreadMeta, sortPanelThreads, type ReplyRow, type RootReadRow, type PanelThread } from '@/lib/team/thread-meta'

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

function pt(root_id: string, status: PanelThread['status'], unread: boolean, last: string | null = '2026-07-17T10:00:00Z'): PanelThread {
  return { root_id, status, unread, last_reply_at: last }
}

describe('sortPanelThreads', () => {
  it('floats unread ("New") to the top regardless of status', () => {
    const out = sortPanelThreads([
      pt('working-read', 'in_progress', false),
      pt('done-unread', 'handled', true),
    ], false)
    expect(out[0].root_id).toBe('done-unread') // a Done thread with a new reply resurfaces
  })

  it('orders read threads Working → Pending → Open → Done', () => {
    const out = sortPanelThreads([
      pt('d', 'handled', false), pt('o', 'todo', false), pt('p', 'waiting', false), pt('w', 'in_progress', false),
    ], false)
    expect(out.map(t => t.root_id)).toEqual(['w', 'p', 'o', 'd'])
  })

  it('hideDone drops READ done but keeps unread done', () => {
    const out = sortPanelThreads([
      pt('done-read', 'handled', false), pt('done-new', 'handled', true), pt('open', 'todo', false),
    ], true)
    const ids = out.map(t => t.root_id)
    expect(ids).toContain('done-new')
    expect(ids).toContain('open')
    expect(ids).not.toContain('done-read')
  })

  it('newest reply first within the same bucket', () => {
    const out = sortPanelThreads([
      pt('older', 'in_progress', false, '2026-07-17T08:00:00Z'),
      pt('newer', 'in_progress', false, '2026-07-17T12:00:00Z'),
    ], false)
    expect(out[0].root_id).toBe('newer')
  })
})
