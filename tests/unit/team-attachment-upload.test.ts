import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { uploadTeamAttachment } from '@/lib/team/attachment'

/**
 * Covers the 2026-08-31 fix (Luca's td-bug "Failed to fetch" report): a
 * network-level failure on either fetch in uploadTeamAttachment is quietly
 * retried before it reaches the user, a completed-but-bad-status response is
 * NOT retried (it's a real answer, not a blip), and an exhausted retry both
 * reports itself to /api/system-errors/report and throws a friendly,
 * actionable message instead of the raw browser error.
 */

function file(name = 'screenshot.png', type = 'image/png', bytes = 'x'): File {
  return new File([bytes], name, { type })
}

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response
}

beforeEach(() => {
  vi.useFakeTimers()
  // reportTeamAttachmentError reads window.location.pathname — this suite runs
  // under vitest's default `node` environment, which has no window at all.
  vi.stubGlobal('window', { location: { pathname: '/team-chat' } })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** Runs `promise` while draining every pending fake timer, so retry delays resolve without a real wait. */
async function flush<T>(promise: Promise<T>): Promise<T> {
  let settled = false
  let result: T
  let failure: unknown
  promise.then(r => { settled = true; result = r }, e => { settled = true; failure = e })
  for (let i = 0; i < 20 && !settled; i++) {
    await vi.advanceTimersByTimeAsync(5000)
  }
  if (failure) throw failure
  return result!
}

describe('uploadTeamAttachment — network retry + reporting', () => {
  it('succeeds on the first try with no retry needed', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ signedUrl: 'https://x.supabase.co/upload/sign/abc', publicUrl: 'https://x.supabase.co/public/abc.png' }))
      .mockResolvedValueOnce({ ok: true, status: 200 } as Response)
    vi.stubGlobal('fetch', fetchMock)

    const result = await flush(uploadTeamAttachment(file(), 'thread-1'))
    expect(result.url).toBe('https://x.supabase.co/public/abc.png')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('recovers from a network blip on the storage PUT without the user seeing an error', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ signedUrl: 'https://x.supabase.co/upload/sign/abc', publicUrl: 'https://x.supabase.co/public/abc.png' }))
      // First PUT attempt: raw browser network failure (the exact symptom reported).
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      // Retry succeeds.
      .mockResolvedValueOnce({ ok: true, status: 200 } as Response)
    vi.stubGlobal('fetch', fetchMock)

    const result = await flush(uploadTeamAttachment(file(), 'thread-1'))
    expect(result.url).toBe('https://x.supabase.co/public/abc.png')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('after retries are exhausted, throws a friendly message and reports the failure', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ signedUrl: 'https://x.supabase.co/upload/sign/abc', publicUrl: 'https://x.supabase.co/public/abc.png' }))
      // All 4 PUT attempts fail at the network level (shared retry default,
      // lib/chat/upload-with-retry.ts — 2026-09-01, dev job 62a64f2b child).
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      // The best-effort report call.
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true }) } as Response)
    vi.stubGlobal('fetch', fetchMock)

    await expect(flush(uploadTeamAttachment(file(), 'thread-1'))).rejects.toThrow(
      /connection was interrupted.*still here.*press Send/i,
    )

    const reportCall = fetchMock.mock.calls.find(c => c[0] === '/api/system-errors/report')
    expect(reportCall).toBeTruthy()
    const reportBody = JSON.parse(reportCall![1].body)
    expect(reportBody.route).toBe('team-chat:upload-put')
    expect(reportBody.context).toEqual({ thread_id: 'thread-1', file_name: 'screenshot.png' })
  })

  it('does NOT retry a completed error response (e.g. file too large) — that is a real answer, not a blip', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ signedUrl: 'https://x.supabase.co/upload/sign/abc', publicUrl: 'https://x.supabase.co/public/abc.png' }))
      .mockResolvedValueOnce({ ok: false, status: 413 } as Response)
    vi.stubGlobal('fetch', fetchMock)

    await expect(flush(uploadTeamAttachment(file(), 'thread-1'))).rejects.toThrow(/File too large/)
    // Exactly 2 calls (mint + one PUT) — no retry on a real completed response.
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('recovers from a network blip on minting the signed URL itself', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(jsonResponse({ signedUrl: 'https://x.supabase.co/upload/sign/abc', publicUrl: 'https://x.supabase.co/public/abc.png' }))
      .mockResolvedValueOnce({ ok: true, status: 200 } as Response)
    vi.stubGlobal('fetch', fetchMock)

    const result = await flush(uploadTeamAttachment(file(), 'thread-1'))
    expect(result.url).toBe('https://x.supabase.co/public/abc.png')
  })

  it('reporting failure never surfaces to the caller — the original error still wins', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ signedUrl: 'https://x.supabase.co/upload/sign/abc', publicUrl: 'https://x.supabase.co/public/abc.png' }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      // The report POST itself fails — must not change the thrown error or crash.
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    vi.stubGlobal('fetch', fetchMock)

    await expect(flush(uploadTeamAttachment(file(), 'thread-1'))).rejects.toThrow(/connection was interrupted/i)
  })
})
