import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const uploadTeam = vi.fn()
const uploadLead = vi.fn()
vi.mock('@/lib/team/attachment', () => ({ uploadTeamAttachment: (...a: unknown[]) => uploadTeam(...a) }))
vi.mock('@/lib/marketing/lead-chat-upload', () => ({ uploadLeadAttachment: (...a: unknown[]) => uploadLead(...a) }))

import { enqueueMessage, flushOutbox, onOutboxSent, resetOutboxForTests, retryMessage, discardMessage, waitingFor } from '@/lib/talk/outbox'
import { PermanentError } from '@/lib/chat/upload-with-retry'
import type { OutboxItem } from '@/lib/talk/outbox-rules'

const mk = (over: Partial<OutboxItem> = {}): OutboxItem => ({
  id: '11111111-1111-4111-8111-111111111111', scope: 'talk:t1', target: { kind: 'talk', threadId: 't1' }, senderId: 'u1', senderName: 'You', text: 'hello', files: [], replyToId: null, replyPreview: null,
  createdAt: '2026-11-02T14:00:00.000Z', uploaded: [], state: 'pending', attempts: 0, ...over,
})
const okRes = (message: unknown) => ({ ok: true, status: 200, json: async () => ({ message }) }) as unknown as Response
const errRes = (status: number, error = 'nope') => ({ ok: false, status, json: async () => ({ error }) }) as unknown as Response

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  vi.useFakeTimers()
  resetOutboxForTests()
  uploadTeam.mockReset(); uploadLead.mockReset()
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('outbox engine', () => {
  it('sends a message under its own id and hands the server copy over', async () => {
    fetchMock.mockResolvedValueOnce(okRes({ id: '11111111-1111-4111-8111-111111111111', message: 'hello' }))
    const sent = vi.fn(); onOutboxSent(sent)
    await enqueueMessage(mk())
    await vi.runAllTimersAsync()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/team/threads/t1/messages')
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({ message: 'hello', client_id: '11111111-1111-4111-8111-111111111111', sender_id: 'u1', attachments: null })
    expect(sent).toHaveBeenCalledTimes(1)
    expect(waitingFor('talk:t1')).toHaveLength(0)
  })

  it('keeps a message that found no connection and sends it by itself later, once', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(okRes({ id: 'x' }))
    const sent = vi.fn(); onOutboxSent(sent)
    await enqueueMessage(mk())
    await vi.advanceTimersByTimeAsync(10)
    expect(waitingFor('talk:t1')).toHaveLength(1)
    expect(waitingFor('talk:t1')[0].attempts).toBe(1)
    expect(sent).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(3100)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(sent).toHaveBeenCalledTimes(1)
    expect(waitingFor('talk:t1')).toHaveLength(0)
  })

  it('a server error (5xx) is tried again; a refusal (4xx) stops and shows the reason', async () => {
    fetchMock.mockResolvedValueOnce(errRes(503, 'busy'))
    await enqueueMessage(mk())
    await vi.advanceTimersByTimeAsync(10)
    expect(waitingFor('talk:t1')[0].state).toBe('pending')
    fetchMock.mockResolvedValueOnce(errRes(403, 'You are not part of this conversation.'))
    await vi.advanceTimersByTimeAsync(3100)
    const it1 = waitingFor('talk:t1')[0]
    expect(it1.state).toBe('failed')
    expect(it1.error).toBe('You are not part of this conversation.')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchMock).toHaveBeenCalledTimes(2) // a refused message is not tried again by itself
  })

  it('Retry sends a refused message again; Delete forgets it', async () => {
    fetchMock.mockResolvedValueOnce(errRes(400, 'bad'))
    await enqueueMessage(mk())
    await vi.advanceTimersByTimeAsync(10)
    expect(waitingFor('talk:t1')[0].state).toBe('failed')
    fetchMock.mockResolvedValueOnce(okRes({ id: 'x' }))
    await retryMessage('11111111-1111-4111-8111-111111111111', 'u1')
    await vi.advanceTimersByTimeAsync(10)
    expect(waitingFor('talk:t1')).toHaveLength(0)

    fetchMock.mockResolvedValueOnce(errRes(400, 'bad'))
    await enqueueMessage(mk({ id: '22222222-2222-4222-8222-222222222222' }))
    await vi.advanceTimersByTimeAsync(10)
    await discardMessage('22222222-2222-4222-8222-222222222222')
    expect(waitingFor('talk:t1')).toHaveLength(0)
  })

  it('a message deleted while its files are still going up is never posted', async () => {
    let release: (v: unknown) => void = () => {}
    uploadTeam.mockImplementation(() => new Promise(r => { release = r }))
    await enqueueMessage(mk({ text: '', files: [{ name: 'note.m4a', type: 'audio/mp4', blob: new Blob(['abc']) }] }))
    await vi.advanceTimersByTimeAsync(10)
    await discardMessage('11111111-1111-4111-8111-111111111111')
    release({ url: 'https://x/y.m4a', name: 'note.m4a' })
    await vi.advanceTimersByTimeAsync(10)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(waitingFor('talk:t1')).toHaveLength(0)
  })

  it('uploads a voice note once, even when the message needs a second try', async () => {
    uploadTeam.mockResolvedValue({ url: 'https://x/y.m4a', name: 'note.m4a' })
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(okRes({ id: 'x' }))
    const file = { name: 'note.m4a', type: 'audio/mp4', blob: new Blob(['abc']) }
    await enqueueMessage(mk({ text: '', files: [file] }))
    await vi.advanceTimersByTimeAsync(10)
    await vi.advanceTimersByTimeAsync(3100)
    expect(uploadTeam).toHaveBeenCalledTimes(1)
    const body = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string)
    expect(body.attachments).toEqual([{ url: 'https://x/y.m4a', name: 'note.m4a' }])
  })

  it('a file that can never be uploaded (too big) fails at once, with its reason', async () => {
    uploadTeam.mockRejectedValue(new PermanentError('File too large. Maximum allowed: 25 MB.'))
    await enqueueMessage(mk({ text: '', files: [{ name: 'big.mov', type: 'video/quicktime', blob: new Blob(['x']) }] }))
    await vi.advanceTimersByTimeAsync(10)
    expect(waitingFor('talk:t1')[0]).toMatchObject({ state: 'failed', error: 'File too large. Maximum allowed: 25 MB.' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps messages of one chat in the order written: a stuck first message holds the second', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    await enqueueMessage(mk({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', text: 'one', createdAt: '2026-11-02T14:00:00.000Z' }))
    await enqueueMessage(mk({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', text: 'two', createdAt: '2026-11-02T14:00:01.000Z' }))
    await vi.advanceTimersByTimeAsync(10)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string).message).toBe('one')
  })

  it('a stuck chat does not hold another chat', async () => {
    fetchMock.mockImplementation(async (url: string) => (String(url).includes('/t1/') ? Promise.reject(new TypeError('Failed to fetch')) : okRes({ id: 'ok' })))
    const sent = vi.fn(); onOutboxSent(sent)
    await enqueueMessage(mk({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', createdAt: '2026-11-02T14:00:00.000Z' }))
    await enqueueMessage(mk({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', scope: 'talk:t2', target: { kind: 'talk', threadId: 't2' }, createdAt: '2026-11-02T14:00:01.000Z' }))
    await vi.advanceTimersByTimeAsync(10)
    expect(sent).toHaveBeenCalledTimes(1)
    expect(waitingFor('talk:t1')).toHaveLength(1)
  })

  it('never sends somebody else\'s message as the signed-in person', async () => {
    fetchMock.mockResolvedValue(okRes({ id: 'x' }))
    await enqueueMessage(mk({ senderId: 'luca' }))
    await vi.advanceTimersByTimeAsync(10)
    fetchMock.mockClear()
    await flushOutbox('antonio')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a marketing message goes to its own address with its lane', async () => {
    fetchMock.mockResolvedValueOnce(okRes({ id: 'x' }))
    await enqueueMessage(mk({ scope: 'lead:/api/marketing/chat:L1:owners', target: { kind: 'lead', api: '/api/marketing/chat', id: 'L1', laneQs: '?lane=owners' } }))
    await vi.advanceTimersByTimeAsync(10)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/marketing/chat/L1/messages?lane=owners')
  })
})
