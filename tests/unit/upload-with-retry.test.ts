import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchWithNetworkRetry } from '@/lib/chat/upload-with-retry'

/**
 * Covers the 2026-09-01 fix (dev job 62a64f2b child): the original team-chat
 * retry (commit ed51c8f7) reacted only to a THROWN fetch error. A stalled
 * request that never resolves and never throws slipped through untouched,
 * leaving the caller's "uploading" state stuck forever (Senior Engineer
 * council finding — a genuine blocker, not theoretical). This module adds a
 * hard per-attempt AbortController timeout so a hang becomes a retryable
 * error instead. These tests exist specifically to PROVE that, not just to
 * exercise the happy path.
 */

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** Runs `promise` while draining every pending fake timer, so retry delays and abort timeouts resolve without a real wait. */
async function flush<T>(promise: Promise<T>): Promise<T> {
  let settled = false
  let result: T
  let failure: unknown
  promise.then(r => { settled = true; result = r }, e => { settled = true; failure = e })
  for (let i = 0; i < 30 && !settled; i++) {
    await vi.advanceTimersByTimeAsync(6000)
  }
  if (failure) throw failure
  return result!
}

describe('fetchWithNetworkRetry', () => {
  it('returns the response on the first successful attempt with no retry', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await flush(fetchWithNetworkRetry('/x', { method: 'GET' }))
    expect(res.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries a thrown network error and succeeds on a later attempt', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await flush(fetchWithNetworkRetry('/x', { method: 'GET' }))
    expect(res.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('throws after exhausting the default 4 attempts', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    vi.stubGlobal('fetch', fetchMock)

    await expect(flush(fetchWithNetworkRetry('/x', { method: 'GET' }))).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('a STALLED request (never resolves, never throws) is aborted after the per-attempt timeout and retried — the exact hang this module exists to fix', async () => {
    let callCount = 0
    // Mock fetch: the FIRST call hangs forever unless its AbortSignal fires;
    // the SECOND call succeeds immediately. This simulates a stalled
    // connection (e.g. mid-handshake wifi reassociation) rather than a fetch
    // that throws right away.
    const fetchMock = vi.fn().mockImplementation((_input: string, init?: RequestInit) => {
      callCount++
      if (callCount === 1) {
        return new Promise<Response>((resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
          // Deliberately never resolves/rejects on its own — only the abort fires.
        })
      }
      return Promise.resolve(jsonResponse({ ok: true }))
    })
    vi.stubGlobal('fetch', fetchMock)

    const res = await flush(fetchWithNetworkRetry('/x', { method: 'GET' }, { attemptTimeoutMs: 6000 }))
    expect(res.ok).toBe(true)
    // Proves the hang was cut off (not left to block forever) and a second
    // attempt actually ran.
    expect(callCount).toBe(2)
  })

  it('a request that stalls on EVERY attempt still resolves to a thrown error, not an infinite hang', async () => {
    const fetchMock = vi.fn().mockImplementation((_input: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      flush(fetchWithNetworkRetry('/x', { method: 'GET' }, { attempts: 2, attemptTimeoutMs: 6000, baseDelayMs: 500, maxDelayMs: 500 })),
    ).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not retry past a caller-specified attempt count', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      flush(fetchWithNetworkRetry('/x', { method: 'GET' }, { attempts: 2, baseDelayMs: 100, maxDelayMs: 100 })),
    ).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
