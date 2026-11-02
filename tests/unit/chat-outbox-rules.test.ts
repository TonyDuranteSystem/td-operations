import { describe, expect, it } from 'vitest'
import { isPermanentStatus, localMessage, retryDelayMs, sendOrder, withOutbox, type OutboxItem } from '@/lib/talk/outbox-rules'
import { newClientId, parseClientId } from '@/lib/chat/client-id'
import { PermanentError, isPermanentError } from '@/lib/chat/upload-with-retry'

const item = (over: Partial<OutboxItem> = {}): OutboxItem => ({
  id: 'a', scope: 'talk:t1', target: { kind: 'talk', threadId: 't1' }, senderId: 'u1', senderName: 'You', text: 'hi', files: [], replyToId: null, replyPreview: null,
  createdAt: '2026-11-02T14:00:00.000Z', uploaded: [], state: 'pending', attempts: 0, ...over,
})

describe('retryDelayMs', () => {
  it('starts at 3 s, doubles, never passes 30 s', () => {
    expect(retryDelayMs(0)).toBe(3000)
    expect(retryDelayMs(1)).toBe(6000)
    expect(retryDelayMs(2)).toBe(12000)
    expect(retryDelayMs(3)).toBe(24000)
    expect(retryDelayMs(4)).toBe(30000)
    expect(retryDelayMs(50)).toBe(30000)
  })
  it('treats a bad number like the first try', () => {
    expect(retryDelayMs(-3)).toBe(3000)
    expect(retryDelayMs(Number.NaN)).toBe(3000)
  })
})

describe('isPermanentStatus', () => {
  it('a "no" about the message is permanent', () => {
    for (const s of [400, 401, 403, 404, 413, 422]) expect(isPermanentStatus(s)).toBe(true)
  })
  it('busy, slow, overloaded or broken server may pass', () => {
    for (const s of [408, 429, 500, 502, 503, 504]) expect(isPermanentStatus(s)).toBe(false)
  })
})

describe('sendOrder', () => {
  it('oldest first, without changing the list it was given', () => {
    const list = [item({ id: 'b', createdAt: '2026-11-02T14:00:02.000Z' }), item({ id: 'a', createdAt: '2026-11-02T14:00:01.000Z' })]
    expect(sendOrder(list).map(i => i.id)).toEqual(['a', 'b'])
    expect(list.map(i => i.id)).toEqual(['b', 'a'])
  })
})

describe('localMessage', () => {
  it('a fresh message is "sending", one that found no connection is "waiting", a refused one is "failed"', () => {
    expect(localMessage(item()).local?.state).toBe('sending')
    expect(localMessage(item({ attempts: 2 })).local?.state).toBe('waiting')
    const f = localMessage(item({ state: 'failed', error: 'File too large.' }))
    expect(f.local?.state).toBe('failed')
    expect(f.local?.error).toBe('File too large.')
  })
  it('keeps the id, the words, the time and the quote; names voice notes and files', () => {
    const m = localMessage(item({ id: 'x1', text: 'look', replyToId: 'q', files: [{ name: 'note.m4a', type: 'audio/mp4', blob: new Blob(['a']) }, { name: 'a.pdf', type: 'application/pdf', blob: new Blob(['b']) }] }))
    expect(m.id).toBe('x1')
    expect(m.message).toBe('look')
    expect(m.created_at).toBe('2026-11-02T14:00:00.000Z')
    expect(m.reply_to_id).toBe('q')
    expect(m.attachments).toBeNull()
    expect(m.local?.files).toEqual([{ name: 'note.m4a', voice: true }, { name: 'a.pdf', voice: false }])
  })
})

describe('withOutbox', () => {
  const server = [{ id: 's1', sender_id: 'u1', sender_name: 'Me', message: 'old', created_at: '2026-11-02T13:00:00.000Z' }]
  it('puts the waiting messages after the chat', () => {
    const out = withOutbox(server, [localMessage(item({ id: 'w1' }))])
    expect(out.map(m => m.id)).toEqual(['s1', 'w1'])
  })
  it('drops a waiting message once the server copy (same id) is in the chat', () => {
    const out = withOutbox([...server, { ...server[0], id: 'w1', message: 'hi' }], [localMessage(item({ id: 'w1' }))])
    expect(out.map(m => m.id)).toEqual(['s1', 'w1'])
    expect(out[1].local).toBeUndefined()
  })
  it('returns the chat untouched when nothing waits', () => {
    expect(withOutbox(server, [])).toBe(server)
  })
})

describe('client ids', () => {
  it('a new id is a uuid the server accepts', () => {
    const id = newClientId()
    expect(parseClientId(id)).toBe(id.toLowerCase())
    expect(newClientId()).not.toBe(id)
  })
  it('refuses anything that is not a uuid', () => {
    for (const v of [null, undefined, 42, '', 'abc', 'g0000000-0000-4000-8000-000000000000', '../../x', '00000000-0000-4000-8000-00000000000']) expect(parseClientId(v)).toBeNull()
  })
  it('accepts upper case and returns lower case', () => {
    expect(parseClientId('AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE')).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
  })
})

describe('PermanentError', () => {
  it('is recognised, an ordinary error is not', () => {
    expect(isPermanentError(new PermanentError('too big'))).toBe(true)
    expect(isPermanentError(new Error('offline'))).toBe(false)
    expect(isPermanentError(null)).toBe(false)
  })
})
