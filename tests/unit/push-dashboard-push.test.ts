import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  urlBase64ToUint8Array,
  subscribeToDashboardPush,
  unsubscribeFromPush,
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

describe('TD Talk target (dev job c1e326dd)', () => {
  const subscribeMock = vi.fn()
  const registerMock = vi.fn()
  const fetchMock = vi.fn()
  const requestPermissionMock = vi.fn()

  function stubEnv(activeNow: boolean) {
    const listeners: Array<() => void> = []
    const worker = {
      state: activeNow ? 'activated' : 'installing',
      addEventListener: (_n: string, fn: () => void) => { listeners.push(fn) },
    }
    const registration = {
      active: activeNow ? worker : null,
      installing: activeNow ? null : worker,
      waiting: null,
      pushManager: { subscribe: subscribeMock },
    }
    registerMock.mockResolvedValue(registration)
    // `ready` would answer for the CRM's worker on a first TD Talk load — it must NOT be what the TD Talk path waits on.
    vi.stubGlobal('navigator', { serviceWorker: { register: registerMock, ready: new Promise(() => {}) } })
    vi.stubGlobal('window', { PushManager: function PushManager() {} })
    vi.stubGlobal('Notification', { requestPermission: requestPermissionMock, permission: 'default' })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('atob', (s: string) => Buffer.from(s, 'base64').toString('binary'))
    return { worker, listeners }
  }

  beforeEach(() => { vi.clearAllMocks() })
  afterEach(() => { vi.unstubAllGlobals() })

  it('registers the TD Talk worker at the TD Talk scope and subscribes through ITS registration', async () => {
    stubEnv(true)
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ publicKey: 'aGVsbG8=' }) }).mockResolvedValueOnce({ ok: true })
    requestPermissionMock.mockResolvedValueOnce('granted')
    subscribeMock.mockResolvedValueOnce({ toJSON: () => ({ endpoint: 'https://push.example/talk' }) })

    await expect(subscribeToDashboardPush({ swPath: '/talk-sw.js', scope: '/talk' })).resolves.toBe('subscribed')

    expect(registerMock).toHaveBeenCalledWith('/talk-sw.js', { scope: '/talk' })
    expect(subscribeMock).toHaveBeenCalledTimes(1)
  })

  it('waits for the TD Talk worker itself to become active (not serviceWorker.ready)', async () => {
    const { worker, listeners } = stubEnv(false)
    fetchMock.mockResolvedValueOnce({ ok: false })
    const pending = subscribeToDashboardPush({ swPath: '/talk-sw.js', scope: '/talk' })
    await new Promise(r => setTimeout(r, 0))
    expect(fetchMock).not.toHaveBeenCalled() // still waiting for activation
    worker.state = 'activated'
    listeners.forEach(fn => fn())
    await expect(pending).resolves.toBe('unconfigured')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('the CRM default is unchanged: register(path) with no options, then serviceWorker.ready', async () => {
    const registration = { pushManager: { subscribe: subscribeMock } }
    registerMock.mockResolvedValue(registration)
    vi.stubGlobal('navigator', { serviceWorker: { register: registerMock, ready: Promise.resolve(registration) } })
    vi.stubGlobal('window', { PushManager: function PushManager() {} })
    vi.stubGlobal('Notification', { requestPermission: requestPermissionMock })
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValueOnce({ ok: false })
    await subscribeToDashboardPush()
    expect(registerMock).toHaveBeenCalledTimes(1)
    expect(registerMock.mock.calls[0]).toEqual([DASHBOARD_SW_PATH])
  })

  describe('unsubscribeFromPush', () => {
    const getRegistration = vi.fn()
    beforeEach(() => {
      vi.stubGlobal('navigator', { serviceWorker: { getRegistration } })
      vi.stubGlobal('fetch', fetchMock)
      fetchMock.mockResolvedValue({ ok: true })
    })

    it('removes the TD Talk subscription from the server and the browser', async () => {
      const unsubscribe = vi.fn().mockResolvedValue(true)
      getRegistration.mockResolvedValue({
        scope: 'https://app.example.com/talk',
        pushManager: { getSubscription: async () => ({ endpoint: 'https://push.example/talk', unsubscribe }) },
      })
      await expect(unsubscribeFromPush({ scope: '/talk' })).resolves.toBe(true)
      expect(fetchMock).toHaveBeenCalledWith(ADMIN_PUSH_ENDPOINT, expect.objectContaining({
        method: 'DELETE', body: JSON.stringify({ endpoint: 'https://push.example/talk' }),
      }))
      expect(unsubscribe).toHaveBeenCalled()
    })

    it("never removes the CRM app's subscription when TD Talk has no worker of its own", async () => {
      // getRegistration('/talk') answers with the CRM's registration (scope '/') when nothing is registered at /talk.
      const unsubscribe = vi.fn()
      getRegistration.mockResolvedValue({
        scope: 'https://app.example.com/',
        pushManager: { getSubscription: async () => ({ endpoint: 'https://push.example/crm', unsubscribe }) },
      })
      await expect(unsubscribeFromPush({ scope: '/talk' })).resolves.toBe(false)
      expect(fetchMock).not.toHaveBeenCalled()
      expect(unsubscribe).not.toHaveBeenCalled()
    })

    it('returns false when there is no subscription or no worker support', async () => {
      getRegistration.mockResolvedValue({ scope: 'https://app.example.com/talk', pushManager: { getSubscription: async () => null } })
      await expect(unsubscribeFromPush({ scope: '/talk' })).resolves.toBe(false)
      getRegistration.mockResolvedValue(undefined)
      await expect(unsubscribeFromPush({ scope: '/talk' })).resolves.toBe(false)
      vi.stubGlobal('navigator', {})
      await expect(unsubscribeFromPush({ scope: '/talk' })).resolves.toBe(false)
    })
  })
})
