import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { postToApp, type NativeBridgeHost } from '@/lib/portal-app/native-bridge'

// The portal page talks to the client app through one helper that knows both doors: the iPhone's and the Android app's.
// (dev job 2c751252, Android Step 1: before this, the Menu button and the company choice only reached an iPhone.)

describe('postToApp', () => {
  it('sends to the iPhone door and says so', () => {
    const iphone = vi.fn()
    const host: NativeBridgeHost = { webkit: { messageHandlers: { tdclient: { postMessage: iphone } } } }
    expect(postToApp('menu', host)).toBe(true)
    expect(iphone).toHaveBeenCalledExactlyOnceWith('menu')
  })

  it('sends to the Android door when there is no iPhone door', () => {
    const android = vi.fn()
    const host: NativeBridgeHost = { tdclientAndroid: { postMessage: android } }
    expect(postToApp('selection:account=abc', host)).toBe(true)
    expect(android).toHaveBeenCalledExactlyOnceWith('selection:account=abc')
  })

  it('uses the iPhone door only when both exist (a message is never delivered twice)', () => {
    const iphone = vi.fn()
    const android = vi.fn()
    const host: NativeBridgeHost = { webkit: { messageHandlers: { tdclient: { postMessage: iphone } } }, tdclientAndroid: { postMessage: android } }
    expect(postToApp('menu', host)).toBe(true)
    expect(iphone).toHaveBeenCalledTimes(1)
    expect(android).not.toHaveBeenCalled()
  })

  it('returns false in a plain browser (no app, no door) and never throws', () => {
    expect(postToApp('menu', {})).toBe(false)
    expect(postToApp('menu', { webkit: {} })).toBe(false)
    expect(postToApp('menu', { webkit: { messageHandlers: {} } })).toBe(false)
    expect(postToApp('menu', { tdclientAndroid: {} })).toBe(false)
  })

  it('returns false on the server (no window at all)', () => {
    expect(postToApp('menu')).toBe(false)
  })

  it('ignores a door whose postMessage is not a function and tries the next one', () => {
    const android = vi.fn()
    const host = { webkit: { messageHandlers: { tdclient: { postMessage: 'nope' } } }, tdclientAndroid: { postMessage: android } } as unknown as NativeBridgeHost
    expect(postToApp('menu', host)).toBe(true)
    expect(android).toHaveBeenCalledTimes(1)
  })

  it('keeps `this` (a web view door is an object with a method, never a loose function)', () => {
    const seen: string[] = []
    const door = {
      label: 'android-door',
      postMessage(message: string) { seen.push(`${this.label}:${message}`) },
    }
    expect(postToApp('menu', { tdclientAndroid: door as unknown as NativeBridgeHost['tdclientAndroid'] })).toBe(true)
    expect(seen).toEqual(['android-door:menu'])
  })

  it('a door that throws is the same as no door: false, and the page keeps working', () => {
    const host: NativeBridgeHost = { tdclientAndroid: { postMessage: () => { throw new Error('web view gone') } } }
    expect(() => postToApp('menu', host)).not.toThrow()
    expect(postToApp('menu', host)).toBe(false)
  })
})

describe('the app frame uses the helper', () => {
  const src = readFileSync(join(process.cwd(), 'components/portal/client-app-frame.tsx'), 'utf8')

  it('sends the Menu tap and the company choice through postToApp, never straight to webkit', () => {
    expect(src).toContain("import { postToApp } from '@/lib/portal-app/native-bridge'")
    expect(src).toContain("postToApp('menu')")
    expect(src).toMatch(/postToApp\(`selection:\$\{selectionQuery\}`\)/)
    expect(src).not.toContain('webkit')
    expect(src).not.toContain('messageHandlers')
  })
})
