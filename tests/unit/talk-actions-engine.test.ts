import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enqueueAction, flushActions, onActionDone, onActionFailed, resetActionsForTests, waitingActions } from '@/lib/talk/outbox-actions'
import type { ChatAction } from '@/lib/talk/outbox-actions-rules'

const mk = (over: Partial<ChatAction> & { kind: ChatAction['kind'] }): ChatAction => ({
  id: 'a1', messageId: 'm1', threadId: 't1', senderId: 'u1', createdAt: '2026-11-03T12:00:00.000Z', attempts: 0, text: 'new', emoji: '👍', on: true, ...over,
}) as unknown as ChatAction
const okRes = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response
const errRes = (status: number, error = 'nope') => ({ ok: false, status, json: async () => ({ error }) }) as unknown as Response

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => { vi.useFakeTimers(); resetActionsForTests(); fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock) })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('queued changes: sending', () => {
  it('an edit goes out as PATCH and the server answer is handed over once', async () => {
    fetchMock.mockResolvedValueOnce(okRes({ message: { message: 'new', edited_at: 'x' } }))
    const done = vi.fn(); onActionDone(done)
    await enqueueAction(mk({ kind: 'edit' }))
    await vi.runAllTimersAsync()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/team/messages/m1')
    expect((init as RequestInit).method).toBe('PATCH')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ message: 'new' })
    expect(done).toHaveBeenCalledTimes(1)
    expect(waitingActions('t1')).toHaveLength(0)
  })

  it('a delete goes out as DELETE; a reaction as a SET (on), never a blind toggle', async () => {
    fetchMock.mockResolvedValue(okRes({}))
    await enqueueAction(mk({ kind: 'delete', id: 'd1', messageId: 'm2' }))
    await enqueueAction(mk({ kind: 'react', id: 'r1', messageId: 'm3', createdAt: '2026-11-03T12:01:00.000Z' }))
    await vi.runAllTimersAsync()
    const calls = fetchMock.mock.calls.map(c => [c[0], (c[1] as RequestInit).method, (c[1] as RequestInit).body])
    expect(calls).toContainEqual(['/api/team/messages/m2', 'DELETE', undefined])
    const reactCall = calls.find(c => c[0] === '/api/team/messages/m3/react')!
    expect(reactCall[1]).toBe('POST')
    expect(JSON.parse(reactCall[2] as string)).toEqual({ emoji: '👍', on: true })
  })

  it('no connection keeps the change and sends it later, once', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(okRes({ message: { message: 'new', edited_at: 'x' } }))
    const done = vi.fn(); onActionDone(done)
    await enqueueAction(mk({ kind: 'edit' }))
    await vi.advanceTimersByTimeAsync(10)
    expect(waitingActions('t1')).toHaveLength(1)
    expect(waitingActions('t1')[0].attempts).toBe(1)
    expect(done).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(3100)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(done).toHaveBeenCalledTimes(1)
    expect(waitingActions('t1')).toHaveLength(0)
  })

  it('a busy server (503) is tried again; a refusal (403) drops the change and says why', async () => {
    fetchMock.mockResolvedValueOnce(errRes(503, 'busy'))
    await enqueueAction(mk({ kind: 'edit' }))
    await vi.advanceTimersByTimeAsync(10)
    expect(waitingActions('t1')).toHaveLength(1)
    fetchMock.mockResolvedValueOnce(errRes(403, 'You can only edit your own messages.'))
    const failed = vi.fn(); onActionFailed(failed)
    await vi.advanceTimersByTimeAsync(3100)
    expect(failed).toHaveBeenCalledTimes(1)
    expect(failed.mock.calls[0][1]).toBe('You can only edit your own messages.')
    expect(waitingActions('t1')).toHaveLength(0)
  })

  it('only the person who made a change sends it', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    await enqueueAction(mk({ kind: 'delete', senderId: 'u1' }))
    await vi.advanceTimersByTimeAsync(10)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    fetchMock.mockClear()
    await flushActions('someone-else')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(waitingActions('t1')).toHaveLength(1)
  })
})
