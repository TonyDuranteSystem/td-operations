/**
 * TD Talk "Back to the list is slow" (dev job cf265457): the light chat list, the unread number cleared on the list, and the small remember-for-a-while holder.
 * The two screen behaviours (clear on open, refresh on Back) are covered by the browser run recorded in docs/systems/talk.md; what is pinned here is the logic.
 */
import { describe, it, expect, vi } from 'vitest'
import { CHAT_LIST_SCOPE, CHAT_LIST_URL, chatRows, wantsChatsOnly, withUnreadCleared } from '@/lib/talk/chat-list-scope'
import { createTtlOnce } from '@/lib/ttl-once'
import type { TalkThread } from '@/lib/talk/chat-model'

const thread = (id: string, over: Partial<TalkThread> = {}): TalkThread => ({
  id, thread_type: 'dm', dm_key: null, archived_at: null, last_activity_at: null, ...over,
})

describe('wantsChatsOnly / CHAT_LIST_URL', () => {
  it('the URL TD Talk asks for is recognised by the server', () => {
    expect(CHAT_LIST_URL).toBe(`/api/team/threads?scope=${CHAT_LIST_SCOPE}`)
    expect(wantsChatsOnly(CHAT_LIST_URL)).toBe(true)
    expect(wantsChatsOnly(`https://crm.tonydurante.us${CHAT_LIST_URL}`)).toBe(true)
  })
  it('every other caller (no query, another scope, other parameters) keeps the full answer', () => {
    expect(wantsChatsOnly('/api/team/threads')).toBe(false)
    expect(wantsChatsOnly('https://crm.tonydurante.us/api/team/threads')).toBe(false)
    expect(wantsChatsOnly('/api/team/threads?scope=all')).toBe(false)
    expect(wantsChatsOnly('/api/team/threads?scope=')).toBe(false)
    expect(wantsChatsOnly('/api/team/threads?x=1&scope=chat')).toBe(false)
    expect(wantsChatsOnly('/api/team/threads', )).toBe(false)
  })
  it('a parameter alongside the scope still counts', () => {
    expect(wantsChatsOnly('/api/team/threads?x=1&scope=chats')).toBe(true)
  })
  it('a garbage address never throws', () => {
    expect(wantsChatsOnly('http://')).toBe(false)
    expect(wantsChatsOnly('')).toBe(false)
  })
})

describe('chatRows', () => {
  it('keeps direct messages and groups, drops everything else, keeps order and extra fields', () => {
    const rows = [
      { id: '1', thread_type: 'discussion', label: 'Client X' },
      { id: '2', thread_type: 'dm', unread_count: 3 },
      { id: '3', thread_type: 'channel' },
      { id: '4', thread_type: 'group', title: 'Daily' },
      { id: '5', thread_type: 'general' },
      { id: '6', thread_type: null },
      { id: '7' },
    ]
    expect(chatRows(rows).map(r => r.id)).toEqual(['2', '4'])
    expect(chatRows(rows)[0]).toBe(rows[1]) // the same row object: nothing copied or trimmed
  })
  it('archived chats stay in the answer (the screen hides them itself, exactly as before)', () => {
    expect(chatRows([{ id: 'a', thread_type: 'dm', archived_at: '2026-01-01' }]).length).toBe(1)
  })
  it('an empty list is fine', () => {
    expect(chatRows([])).toEqual([])
  })
})

describe('withUnreadCleared', () => {
  it('sets only that chat to 0 and leaves the others as they are', () => {
    const list = [thread('a', { unread_count: 2 }), thread('b', { unread_count: 5 }), thread('c')]
    const out = withUnreadCleared(list, 'a')
    expect(out.map(t => t.unread_count)).toEqual([0, 5, undefined])
    expect(out[1]).toBe(list[1])
    expect(list[0].unread_count).toBe(2) // the old array is not mutated
  })
  it('returns the SAME array when there is nothing to clear (no pointless re-draw)', () => {
    const list = [thread('a', { unread_count: 0 }), thread('b')]
    expect(withUnreadCleared(list, 'a')).toBe(list)
    expect(withUnreadCleared(list, 'b')).toBe(list)
    expect(withUnreadCleared(list, 'zzz')).toBe(list)
    expect(withUnreadCleared([], 'a')).toEqual([])
  })
})

describe('createTtlOnce', () => {
  it('remembers the answer until the time is up, then loads again', async () => {
    let t = 1_000
    const once = createTtlOnce<string>(60_000, () => t)
    const load = vi.fn().mockResolvedValueOnce('first').mockResolvedValueOnce('second')
    expect(await once.get(load)).toBe('first')
    t += 59_999
    expect(await once.get(load)).toBe('first')
    expect(load).toHaveBeenCalledTimes(1)
    t += 1
    expect(await once.get(load)).toBe('second')
    expect(load).toHaveBeenCalledTimes(2)
  })
  it('callers that arrive while a load is running share it', async () => {
    const once = createTtlOnce<number>(60_000)
    let release!: (v: number) => void
    const load = vi.fn(() => new Promise<number>(res => { release = res }))
    const a = once.get(load), b = once.get(load), c = once.get(load)
    expect(load).toHaveBeenCalledTimes(1)
    release(42)
    expect(await Promise.all([a, b, c])).toEqual([42, 42, 42])
  })
  it('a failed load is not remembered: the waiting callers see the error, the next caller tries again', async () => {
    const once = createTtlOnce<string>(60_000)
    const load = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce('ok')
    await expect(once.get(load)).rejects.toThrow('down')
    expect(await once.get(load)).toBe('ok')
    expect(load).toHaveBeenCalledTimes(2)
  })
  it('clear() forgets the answer', async () => {
    const once = createTtlOnce<string>(60_000)
    const load = vi.fn().mockResolvedValueOnce('a').mockResolvedValueOnce('b')
    expect(await once.get(load)).toBe('a')
    once.clear()
    expect(await once.get(load)).toBe('b')
  })
  it('an empty-looking answer (empty list, 0, "") is remembered too', async () => {
    const once = createTtlOnce<unknown[]>(60_000)
    const load = vi.fn().mockResolvedValue([])
    await once.get(load)
    await once.get(load)
    expect(load).toHaveBeenCalledTimes(1)
  })
})
