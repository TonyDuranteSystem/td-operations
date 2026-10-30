import { describe, expect, it } from 'vitest'
import { MANY_PHRASE, catchUpSpeech, threadsWithNewUnread, unreadBaseline, type CatchUpThread } from '@/lib/talk/catch-up'
import { TALK_FEATURE_PHRASE } from '@/lib/talk/voice-alert'

const dm = (id: string, unread: number | string, sender = 'Luca Rossi'): CatchUpThread => ({ id, thread_type: 'dm', unread_count: unread, last_sender_name: sender })
const group = (id: string, unread: number, label = 'Team'): CatchUpThread => ({ id, thread_type: 'group', unread_count: unread, label })

describe('unreadBaseline', () => {
  it('keeps only direct and group chats, and reads a numeric string', () => {
    const b = unreadBaseline([dm('a', '2'), group('g', 1), { id: 'c', thread_type: 'channel', unread_count: 9 }])
    expect(b).toEqual({ a: 2, g: 1 })
  })
})

describe('threadsWithNewUnread', () => {
  it('says nothing on the first look (it only sets the starting point)', () => {
    expect(threadsWithNewUnread(null, [dm('a', 3)])).toEqual([])
  })
  it('finds a chat whose unread went up, and a chat that was new with unread', () => {
    const r = threadsWithNewUnread({ a: 1 }, [dm('a', 2), dm('b', 1), dm('c', 0)])
    expect(r.map(t => t.id)).toEqual(['a', 'b'])
  })
  it('ignores a chat that stayed the same or went down (read elsewhere)', () => {
    expect(threadsWithNewUnread({ a: 2, b: 3 }, [dm('a', 2), dm('b', 0)])).toEqual([])
  })
  it('leaves out the open chat and the chats the live connection already announced', () => {
    const r = threadsWithNewUnread({}, [dm('a', 1), dm('b', 1), dm('c', 1)], { openThreadId: 'a', suppress: new Set(['b']) })
    expect(r.map(t => t.id)).toEqual(['c'])
  })
  it('ignores channels and other thread types', () => {
    expect(threadsWithNewUnread({}, [{ id: 'x', thread_type: 'channel', unread_count: 4 }])).toEqual([])
  })
})

describe('catchUpSpeech', () => {
  it('says nothing for no chats', () => { expect(catchUpSpeech([])).toBeNull() })
  it('one direct chat: the sender, same words the live connection uses', () => {
    expect(catchUpSpeech([dm('a', 1)])).toEqual({ senderName: 'Luca Rossi', identity: 'a' })
  })
  it('the New implementation group: its own phrase', () => {
    expect(catchUpSpeech([group('g', 1, 'New implementation')])).toEqual({ senderName: null, identity: 'g', override: TALK_FEATURE_PHRASE })
  })
  it('an ordinary group: the last sender', () => {
    expect(catchUpSpeech([{ ...group('g', 1), last_sender_name: 'Jodi' }])).toEqual({ senderName: 'Jodi', identity: 'g' })
  })
  it('several chats: one line, never a stream', () => {
    expect(catchUpSpeech([dm('a', 1), dm('b', 1)])).toEqual({ senderName: null, identity: 'many', override: MANY_PHRASE })
  })
})
