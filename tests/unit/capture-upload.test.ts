import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { uploadCapture } from '@/lib/captures/upload'

/**
 * Covers the shared capture upload engine (Antonio, 2026-09-04: "only one
 * working machinery") — three-step flow (mint signed URL -> PUT bytes ->
 * finalize/log), each step wrapped in the SAME shared network-retry primitive
 * lib/team/attachment.ts already proved out (lib/chat/upload-with-retry.ts),
 * so this suite mirrors tests/unit/team-attachment-upload.test.ts's shape —
 * a network-level failure is quietly retried, a completed bad-status response
 * is not, and an exhausted retry reports itself and throws a friendly,
 * actionable message instead of the raw browser error.
 */

function file(name = 'screenshot.png', type = 'image/png', bytes = 'x'): File {
  return new File([bytes], name, { type })
}

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response
}

const MINT_OK = jsonResponse({ signedUrl: 'https://x.supabase.co/upload/sign/abc', token: 'tok', path: 'captures/abc.png' })
const FINALIZE_OK = jsonResponse({ capture: { id: 'cap-1', title: 'Test capture', image_url: 'captures/abc.png' } })

beforeEach(() => {
  vi.useFakeTimers()
  // reportCaptureError reads window.location.pathname — this suite runs under
  // vitest's default `node` environment, which has no window at all.
  vi.stubGlobal('window', { location: { pathname: '/accounts/123' } })
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

describe('uploadCapture — validation before any network call', () => {
  it('rejects a missing title without calling fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(uploadCapture({ file: file(), title: '   ' })).rejects.toThrow(/title is required/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a blocked file type without calling fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      uploadCapture({ file: file('malware.exe', 'application/x-msdownload'), title: 'x' }),
    ).rejects.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('uploadCapture — network retry + reporting', () => {
  it('succeeds on the first try with no retry needed', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(MINT_OK)
      .mockResolvedValueOnce({ ok: true, status: 200 } as Response)
      .mockResolvedValueOnce(FINALIZE_OK)
    vi.stubGlobal('fetch', fetchMock)

    const result = await flush(uploadCapture({ file: file(), title: 'Test capture', note: 'a note' }))
    expect(result.id).toBe('cap-1')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('recovers from a network blip on the storage PUT without the user seeing an error', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(MINT_OK)
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ ok: true, status: 200 } as Response)
      .mockResolvedValueOnce(FINALIZE_OK)
    vi.stubGlobal('fetch', fetchMock)

    const result = await flush(uploadCapture({ file: file(), title: 'Test capture' }))
    expect(result.id).toBe('cap-1')
  })

  it('recovers from a network blip minting the signed URL itself', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(MINT_OK)
      .mockResolvedValueOnce({ ok: true, status: 200 } as Response)
      .mockResolvedValueOnce(FINALIZE_OK)
    vi.stubGlobal('fetch', fetchMock)

    const result = await flush(uploadCapture({ file: file(), title: 'Test capture' }))
    expect(result.id).toBe('cap-1')
  })

  it('recovers from a network blip on the finalize/log call, after bytes already uploaded', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(MINT_OK)
      .mockResolvedValueOnce({ ok: true, status: 200 } as Response)
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(FINALIZE_OK)
    vi.stubGlobal('fetch', fetchMock)

    const result = await flush(uploadCapture({ file: file(), title: 'Test capture' }))
    expect(result.id).toBe('cap-1')
  })

  it('after PUT retries are exhausted, throws a friendly message and reports the failure', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(MINT_OK)
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true }) } as Response)
    vi.stubGlobal('fetch', fetchMock)

    await expect(flush(uploadCapture({ file: file(), title: 'Test capture' }))).rejects.toThrow(
      /connection was interrupted/i,
    )

    const reportCall = fetchMock.mock.calls.find(c => c[0] === '/api/system-errors/report')
    expect(reportCall).toBeTruthy()
    const reportBody = JSON.parse(reportCall![1].body)
    expect(reportBody.route).toBe('captures:upload-put')
  })

  it('after the bytes upload but the finalize/log step is exhausted, says the picture is saved but logging failed — never implies the picture is lost', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(MINT_OK)
      .mockResolvedValueOnce({ ok: true, status: 200 } as Response)
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true }) } as Response)
    vi.stubGlobal('fetch', fetchMock)

    await expect(flush(uploadCapture({ file: file(), title: 'Test capture' }))).rejects.toThrow(
      /uploaded, but saving it failed/i,
    )
  })

  it('does NOT retry a completed error response (e.g. file too large) — that is a real answer, not a blip', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(MINT_OK)
      .mockResolvedValueOnce({ ok: false, status: 413 } as Response)
    vi.stubGlobal('fetch', fetchMock)

    await expect(flush(uploadCapture({ file: file(), title: 'Test capture' }))).rejects.toThrow(/too large/i)
    // Exactly 2 calls (mint + one PUT) — no retry, and finalize never runs.
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('reporting failure never surfaces to the caller — the original error still wins', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(MINT_OK)
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      // The report POST itself fails — must not change the thrown error or crash.
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    vi.stubGlobal('fetch', fetchMock)

    await expect(flush(uploadCapture({ file: file(), title: 'Test capture' }))).rejects.toThrow(
      /connection was interrupted/i,
    )
  })
})
