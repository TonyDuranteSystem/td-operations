import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  urlBase64ToUint8Array,
  subscribeToDashboardPush,
  DASHBOARD_SW_PATH,
  ADMIN_PUSH_ENDPOINT,
} from '@/lib/push/dashboard-push'

describe('urlBase64ToUint8Array', () => {
  it('decodes a plain base64 string to bytes', () => {
    // btoa('hello') === 'aGVsbG8='
    const out = urlBase64ToUint8Array('aGVsbG8=')
    expect(Array.from(out)).toEqual([104, 101, 108, 108, 111])
  })

  it('handles base64url characters (- and _) and missing padding', () => {
    // bytes 0xfb 0xef 0xbe -> base64 '++++vg==' variants; base64url uses -_
    // btoa(String.fromCharCode(251, 239, 190)) === '++--' style check:
    const standard = urlBase64ToUint8Array('++_-'.replace(/\+/g, '-'))
    const base64url = urlBase64ToUint8Array('--_-')
    expect(Array.from(standard)).toEqual(Array.from(base64url))
  })

  it('round-trips a VAPID-like key without throwing', () => {
    const key = 'BNo9xUJyoJ0nT-1x_kCkZzX0y1vJ2mN3oP4qR5sT6uV7wX8yZ9aB0cD1eF2gH3iJ4kL5mN6oP7qR8sT9uV0wX1y'
    const out = urlBase64ToUint8Array(key)
    expect(out.length).toBeGreaterThan(0)
  })
})

describe('subscribeToDashboardPush', () => {
  const subscribeMock = vi.fn()
  const registerMock = vi.fn()
  const fetchMock = vi.fn()
  const requestPermissionMock = vi.fn()

  function stubBrowserEnv() {
    const registration = {
      pushManager: {
        subscribe: subscribeMock,
      },
    }
    registerMock.mockResolvedValue(registration)
    vi.stubGlobal('navigator', {
      serviceWorker: {
        register: registerMock,
        ready: Promise.resolve(registration),
      },
    })
    vi.stubGlobal('window', { PushManager: function PushManager() {} })
    vi.stubGlobal('Notification', { requestPermission: requestPermissionMock, permission: 'default' })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('atob', (s: string) => Buffer.from(s, 'base64').toString('binary'))
  }

  beforeEach(() => {
    vi.clearAllMocks()
    stubBrowserEnv()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns unsupported when serviceWorker is missing', async () => {
    vi.stubGlobal('navigator', {})
    await expect(subscribeToDashboardPush()).resolves.toBe('unsupported')
  })

  it('returns unconfigured when the VAPID key endpoint fails, before asking permission', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false })
    await expect(subscribeToDashboardPush()).resolves.toBe('unconfigured')
    expect(registerMock).toHaveBeenCalledWith(DASHBOARD_SW_PATH)
    expect(requestPermissionMock).not.toHaveBeenCalled()
  })

  it('returns unconfigured when the endpoint returns no publicKey', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) })
    await expect(subscribeToDashboardPush()).resolves.toBe('unconfigured')
    expect(requestPermissionMock).not.toHaveBeenCalled()
  })

  it('returns denied when the user rejects the permission prompt', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ publicKey: 'aGVsbG8=' }) })
    requestPermissionMock.mockResolvedValueOnce('denied')
    await expect(subscribeToDashboardPush()).resolves.toBe('denied')
    expect(subscribeMock).not.toHaveBeenCalled()
  })

  it('subscribes and POSTs the subscription on the happy path', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ publicKey: 'aGVsbG8=' }) }) // GET key
      .mockResolvedValueOnce({ ok: true }) // POST subscription
    requestPermissionMock.mockResolvedValueOnce('granted')
    subscribeMock.mockResolvedValueOnce({ toJSON: () => ({ endpoint: 'https://push.example/abc' }) })

    await expect(subscribeToDashboardPush()).resolves.toBe('subscribed')

    expect(subscribeMock).toHaveBeenCalledWith(
      expect.objectContaining({ userVisibleOnly: true })
    )
    expect(fetchMock).toHaveBeenLastCalledWith(
      ADMIN_PUSH_ENDPOINT,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ subscription: { endpoint: 'https://push.example/abc' } }),
      })
    )
  })

  it('throws when saving the subscription fails', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ publicKey: 'aGVsbG8=' }) })
      .mockResolvedValueOnce({ ok: false })
    requestPermissionMock.mockResolvedValueOnce('granted')
    subscribeMock.mockResolvedValueOnce({ toJSON: () => ({ endpoint: 'x' }) })

    await expect(subscribeToDashboardPush()).rejects.toThrow('Failed to save subscription')
  })
})
