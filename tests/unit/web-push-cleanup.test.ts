/**
 * Tests for lib/portal/web-push.ts dead-subscription cleanup matrix
 * and error-logging behavior.
 *
 * Verifies:
 *  - 410/404 (existing behavior) still delete the row.
 *  - 400/401/403 (new behavior) also delete the row.
 *  - 408/429 (transient) do NOT delete the row.
 *  - 5xx errors do NOT delete the row.
 *  - Per-failure console.error fires with statusCode + endpoint context.
 *  - Summary log fires only when failed > 0.
 *  - sent/failed counters are correct.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ─── Hoisted mocks ───────────────────────────────────────────────

const {
  mockSendNotification,
  mockSetVapidDetails,
  capturedDeletes,
} = vi.hoisted(() => {
  const capturedDeletes: { table: string; id: string }[] = []
  return {
    mockSendNotification: vi.fn(),
    mockSetVapidDetails: vi.fn(),
    capturedDeletes,
  }
})

vi.mock('web-push', () => ({
  default: {
    setVapidDetails: mockSetVapidDetails,
    sendNotification: mockSendNotification,
  },
}))

vi.mock('@/lib/supabase-admin', () => {
  return {
    supabaseAdmin: {
      from: vi.fn((table: string) => {
        const subs = (globalThis as unknown as { __testSubs: typeof currentSubs }).__testSubs || []
        const selectBuilder = {
          eq: vi.fn(() => Promise.resolve({ data: subs, error: null })),
          neq: vi.fn(() => Promise.resolve({ data: subs, error: null })),
          // Make the bare select awaitable: builder.then() resolves with subs.
          then: (resolve: (v: { data: typeof subs; error: null }) => void) =>
            resolve({ data: subs, error: null }),
        }
        return {
          select: vi.fn(() => selectBuilder),
          delete: vi.fn(() => ({
            eq: vi.fn((_col: string, id: string) => {
              capturedDeletes.push({ table, id })
              return Promise.resolve({ data: null, error: null })
            }),
          })),
        }
      }),
    },
  }
})

// Track the subscriptions injected for each test.
let currentSubs: { id: string; endpoint: string; p256dh: string; auth_key: string }[] = []

function setSubs(subs: typeof currentSubs) {
  currentSubs = subs
  ;(globalThis as unknown as { __testSubs: typeof currentSubs }).__testSubs = subs
}

// ─── Tests ───────────────────────────────────────────────────────

describe('web-push cleanup matrix', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    capturedDeletes.length = 0
    process.env.VAPID_PUBLIC_KEY = 'pub'
    process.env.VAPID_PRIVATE_KEY = 'priv'
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleErrorSpy.mockRestore()
  })

  function makeStatusError(statusCode: number, body = 'error') {
    return Object.assign(new Error(`Push failed: ${statusCode}`), { statusCode, body })
  }

  it('deletes subscription on 410 Gone', async () => {
    setSubs([{ id: 'sub-410', endpoint: 'https://fcm.example/410', p256dh: 'p', auth_key: 'a' }])
    mockSendNotification.mockRejectedValueOnce(makeStatusError(410))

    const { sendPushToAdmin } = await import('@/lib/portal/web-push')
    const result = await sendPushToAdmin({ title: 't', body: 'b' })

    expect(result).toEqual({ sent: 0, failed: 1 })
    expect(capturedDeletes).toEqual([{ table: 'admin_push_subscriptions', id: 'sub-410' }])
  })

  it('deletes subscription on 404 Not Found', async () => {
    setSubs([{ id: 'sub-404', endpoint: 'https://fcm.example/404', p256dh: 'p', auth_key: 'a' }])
    mockSendNotification.mockRejectedValueOnce(makeStatusError(404))

    const { sendPushToAdmin } = await import('@/lib/portal/web-push')
    await sendPushToAdmin({ title: 't', body: 'b' })

    expect(capturedDeletes).toEqual([{ table: 'admin_push_subscriptions', id: 'sub-404' }])
  })

  it('deletes subscription on 401, 403, 400 (new behavior)', async () => {
    setSubs([
      { id: 'sub-401', endpoint: 'https://fcm.example/401', p256dh: 'p', auth_key: 'a' },
      { id: 'sub-403', endpoint: 'https://fcm.example/403', p256dh: 'p', auth_key: 'a' },
      { id: 'sub-400', endpoint: 'https://fcm.example/400', p256dh: 'p', auth_key: 'a' },
    ])
    mockSendNotification
      .mockRejectedValueOnce(makeStatusError(401))
      .mockRejectedValueOnce(makeStatusError(403))
      .mockRejectedValueOnce(makeStatusError(400))

    const { sendPushToAdmin } = await import('@/lib/portal/web-push')
    const result = await sendPushToAdmin({ title: 't', body: 'b' })

    expect(result).toEqual({ sent: 0, failed: 3 })
    expect(capturedDeletes.map((d) => d.id).sort()).toEqual(['sub-400', 'sub-401', 'sub-403'])
  })

  it('does NOT delete subscription on transient 408 / 429', async () => {
    setSubs([
      { id: 'sub-408', endpoint: 'https://fcm.example/408', p256dh: 'p', auth_key: 'a' },
      { id: 'sub-429', endpoint: 'https://fcm.example/429', p256dh: 'p', auth_key: 'a' },
    ])
    mockSendNotification
      .mockRejectedValueOnce(makeStatusError(408))
      .mockRejectedValueOnce(makeStatusError(429))

    const { sendPushToAdmin } = await import('@/lib/portal/web-push')
    const result = await sendPushToAdmin({ title: 't', body: 'b' })

    expect(result).toEqual({ sent: 0, failed: 2 })
    expect(capturedDeletes).toEqual([])
  })

  it('does NOT delete subscription on 5xx server errors', async () => {
    setSubs([
      { id: 'sub-500', endpoint: 'https://fcm.example/500', p256dh: 'p', auth_key: 'a' },
      { id: 'sub-503', endpoint: 'https://fcm.example/503', p256dh: 'p', auth_key: 'a' },
    ])
    mockSendNotification
      .mockRejectedValueOnce(makeStatusError(500))
      .mockRejectedValueOnce(makeStatusError(503))

    const { sendPushToAdmin } = await import('@/lib/portal/web-push')
    await sendPushToAdmin({ title: 't', body: 'b' })

    expect(capturedDeletes).toEqual([])
  })

  it('counts mixed success and failure correctly', async () => {
    setSubs([
      { id: 'ok-1', endpoint: 'https://fcm.example/ok1', p256dh: 'p', auth_key: 'a' },
      { id: 'dead', endpoint: 'https://fcm.example/dead', p256dh: 'p', auth_key: 'a' },
      { id: 'ok-2', endpoint: 'https://fcm.example/ok2', p256dh: 'p', auth_key: 'a' },
    ])
    mockSendNotification
      .mockResolvedValueOnce({ statusCode: 201 })
      .mockRejectedValueOnce(makeStatusError(410))
      .mockResolvedValueOnce({ statusCode: 201 })

    const { sendPushToAdmin } = await import('@/lib/portal/web-push')
    const result = await sendPushToAdmin({ title: 't', body: 'b' })

    expect(result).toEqual({ sent: 2, failed: 1 })
    expect(capturedDeletes).toEqual([{ table: 'admin_push_subscriptions', id: 'dead' }])
  })

  it('logs per-failure console.error with statusCode and endpoint context', async () => {
    setSubs([{ id: 'sub-x', endpoint: 'https://fcm.example/x', p256dh: 'p', auth_key: 'a' }])
    mockSendNotification.mockRejectedValueOnce(makeStatusError(410))

    const { sendPushToAdmin } = await import('@/lib/portal/web-push')
    await sendPushToAdmin({ title: 't', body: 'b' })

    const failureCall = consoleErrorSpy.mock.calls.find(
      (c) => c[0] === '[web-push] send failed',
    )
    expect(failureCall).toBeDefined()
    const meta = failureCall?.[1] as { statusCode?: number; endpoint?: string; context?: string }
    expect(meta?.statusCode).toBe(410)
    expect(meta?.endpoint).toContain('fcm.example/x')
    expect(meta?.context).toBe('admin')
  })

  it('logs a summary line only when failed > 0', async () => {
    setSubs([
      { id: 'a', endpoint: 'https://fcm.example/a', p256dh: 'p', auth_key: 'a' },
      { id: 'b', endpoint: 'https://fcm.example/b', p256dh: 'p', auth_key: 'a' },
    ])
    mockSendNotification
      .mockResolvedValueOnce({ statusCode: 201 })
      .mockResolvedValueOnce({ statusCode: 201 })

    const { sendPushToAdmin } = await import('@/lib/portal/web-push')
    await sendPushToAdmin({ title: 't', body: 'b' })

    const summary = consoleErrorSpy.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('sent') && c[0].includes('failed'),
    )
    expect(summary).toBeUndefined()
  })

  it('logs summary line with sent/failed/total when failures occur', async () => {
    setSubs([
      { id: 'a', endpoint: 'https://fcm.example/a', p256dh: 'p', auth_key: 'a' },
      { id: 'b', endpoint: 'https://fcm.example/b', p256dh: 'p', auth_key: 'a' },
      { id: 'c', endpoint: 'https://fcm.example/c', p256dh: 'p', auth_key: 'a' },
    ])
    mockSendNotification
      .mockResolvedValueOnce({ statusCode: 201 })
      .mockRejectedValueOnce(makeStatusError(410))
      .mockRejectedValueOnce(makeStatusError(500))

    const { sendPushToAdmin } = await import('@/lib/portal/web-push')
    await sendPushToAdmin({ title: 't', body: 'b' })

    const summary = consoleErrorSpy.mock.calls.find(
      (c) =>
        typeof c[0] === 'string' &&
        c[0].includes('admin:') &&
        c[0].includes('1 sent') &&
        c[0].includes('2 failed'),
    )
    expect(summary).toBeDefined()
  })

  it('returns {sent:0, failed:0} when there are no subscriptions', async () => {
    setSubs([])

    const { sendPushToAdmin } = await import('@/lib/portal/web-push')
    const result = await sendPushToAdmin({ title: 't', body: 'b' })

    expect(result).toEqual({ sent: 0, failed: 0 })
    expect(mockSendNotification).not.toHaveBeenCalled()
  })

  it('returns {sent:0, failed:0} when VAPID keys are not configured', async () => {
    delete process.env.VAPID_PUBLIC_KEY
    delete process.env.VAPID_PRIVATE_KEY

    const { sendPushToAdmin } = await import('@/lib/portal/web-push')
    const result = await sendPushToAdmin({ title: 't', body: 'b' })

    expect(result).toEqual({ sent: 0, failed: 0 })
    expect(mockSendNotification).not.toHaveBeenCalled()
  })
})
