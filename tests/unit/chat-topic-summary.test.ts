import { describe, it, expect } from 'vitest'
import {
  GENERAL_TOPIC_KEY,
  applyMessageToSummary,
  buildTopicSummary,
  foldFirstPage,
  mergeTabPages,
  mergeTopicView,
  messageInTopic,
  oldestCreatedAt,
  parseTopicParam,
  pickUnreadTopicFromSummary,
  topicKeyOf,
  type TopicSummaryEntry,
} from '@/lib/portal/chat-topic-summary'

type M = { id: string; created_at: string; topic?: string | null; deleted_at?: string | null; label?: string }
const msg = (id: string, at: string, topic: string | null = null, extra: Partial<M> = {}): M => ({ id, created_at: at, topic, ...extra })

describe('topicKeyOf / messageInTopic', () => {
  it('General is the empty key; a topic is its exact text', () => {
    expect(topicKeyOf(null)).toBe('')
    expect(topicKeyOf(undefined)).toBe('')
    expect(topicKeyOf('')).toBe('')
    expect(topicKeyOf('Tax 2025')).toBe('Tax 2025')
    expect(topicKeyOf('tax 2025')).toBe('tax 2025') // never case-folded
    expect(topicKeyOf('Tax ')).toBe('Tax ') // never trimmed
  })

  it('General matches no topic (null or empty); a named tab matches exactly', () => {
    expect(messageInTopic({ topic: null }, GENERAL_TOPIC_KEY)).toBe(true)
    expect(messageInTopic({ topic: '' }, GENERAL_TOPIC_KEY)).toBe(true)
    expect(messageInTopic({}, GENERAL_TOPIC_KEY)).toBe(true)
    expect(messageInTopic({ topic: 'Tax' }, GENERAL_TOPIC_KEY)).toBe(false)
    expect(messageInTopic({ topic: 'Tax' }, 'Tax')).toBe(true)
    expect(messageInTopic({ topic: 'tax' }, 'Tax')).toBe(false)
    expect(messageInTopic({ topic: null }, 'Tax')).toBe(false)
  })

  it('a real topic named "General" is NOT the General tab', () => {
    expect(messageInTopic({ topic: 'General' }, GENERAL_TOPIC_KEY)).toBe(false)
    expect(messageInTopic({ topic: 'General' }, 'General')).toBe(true)
  })
})

describe('parseTopicParam', () => {
  it('absent = no filter, present-but-empty = General, otherwise exact name', () => {
    expect(parseTopicParam(new URLSearchParams('limit=50'))).toEqual({ kind: 'none' })
    expect(parseTopicParam(new URLSearchParams('topic='))).toEqual({ kind: 'general' })
    expect(parseTopicParam(new URLSearchParams('topic=Tax%202025'))).toEqual({ kind: 'named', name: 'Tax 2025' })
  })

  it('does not trim or case-fold, and keeps commas and parentheses intact', () => {
    expect(parseTopicParam(new URLSearchParams('topic=%20Tax%20'))).toEqual({ kind: 'named', name: ' Tax ' })
    expect(parseTopicParam(new URLSearchParams('topic=a%2Cb)(c'))).toEqual({ kind: 'named', name: 'a,b)(c' })
  })
})

describe('buildTopicSummary', () => {
  it('lists every topic with its newest message, newest activity first', () => {
    const s = buildTopicSummary({
      namedRows: [
        { topic: 'Bank', created_at: '2026-03-01T10:00:00Z' },
        { topic: 'Tax', created_at: '2026-05-01T10:00:00Z' },
        { topic: 'Bank', created_at: '2026-04-01T10:00:00Z' },
      ],
      generalLastAt: '2026-06-01T10:00:00Z',
    })
    expect(s.map(e => e.topic)).toEqual(['', 'Tax', 'Bank'])
    expect(s.find(e => e.topic === 'Bank')?.lastAt).toBe('2026-04-01T10:00:00Z')
  })

  it('a topic whose messages are all very old is still listed (the original bug)', () => {
    const s = buildTopicSummary({ namedRows: [{ topic: 'Operating agreement', created_at: '2025-01-05T00:00:00Z' }], generalLastAt: '2026-11-20T00:00:00Z' })
    expect(s.map(e => e.topic)).toContain('Operating agreement')
  })

  it('counts unread per topic from unread rows, and General from null/empty topics', () => {
    const s = buildTopicSummary({
      namedRows: [{ topic: 'Tax', created_at: '2026-05-01T10:00:00Z' }],
      generalLastAt: null,
      unreadTopics: ['Tax', null, '', 'Tax'],
    })
    expect(s.find(e => e.topic === 'Tax')?.unread).toBe(2)
    expect(s.find(e => e.topic === '')?.unread).toBe(2)
  })

  it('lists a topic that only has unread rows (so its badge can be reached)', () => {
    const s = buildTopicSummary({ namedRows: [], generalLastAt: null, unreadByKey: { Lease: 3, Empty: 0 } })
    expect(s).toEqual([{ topic: 'Lease', lastAt: null, unread: 3 }])
  })

  it('does not merge topics that differ only by case or spacing', () => {
    const s = buildTopicSummary({
      namedRows: [
        { topic: 'bank', created_at: '2026-01-01T00:00:00Z' },
        { topic: 'Bank', created_at: '2026-01-02T00:00:00Z' },
        { topic: 'Bank ', created_at: '2026-01-03T00:00:00Z' },
      ],
      generalLastAt: null,
    })
    expect(s.map(e => e.topic).sort()).toEqual(['Bank', 'Bank ', 'bank'])
  })

  it('an empty conversation gives an empty list', () => {
    expect(buildTopicSummary({ namedRows: [], generalLastAt: null })).toEqual([])
  })
})

