/**
 * /api/cron/release-ended-suites — daily sweep. Bearer CRON_SECRET (a missing secret refuses); reports how many suites
 * went back to the pool; an error is logged and returned, never swallowed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }))
const logCron = vi.fn()
vi.mock('@/lib/cron-log', () => ({ logCron: (...a: unknown[]) => logCron(...a) }))
const releaseEndedSuites = vi.fn()
vi.mock('@/lib/operations/suite', () => ({ releaseEndedSuites: (...a: unknown[]) => releaseEndedSuites(...a) }))

import { GET } from '@/app/api/cron/release-ended-suites/route'

function req(auth?: string) {
  return new Request('http://localhost/api/cron/release-ended-suites', {
    headers: auth ? { authorization: auth } : {},
  }) as unknown as import('next/server').NextRequest
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.CRON_SECRET = 'secret-123'
  releaseEndedSuites.mockResolvedValue(2)
})

describe('release-ended-suites cron', () => {
  it('refuses without the secret — and does nothing', async () => {
    const res = await GET(req())
    expect(res.status).toBe(401)
    expect(releaseEndedSuites).not.toHaveBeenCalled()
  })
  it('refuses a wrong secret', async () => {
    const res = await GET(req('Bearer nope'))
    expect(res.status).toBe(401)
    expect(releaseEndedSuites).not.toHaveBeenCalled()
  })
  it('refuses when CRON_SECRET is not configured (never fails open)', async () => {
    delete process.env.CRON_SECRET
    const res = await GET(req('Bearer undefined'))
    expect(res.status).toBe(401)
    expect(releaseEndedSuites).not.toHaveBeenCalled()
  })
  it('releases and reports the count', async () => {
    const res = await GET(req('Bearer secret-123'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, released: 2 })
    expect(logCron).toHaveBeenCalledWith(expect.objectContaining({ endpoint: 'release-ended-suites', status: 'success', details: { released: 2 } }))
  })
  it('an error is logged and returned as a 500', async () => {
    releaseEndedSuites.mockRejectedValue(new Error('boom'))
    const res = await GET(req('Bearer secret-123'))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('boom')
    expect(logCron).toHaveBeenCalledWith(expect.objectContaining({ status: 'error', error_message: 'boom' }))
  })
})
