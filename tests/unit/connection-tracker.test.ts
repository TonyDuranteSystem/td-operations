import { describe, it, expect } from 'vitest'
import { ConnectionTracker, OFFLINE_BANNER_DELAY_MS } from '@/lib/hooks/connection-tracker'

function setup() {
  const calls: string[] = []
  let pending: { fn: () => void; id: number } | null = null
  let nextId = 1
  const timers = {
    set: (fn: () => void) => { pending = { fn, id: nextId++ }; return pending.id },
    clear: (h: unknown) => { if (pending && pending.id === h) pending = null },
  }
  const t = new ConnectionTracker({
    showOffline: () => calls.push('show'),
    hideOffline: () => calls.push('hide'),
    reconnected: () => calls.push('reconnected'),
  }, OFFLINE_BANNER_DELAY_MS, timers)
  return { t, calls, fire: () => { const p = pending; pending = null; p?.fn() }, hasTimer: () => pending !== null }
}

describe('ConnectionTracker', () => {
  it('a short drop shows no banner but still catches up on return', () => {
    const { t, calls, hasTimer } = setup()
    t.goOffline()
    t.goOnline()
    expect(calls).toEqual(['reconnected'])
    expect(hasTimer()).toBe(false)
  })
  it('a longer drop shows the banner, then hides it and catches up', () => {
    const { t, calls, fire } = setup()
    t.goOffline()
    fire()
    expect(calls).toEqual(['show'])
    t.goOnline()
    expect(calls).toEqual(['show', 'hide', 'reconnected'])
  })
  it('two offline events in a row count once', () => {
    const { t, calls, fire } = setup()
    t.goOffline(); t.goOffline()
    fire(); fire()
    expect(calls).toEqual(['show'])
  })
  it('online with no earlier offline does nothing', () => {
    const { t, calls } = setup()
    t.goOnline()
    expect(calls).toEqual([])
  })
  it('each separate outage is handled on its own', () => {
    const { t, calls, fire } = setup()
    t.goOffline(); fire(); t.goOnline()
    t.goOffline(); t.goOnline()
    expect(calls).toEqual(['show', 'hide', 'reconnected', 'reconnected'])
  })
  it('the banner delay is 3 seconds', () => {
    expect(OFFLINE_BANNER_DELAY_MS).toBe(3000)
  })
  it('dispose cancels a waiting banner', () => {
    const { t, calls, fire, hasTimer } = setup()
    t.goOffline()
    t.dispose()
    expect(hasTimer()).toBe(false)
    fire()
    expect(calls).toEqual([])
  })
})
