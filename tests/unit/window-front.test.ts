/**
 * The READ RULE's "is the window in front" check must FAIL OPEN (dev job c1e326dd): hasFocus() lies on phones/installed
 * apps, which left chats unread forever. In front unless a real blur happened; any interaction brings it back.
 */
import { describe, it, expect, beforeAll } from 'vitest'

// Tests run in node (no jsdom here): a tiny fake window/document is enough for the listeners.
const fakeWindow = new EventTarget()
const fakeDocument = { visibilityState: 'visible' as string, hasFocus: () => false }
Object.assign(globalThis, { window: fakeWindow, document: fakeDocument })
const fire = (t: string) => fakeWindow.dispatchEvent(new Event(t))

describe('window-front', () => {
  let isBeingViewed: () => boolean, isWindowInFront: () => boolean
  beforeAll(async () => { ({ isBeingViewed, isWindowInFront } = await import('@/lib/talk/window-front')); isWindowInFront() }) // installs the listeners
  it('is in front by default, even when document.hasFocus() says no', () => {
        expect(isWindowInFront()).toBe(true)
    expect(isBeingViewed()).toBe(true)
  })
  it('is not in front after the window loses focus, and is again after a tap / key / focus', () => {
    fire('blur')
    expect(isWindowInFront()).toBe(false)
    expect(isBeingViewed()).toBe(false)
    fire('pointerdown')
    expect(isWindowInFront()).toBe(true)
    fire('blur')
    fire('keydown')
    expect(isWindowInFront()).toBe(true)
    fire('blur')
    fire('focus')
    expect(isWindowInFront()).toBe(true)
  })
  it('a hidden tab is never being viewed', () => {
    fakeDocument.visibilityState = 'hidden'
    expect(isBeingViewed()).toBe(false)
    fakeDocument.visibilityState = 'visible'
    expect(isBeingViewed()).toBe(true)
  })
})