describe('pickUnreadTopicFromSummary', () => {
  const e = (topic: string, unread: number, lastAt: string | null): TopicSummaryEntry => ({ topic, unread, lastAt })

  it('stays on General when General has unread', () => {
    expect(pickUnreadTopicFromSummary([e('', 1, '2026-01-01T00:00:00Z'), e('Tax', 4, '2026-02-01T00:00:00Z')])).toBeNull()
  })

  it('opens the unread topic with the newest activity', () => {
    expect(pickUnreadTopicFromSummary([e('', 0, '2026-01-01T00:00:00Z'), e('A', 1, '2026-02-01T00:00:00Z'), e('B', 2, '2026-03-01T00:00:00Z')])).toBe('B')
  })

  it('stays on General when nothing is unread', () => {
    expect(pickUnreadTopicFromSummary([e('A', 0, '2026-02-01T00:00:00Z')])).toBeNull()
    expect(pickUnreadTopicFromSummary([])).toBeNull()
  })

  it('finds an unread topic even when no message of it is loaded (no lastAt)', () => {
    expect(pickUnreadTopicFromSummary([e('Old', 2, null)])).toBe('Old')
  })
})

describe('mergeTopicView (what the active tab shows)', () => {
  it('shows only the active topic, oldest first, one copy per id', () => {
    const held = [msg('a', '2026-01-02T00:00:00Z', 'Tax'), msg('b', '2026-01-03T00:00:00Z', null), msg('c', '2026-01-04T00:00:00Z', 'Tax')]
    const tabPages = [msg('z', '2026-01-01T00:00:00Z', 'Tax'), msg('a', '2026-01-02T00:00:00Z', 'Tax')]
    expect(mergeTopicView({ topicKey: 'Tax', held, tabPages }).map(m => m.id)).toEqual(['z', 'a', 'c'])
  })

  it('the held (live) copy wins over the tab’s own page copy', () => {
    const held = [msg('a', '2026-01-02T00:00:00Z', 'Tax', { label: 'live' })]
    const tabPages = [msg('a', '2026-01-02T00:00:00Z', 'Tax', { label: 'page' })]
    expect(mergeTopicView({ topicKey: 'Tax', held, tabPages })[0].label).toBe('live')
  })

  it('a deletion wins from either copy (R100)', () => {
    const live = msg('a', '2026-01-02T00:00:00Z', 'Tax')
    const deletedPage = msg('a', '2026-01-02T00:00:00Z', 'Tax', { deleted_at: '2026-02-01T00:00:00Z' })
    expect(mergeTopicView({ topicKey: 'Tax', held: [live], tabPages: [deletedPage] })[0].deleted_at).toBeTruthy()
    expect(mergeTopicView({ topicKey: 'Tax', held: [deletedPage], tabPages: [live] })[0].deleted_at).toBeTruthy()
  })

  it('General shows only messages with no topic', () => {
    const held = [msg('a', '2026-01-02T00:00:00Z', 'Tax'), msg('b', '2026-01-03T00:00:00Z', null), msg('c', '2026-01-04T00:00:00Z', '')]
    expect(mergeTopicView({ topicKey: '', held, tabPages: [] }).map(m => m.id)).toEqual(['b', 'c'])
  })

  it('ignores tab-page rows of another topic (defensive)', () => {
    const tabPages = [msg('x', '2026-01-01T00:00:00Z', 'Bank')]
    expect(mergeTopicView({ topicKey: 'Tax', held: [], tabPages })).toEqual([])
  })

  it('keeps a stable order for messages with the same timestamp', () => {
    const held = [msg('b', '2026-01-01T00:00:00Z', 'T'), msg('a', '2026-01-01T00:00:00Z', 'T')]
    expect(mergeTopicView({ topicKey: 'T', held, tabPages: [] }).map(m => m.id)).toEqual(['a', 'b'])
  })
})

