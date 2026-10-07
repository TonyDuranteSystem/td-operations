import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  EsignUploadError,
  MULTIPART_FALLBACK_MAX_BYTES,
  describeCreateFailure,
  putAttemptTimeoutMs,
  uploadPdfToStaging,
} from '@/lib/esign/upload-staged-pdf'

/**
 * Browser side of the E-Sign direct upload. Pins: the staff member always gets a plain
 * sentence (never the generic fallback that hid the real cause for Luca on 2026-10-07),
 * every failure is reported to the error log, the PUT deadline scales with file size
 * (the shared 6 s default would abort a 20 MB upload every time), and a size problem is
 * caught before any network call.
 */

function pdf(bytes: number, name = 'return.pdf'): File {
  const f = new File(['x'], name, { type: 'application/pdf' })
  Object.defineProperty(f, 'size', { value: bytes })
  return f
}

function json(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('window', { location: { pathname: '/tools/esign/new' } })
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function settle<T>(p: Promise<T>): Promise<T> {
  // Drain retry back-off timers so a failing attempt chain finishes.
  const guard = p.catch(() => {})
  await vi.runAllTimersAsync()
  await guard
  return p
}

describe('describeCreateFailure', () => {
  it('prefers the server\'s own sentence', () => {
    expect(describeCreateFailure(400, 'Signer "X" needs an email.')).toBe('Signer "X" needs an email.')
  })
  it('names the real problem for a plain-text platform 413 (no JSON error)', () => {
    const m = describeCreateFailure(413, undefined)
    expect(m).toContain('too large')
    expect(m.toLowerCase()).toContain('compress')
  })
  it('includes the status code for any other unexplained failure', () => {
    expect(describeCreateFailure(504, undefined)).toContain('504')
    expect(describeCreateFailure(500, '', 'save the template')).toContain('save the template')
  })
  it('is never the old generic sentence on its own', () => {
    expect(describeCreateFailure(502, undefined)).not.toBe('Could not create the envelope.')
  })
})

describe('putAttemptTimeoutMs', () => {
  it('gives small files at least 30 s', () => {
    expect(putAttemptTimeoutMs(100_000)).toBe(30_000)
  })
  it('scales with size so a 25 MB upload is not aborted at 6 s', () => {
    expect(putAttemptTimeoutMs(25 * 1024 * 1024)).toBeGreaterThanOrEqual(60_000)
  })
  it('is capped at five minutes', () => {
    expect(putAttemptTimeoutMs(10 * 1024 * 1024 * 1024)).toBe(300_000)
  })
})

describe('uploadPdfToStaging', () => {
  it('uploads straight to the signed link and returns the staging path', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ signedUrl: 'https://storage.example/upload?token=t', path: 'esign-staging/u/o.pdf' }))
      .mockResolvedValueOnce({ ok: true, status: 200 } as Response)
    const r = await settle(uploadPdfToStaging(pdf(8 * 1024 * 1024)))
    expect(r).toEqual({ stagingPath: 'esign-staging/u/o.pdf' })
    const put = fetchMock.mock.calls[1]
    expect(put[0]).toBe('https://storage.example/upload?token=t')
    expect(put[1].method).toBe('PUT')
  })

  it('refuses an over-limit file before making any request', async () => {
    await expect(uploadPdfToStaging(pdf(26 * 1024 * 1024))).rejects.toThrow(/25 MB/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses an empty file before making any request', async () => {
    await expect(uploadPdfToStaging(pdf(0))).rejects.toThrow(/empty/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('shows the server\'s sentence when the link request is refused', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'Dashboard access required' }, false, 403))
    await expect(settle(uploadPdfToStaging(pdf(1000)))).rejects.toThrow('Dashboard access required')
  })

  it('a PUT the storage refuses with 413 says the file is too large and reports it', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ signedUrl: 'https://s/u', path: 'p' }))
      .mockResolvedValueOnce({ ok: false, status: 413 } as Response)
      .mockResolvedValue({ ok: true, status: 200 } as Response) // the error report
    await expect(settle(uploadPdfToStaging(pdf(2000)))).rejects.toThrow(/25 MB/)
    expect(fetchMock.mock.calls.some(c => c[0] === '/api/system-errors/report')).toBe(true)
  })

  it('a network failure on the PUT is retried, then flagged as a network failure and reported', async () => {
    let puts = 0
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/esign/upload-url') return json({ signedUrl: 'https://s/u', path: 'p' })
      if (url === '/api/system-errors/report') return { ok: true, status: 200 } as Response
      puts++
      throw new TypeError('Failed to fetch')
    })
    const err = await settle(uploadPdfToStaging(pdf(2000))).catch(e => e)
    expect(err).toBeInstanceOf(EsignUploadError)
    expect(err.networkFailure).toBe(true)
    expect(puts).toBe(3) // 3 attempts
    expect(fetchMock.mock.calls.some(c => c[0] === '/api/system-errors/report')).toBe(true)
  })

  it('a network failure while asking for the link is also flagged, so the editor may fall back for small files', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/system-errors/report') return { ok: true, status: 200 } as Response
      throw new TypeError('Failed to fetch')
    })
    const err = await settle(uploadPdfToStaging(pdf(2000))).catch(e => e)
    expect(err).toBeInstanceOf(EsignUploadError)
    expect(err.networkFailure).toBe(true)
  })

  it('a completed bad answer is NOT flagged as a network failure (no silent fallback to a path that would fail)', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ signedUrl: 'https://s/u', path: 'p' }))
      .mockResolvedValueOnce({ ok: false, status: 500 } as Response)
      .mockResolvedValue({ ok: true, status: 200 } as Response)
    const err = await settle(uploadPdfToStaging(pdf(2000))).catch(e => e)
    expect(err).toBeInstanceOf(EsignUploadError)
    expect(err.networkFailure).toBe(false)
  })
})

describe('multipart fallback ceiling', () => {
  it('stays under the platform\'s 4.5 MB request cap', () => {
    expect(MULTIPART_FALLBACK_MAX_BYTES).toBeLessThan(4.5 * 1024 * 1024)
  })
})
