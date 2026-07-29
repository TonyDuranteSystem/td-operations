import { describe, it, expect } from 'vitest'
import { computeThreadMeta, sortPanelThreads, type ReplyRow, type RootReadRow, type PanelThread, filterStreamRoots } from '@/lib/team/thread-meta'

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

  it('does NOT mark unread for a Claude reply I dictated (on_behalf_of me)', () => {
    const dictated: ReplyRow = { root_id: 'R1', created_at: '2026-07-17T10:00:00Z', sender_id: 'claude-sentinel', sender_name: 'Claude', on_behalf_of_user_id: ME }
    const meta = computeThreadMeta([dictated], [], ME)
    expect(meta['R1'].unread).toBe(false)
  })

  it('DOES mark unread for a Claude reply someone ELSE dictated', () => {
    const dictated: ReplyRow = { root_id: 'R1', created_at: '2026-07-17T10:00:00Z', sender_id: 'claude-sentinel', sender_name: 'Claude', on_behalf_of_user_id: OTHER }
    const meta = computeThreadMeta([dictated], [], ME)
    expect(meta['R1'].unread).toBe(true)
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

describe('filterStreamRoots', () => {
  const root = (id: string) => ({ id, root_id: null })
  const reply = (id: string, rootId: string) => ({ id, root_id: rootId })

  it('drops replies — they belong in the thread pane', () => {
    const out = filterStreamRoots([root('a'), reply('a1', 'a')], [], false)
    expect(out.map(m => m.id)).toEqual(['a'])
  })

  it('hides an archived thread from the channel', () => {
    const out = filterStreamRoots([root('a'), root('b')], ['b'], false)
    expect(out.map(m => m.id)).toEqual(['a'])
  })

  it('shows archived threads again in the archive view, so they can be restored', () => {
    const out = filterStreamRoots([root('a'), root('b')], ['b'], true)
    expect(out.map(m => m.id)).toEqual(['a', 'b'])
  })

  it('hides nothing when nothing is archived', () => {
    expect(filterStreamRoots([root('a'), root('b')], [], false).map(m => m.id)).toEqual(['a', 'b'])
    expect(filterStreamRoots([root('a')], null, false).map(m => m.id)).toEqual(['a'])
    expect(filterStreamRoots([root('a')], undefined, false).map(m => m.id)).toEqual(['a'])
  })

  // THE REGRESSION: the archived set was derived from the panel's thread list,
  // which drops archived rows when the archive view is off — so it arrived empty
  // and the archived thread kept rendering in the channel. Passing an empty set
  // must therefore be understood as "nothing is archived", and the caller must
  // pass the COMPLETE set.
  it('cannot hide anything if handed an empty set — the caller must pass the full set', () => {
    expect(filterStreamRoots([root('a'), root('b')], [], false).map(m => m.id)).toEqual(['a', 'b'])
  })
})

describe('computeThreadMeta — hand-marked unread', () => {
  const ME = 'me'
  const reply = (rootId: string, sender: string, at: string) =>
    ({ root_id: rootId, created_at: at, sender_id: sender, sender_name: sender })

  it('reads as unread even when everything has been seen', () => {
    // My own reply, already read — nothing new, but I marked it unread by hand.
    const out = computeThreadMeta(
      [reply('r1', ME, '2026-07-18T10:00:00Z')],
      [{ root_message_id: 'r1', last_read_at: '2026-07-18T11:00:00Z', manual_unread: true }],
      ME,
    )
    expect(out['r1'].unread).toBe(true)
  })

  it('is not unread when the flag is off and there is nothing new', () => {
    const out = computeThreadMeta(
      [reply('r1', ME, '2026-07-18T10:00:00Z')],
      [{ root_message_id: 'r1', last_read_at: '2026-07-18T11:00:00Z', manual_unread: false }],
      ME,
    )
    expect(out['r1'].unread).toBe(false)
  })

  it('still reads as unread from a real new reply, flag or no flag', () => {
    const out = computeThreadMeta(
      [reply('r1', 'someone-else', '2026-07-18T12:00:00Z')],
      [{ root_message_id: 'r1', last_read_at: '2026-07-18T11:00:00Z' }],
      ME,
    )
    expect(out['r1'].unread).toBe(true)
  })

  it('treats a missing flag as false rather than throwing', () => {
    const out = computeThreadMeta(
      [reply('r1', ME, '2026-07-18T10:00:00Z')],
      [{ root_message_id: 'r1', last_read_at: '2026-07-18T11:00:00Z' }],
      ME,
    )
    expect(out['r1'].unread).toBe(false)
  })
})