describe('oldestCreatedAt / mergeTabPages', () => {
  it('the cursor is the oldest message of the tab’s own pages', () => {
    expect(oldestCreatedAt([])).toBeNull()
    expect(oldestCreatedAt([msg('a', '2026-03-01T00:00:00Z'), msg('b', '2026-01-01T00:00:00Z'), msg('c', '2026-02-01T00:00:00Z')])).toBe('2026-01-01T00:00:00Z')
  })

  it('folding an older page keeps one copy per id and orders oldest first', () => {
    const prev = [msg('c', '2026-03-01T00:00:00Z', 'T'), msg('d', '2026-04-01T00:00:00Z', 'T')]
    const page = [msg('a', '2026-01-01T00:00:00Z', 'T'), msg('b', '2026-02-01T00:00:00Z', 'T'), msg('c', '2026-03-01T00:00:00Z', 'T')]
    expect(mergeTabPages(prev, page).map(m => m.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('drops rows deleted while the page was loading', () => {
    const page = [msg('a', '2026-01-01T00:00:00Z', 'T'), msg('b', '2026-02-01T00:00:00Z', 'T')]
    expect(mergeTabPages([], page, new Set(['a'])).map(m => m.id)).toEqual(['b'])
  })
})

describe('applyMessageToSummary (a message arriving live)', () => {
  const base: TopicSummaryEntry[] = [{ topic: '', lastAt: '2026-01-01T00:00:00Z', unread: 0 }, { topic: 'Tax', lastAt: '2026-01-02T00:00:00Z', unread: 1 }]
  const m = (extra: Partial<{ topic: string | null; sender_type: string; message: string; read_at: string | null; deleted_at: string | null; created_at: string }> = {}) => ({
    topic: 'Tax', created_at: '2026-02-01T00:00:00Z', sender_type: 'client', message: 'hello', read_at: null, deleted_at: null, ...extra,
  })

  it('an unread client message raises that topic’s unread and moves its newest-activity time', () => {
    const next = applyMessageToSummary(base, m())!
    expect(next.find(e => e.topic === 'Tax')).toEqual({ topic: 'Tax', lastAt: '2026-02-01T00:00:00Z', unread: 2, lastUnreadAt: '2026-02-01T00:00:00Z' })
    expect(base.find(e => e.topic === 'Tax')?.unread).toBe(1) // input not mutated
  })

  it('a brand-new topic gets its tab', () => {
    const next = applyMessageToSummary(base, m({ topic: 'Lease' }))!
    expect(next.find(e => e.topic === 'Lease')).toEqual({ topic: 'Lease', lastAt: '2026-02-01T00:00:00Z', unread: 1, lastUnreadAt: '2026-02-01T00:00:00Z' })
  })

  it('a team message moves the time but is never unread', () => {
    const next = applyMessageToSummary(base, m({ sender_type: 'admin' }))!
    expect(next.find(e => e.topic === 'Tax')).toEqual({ topic: 'Tax', lastAt: '2026-02-01T00:00:00Z', unread: 1 })
  })

  it('a message with no topic belongs to General', () => {
    const next = applyMessageToSummary(base, m({ topic: null }))!
    expect(next.find(e => e.topic === '')?.unread).toBe(1)
  })

  it('a chat-event note counts as activity but not as unread', () => {
    const next = applyMessageToSummary(base, m({ message: '<!-- chat-event: kind=doc_uploaded --> uploaded' }))!
    expect(next.find(e => e.topic === 'Tax')).toEqual({ topic: 'Tax', lastAt: '2026-02-01T00:00:00Z', unread: 1 })
  })

  it('a payment-received note and a deleted message change nothing', () => {
    expect(applyMessageToSummary(base, m({ message: '<!-- chat-event: kind=payment_received --> paid' }))).toEqual(base)
    expect(applyMessageToSummary(base, m({ deleted_at: '2026-02-02T00:00:00Z' }))).toEqual(base)
  })

  it('an already-read message is not unread', () => {
    const next = applyMessageToSummary(base, m({ read_at: '2026-02-01T01:00:00Z' }))!
    expect(next.find(e => e.topic === 'Tax')?.unread).toBe(1)
  })

  it('does not move the newest-activity time backwards', () => {
    const next = applyMessageToSummary(base, m({ created_at: '2025-12-01T00:00:00Z' }))!
    expect(next.find(e => e.topic === 'Tax')?.lastAt).toBe('2026-01-02T00:00:00Z')
  })

  it('leaves a list that has not loaded yet alone', () => {
    expect(applyMessageToSummary(undefined, m())).toBeUndefined()
    expect(applyMessageToSummary(null, m())).toBeNull()
  })
})

describe('foldFirstPage (the tab’s newest page was refetched)', () => {
  const rows = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => msg(`m${from + i}`, `2026-01-${String(from + i).padStart(2, '0')}T00:00:00Z`, 'T'))
  const SIZE = 5

  it('a reply slides the page by one: the row it no longer covers joins the older pages (history is kept)', () => {
    const prev = rows(10, 14)           // m10..m14
    const next = rows(11, 15)           // m11..m15 (one new message)
    const older = rows(1, 9)            // history the reader loaded
    const r = foldFirstPage({ prevFirst: prev, nextFirst: next, older, pageSize: SIZE })
    expect(r.dropped).toBe(false)
    expect(r.older.map(m => m.id)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10'])
  })

  it('more than a page of new messages arrived (no overlap): a real hole, so the older pages are dropped', () => {
    const r = foldFirstPage({ prevFirst: rows(10, 14), nextFirst: rows(20, 24), older: rows(1, 9), pageSize: SIZE })
    expect(r).toEqual({ older: [], dropped: true })
  })

  it('a short new page means the whole topic fits in it: nothing older exists', () => {
    const r = foldFirstPage({ prevFirst: rows(10, 14), nextFirst: rows(11, 13), older: rows(1, 9), pageSize: SIZE })
    expect(r).toEqual({ older: [], dropped: false })
  })

  it('a row inside the new page’s range that is missing from it was deleted and does not come back', () => {
    const prev = rows(10, 14)
    const next = [...rows(10, 11), ...rows(13, 15)] // m12 deleted, m15 new
    const r = foldFirstPage({ prevFirst: prev, nextFirst: next, older: [], pageSize: SIZE })
    expect(r.older).toEqual([])
  })

  it('first load (no previous page) keeps the older pages as they are', () => {
    const older = rows(1, 3)
    expect(foldFirstPage({ prevFirst: null, nextFirst: rows(10, 14), older, pageSize: SIZE })).toEqual({ older, dropped: false })
  })

  it('an unchanged page changes nothing', () => {
    const r = foldFirstPage({ prevFirst: rows(10, 14), nextFirst: rows(10, 14), older: rows(1, 3), pageSize: SIZE })
    expect(r.older.map(m => m.id)).toEqual(['m1', 'm2', 'm3'])
  })
})

describe('newest unread message decides the topic to open on', () => {
  it('opens the topic whose NEWEST UNREAD message is newest, not the topic with the newest message', () => {
    const summary = buildTopicSummary({
      namedRows: [
        { topic: 'A', created_at: '2026-05-05T00:00:00Z' }, // newest message overall, but its unread one is old
        { topic: 'B', created_at: '2026-04-02T00:00:00Z' },
      ],
      generalLastAt: null,
      unreadRows: [
        { topic: 'A', created_at: '2026-04-01T00:00:00Z' },
        { topic: 'B', created_at: '2026-04-02T00:00:00Z' },
      ],
    })
    expect(summary.find(e => e.topic === 'A')?.lastUnreadAt).toBe('2026-04-01T00:00:00Z')
    expect(pickUnreadTopicFromSummary(summary)).toBe('B')
  })

  it('a live unread message moves the newest-unread time forward', () => {
    const base: TopicSummaryEntry[] = [{ topic: 'A', lastAt: '2026-01-01T00:00:00Z', unread: 1, lastUnreadAt: '2026-01-01T00:00:00Z' }]
    const next = applyMessageToSummary(base, { topic: 'A', created_at: '2026-02-01T00:00:00Z', sender_type: 'client', message: 'x', read_at: null, deleted_at: null })!
    expect(next[0].lastUnreadAt).toBe('2026-02-01T00:00:00Z')
  })
})
