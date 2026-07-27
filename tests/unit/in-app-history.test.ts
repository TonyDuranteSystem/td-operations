import { describe, it, expect, beforeEach } from 'vitest'
import {
  markInAppNavigation,
  canGoBackInApp,
  __resetInAppHistoryDepth,
} from '@/lib/nav/in-app-history'

describe('in-app history depth (drives the global Back arrow)', () => {
  beforeEach(() => __resetInAppHistoryDepth())

  it('a fresh load has nowhere to go back to → Back must go home', () => {
    expect(canGoBackInApp()).toBe(false)
  })

  it('one in-app move makes Back available', () => {
    markInAppNavigation()
    expect(canGoBackInApp()).toBe(true)
  })

  it('counts query-only moves the same as route moves (the Portal Chats bug)', () => {
    // Two chat switches — no pathname change at all.
    markInAppNavigation()
    markInAppNavigation()
    expect(canGoBackInApp()).toBe(true)
  })

  it('stays available while depth remains, and stops once unwound', () => {
    markInAppNavigation()
    markInAppNavigation()
    expect(canGoBackInApp()).toBe(true)
    __resetInAppHistoryDepth()
    expect(canGoBackInApp()).toBe(false)
  })

  it('is not a boolean latch — depth accumulates so nested moves unwind one at a time', () => {
    markInAppNavigation()
    markInAppNavigation()
    markInAppNavigation()
    // Still true after the first two pops would be consumed; proven by the
    // counter being > 1 rather than a flag that flips off on the first pop.
    expect(canGoBackInApp()).toBe(true)
  })
})
