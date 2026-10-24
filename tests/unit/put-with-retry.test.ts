import { describe, it, expect, vi } from 'vitest'
import { putFileWithRetry, putFailureMessage, isRetryableStatus } from '@/lib/storage/put-with-retry'

const file = new Blob(['hello'], { type: 'application/pdf' })
const ok = () => new Response(null, { status: 200 })
const status = (n: number) => new Response(null, { status: n })
const sleep = () => Promise.resolve()

function prep() {
  let n = 0
  return vi.fn(async () => { n++; return { signedUrl: `https://x/sign/${n}`, path: `crm-uploads/p${n}` } })
}

describe('isRetryableStatus', () => {
  it('retries server errors, timeouts and rate limits only', () => {
    for (const s of [500, 502, 503, 520, 522, 524, 408, 429]) expect(isRetryableStatus(s)).toBe(true)
    for (const s of [400, 401, 403, 404, 409, 413, 415]) expect(isRetryableStatus(s)).toBe(false)
  })
})

describe('putFileWithRetry', () => {
  it('succeeds first time with one attempt and returns the path it used', async () => {
    const prepare = prep()
    const f = vi.fn(async () => ok())
    const r = await putFileWithRetry({ prepare, file, fetchImpl: f as never, sleep })
    expect(r).toMatchObject({ ok: true, path: 'crm-uploads/p1', attempts: 1, message: '' })
    expect(prepare).toHaveBeenCalledTimes(1)
  })

  it('retries a 520 and succeeds, asking for a FRESH link and path each time', async () => {
    const prepare = prep()
    const f = vi.fn().mockResolvedValueOnce(status(520)).mockResolvedValueOnce(ok())
    const r = await putFileWithRetry({ prepare, file, fetchImpl: f as never, sleep })
    expect(r).toMatchObject({ ok: true, path: 'crm-uploads/p2', attempts: 2 })
    expect(prepare).toHaveBeenCalledTimes(2)
    expect(f.mock.calls[0][0]).toBe('https://x/sign/1')
    expect(f.mock.calls[1][0]).toBe('https://x/sign/2')
  })

  it('retries when the network fails (fetch throws a TypeError)', async () => {
    const prepare = prep()
    const f = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(ok())
    const r = await putFileWithRetry({ prepare, file, fetchImpl: f as never, sleep })
    expect(r.ok).toBe(true)
    expect(r.attempts).toBe(2)
  })

  it('gives up after 3 tries with the real status in the message', async () => {
    const f = vi.fn(async () => status(520))
    const r = await putFileWithRetry({ prepare: prep(), file, fetchImpl: f as never, sleep })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.status).toBe(520)
      expect(r.attempts).toBe(3)
      expect(r.message).toContain('status 520')
      expect(r.message).toContain('3 tries')
    }
    expect(f).toHaveBeenCalledTimes(3)
  })

  it('says "connection lost" when the network never came back', async () => {
    const f = vi.fn(async () => { throw new TypeError('Load failed') })
    const r = await putFileWithRetry({ prepare: prep(), file, fetchImpl: f as never, sleep })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.status).toBeNull()
      expect(r.message).toContain('connection lost')
    }
  })

  it('does NOT retry a refused file (4xx) — fails at once with the real status', async () => {
    const f = vi.fn(async () => status(413))
    const r = await putFileWithRetry({ prepare: prep(), file, fetchImpl: f as never, sleep })
    expect(r.ok).toBe(false)
    if (!r.ok) { expect(r.status).toBe(413); expect(r.attempts).toBe(1) }
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('retries when asking for the link fails on the network, but not when it is refused', async () => {
    let n = 0
    const prepare = vi.fn(async () => { n++; if (n === 1) throw new TypeError('Failed to fetch'); return { signedUrl: 'https://x/ok', path: 'p' } })
    const r = await putFileWithRetry({ prepare, file, fetchImpl: (async () => ok()) as never, sleep })
    expect(r.ok).toBe(true)
    const refused = vi.fn(async () => { throw new Error('Could not prepare the upload.') })
    await expect(putFileWithRetry({ prepare: refused, file, fetchImpl: (async () => ok()) as never, sleep })).rejects.toThrow('Could not prepare')
    expect(refused).toHaveBeenCalledTimes(1)
  })

  it('waits between tries and tells the caller', async () => {
    const waits: number[] = []
    const seen: Array<{ attempt: number; of: number; status: number | null }> = []
    const f = vi.fn().mockResolvedValueOnce(status(503)).mockResolvedValueOnce(status(503)).mockResolvedValueOnce(ok())
    const r = await putFileWithRetry({ prepare: prep(), file, fetchImpl: f as never, sleep: async (ms) => { waits.push(ms) }, onRetry: (i) => seen.push(i) })
    expect(r.ok).toBe(true)
    expect(waits).toEqual([1500, 4000])
    expect(seen).toEqual([{ attempt: 1, of: 3, status: 503 }, { attempt: 2, of: 3, status: 503 }])
  })

  it('sends the content type of the file', async () => {
    const f = vi.fn(async () => ok())
    await putFileWithRetry({ prepare: prep(), file, fetchImpl: f as never, sleep })
    expect((f.mock.calls[0] as unknown as [string, { headers: Record<string, string> }])[1].headers['Content-Type']).toBe('application/pdf')
  })
})

describe('putFailureMessage', () => {
  it('names the status and the number of tries', () => {
    expect(putFailureMessage(520, 3)).toBe('The file could not be sent (status 520) after 3 tries — please try again.')
    expect(putFailureMessage(500, 1)).toBe('The file could not be sent (status 500) — please try again.')
  })
})
